'use strict';
/**
 * DICOM SCP RIS: Verification (C-ECHO), Modality Worklist (C-FIND), MPPS (N-CREATE / N-SET).
 * Alat radiologi (CR/DX/CT/MR/US/...) dikonfigurasi dengan:
 *   Worklist SCP  : AE = DICOM_AE_TITLE, IP server RIS, port = DICOM_PORT
 *   MPPS SCP      : sama dengan di atas
 */
const dimse = require('dcmjs-dimse');
const config = require('../config');
const db = require('../lib/db');
const log = require('../lib/logger')('dicom');
const wl = require('./worklist');
const mpps = require('../services/mppsService');
const { generateUid } = require('../lib/util');
const fs = require('fs');
const path = require('path');

/** Rekam query & jawaban MWL ke DICOM_DUMP_DIR untuk diagnosa alat (mis. alat menolak data). */
function dumpFind(calling, ip, request, items) {
  if (!config.dicom.dumpDir) return;
  try {
    const dir = path.resolve(__dirname, '..', '..', config.dicom.dumpDir);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = path.join(dir, `${stamp}_${String(calling).replace(/[^A-Za-z0-9_-]/g, '_')}`);
    const req = request.getDataset();
    fs.writeFileSync(base + '.json', JSON.stringify({ time: new Date().toString(), calling, ip, query: req ? req.getElements() : null, responses: items }, null, 2));
    if (req) req.toFile(base + '_query.dcm', () => {});
    items.forEach((it, i) => new Dataset(it).toFile(`${base}_rsp${i + 1}.dcm`, () => {}));
    // simpan maksimal ~300 file terbaru
    const files = fs.readdirSync(dir).sort();
    for (const f of files.slice(0, Math.max(0, files.length - 300))) fs.unlinkSync(path.join(dir, f));
  } catch (e) { log.warn('Gagal merekam dump MWL', e); }
}

const { Scp, Server, Dataset } = dimse;
dimse.log.setLevel(process.env.DICOM_LOG_LEVEL || 'warn'); // log internal dcmjs-dimse
const { CEchoResponse, CFindResponse, NCreateResponse, NSetResponse } = dimse.responses;
const { Status, PresentationContextResult, SopClass, TransferSyntax, RejectResult, RejectSource, RejectReason } = dimse.constants;
const badLogged = new Set(); // order bermasalah dicatat sekali saja di log

const ACCEPTED = new Set([SopClass.Verification, SopClass.ModalityWorklistInformationModelFind, SopClass.ModalityPerformedProcedureStep]);
const TS = new Set([TransferSyntax.ImplicitVRLittleEndian, TransferSyntax.ExplicitVRLittleEndian]);

// Cache master modalitas (AE Title -> baris), diperbarui berkala
let stations = new Map();
async function refreshStations() {
  try {
    const rows = await db.risQuery('SELECT * FROM ris_modalities WHERE active=1');
    // kunci huruf besar: AE dicocokkan tanpa peduli besar/kecil (mis. Philips "Eleva")
    stations = new Map(rows.map((r) => [String(r.ae_title).trim().toUpperCase(), r]));
  } catch (e) { log.warn('Gagal memuat master modalitas', e); }
}

const stats = { associations: 0, echoes: 0, finds: 0, mppsCreate: 0, mppsSet: 0, rejected: 0, lastPeer: null };

function dlog(op, ae, ip, detail, results, status) {
  db.risQuery('INSERT INTO ris_dicom_log (op, calling_ae, peer_ip, detail, results, status) VALUES (?,?,?,?,?,?)', [
    op, ae, ip, detail ? String(detail).slice(0, 4000) : null, results ?? null, status,
  ]).catch(() => {});
}

class RisScp extends Scp {
  constructor(socket, opts) {
    super(socket, opts);
    this.association = undefined;
    this.peerIp = socket && socket.remoteAddress ? socket.remoteAddress.replace('::ffff:', '') : null;
  }

  associationRequested(association) {
    this.association = association;
    const calling = association.getCallingAeTitle();
    const called = association.getCalledAeTitle();
    stats.associations++;
    stats.lastPeer = `${calling}@${this.peerIp}`;

    if (!stations.has(String(calling).trim().toUpperCase()) && !config.dicom.acceptUnknownAe) {
      stats.rejected++;
      log.warn(`Asosiasi ditolak: AE ${calling} (${this.peerIp}) belum terdaftar di master modalitas`);
      dlog('ASSOC-REJECT', calling, this.peerIp, `AE tidak terdaftar; called=${called}`, null, 'REJECTED');
      this.sendAssociationReject(RejectResult.Permanent, RejectSource.ServiceUser, RejectReason.CallingAeNotRecognized);
      return;
    }
    if (called !== config.dicom.aeTitle) log.warn(`AE ${calling} memanggil "${called}", seharusnya "${config.dicom.aeTitle}" (tetap diterima)`);

    for (const c of association.getPresentationContexts()) {
      const ctx = association.getPresentationContext(c.id);
      if (!ACCEPTED.has(ctx.getAbstractSyntaxUid())) {
        ctx.setResult(PresentationContextResult.RejectAbstractSyntaxNotSupported);
        continue;
      }
      const ts = ctx.getTransferSyntaxUids().find((t) => TS.has(t));
      if (ts) ctx.setResult(PresentationContextResult.Accept, ts);
      else ctx.setResult(PresentationContextResult.RejectTransferSyntaxesNotSupported);
    }
    this.sendAssociationAccept();
  }

  cEchoRequest(request, callback) {
    stats.echoes++;
    dlog('C-ECHO', this.association.getCallingAeTitle(), this.peerIp, null, null, 'OK');
    const res = CEchoResponse.fromRequest(request);
    res.setStatus(Status.Success);
    callback(res);
  }

  cFindRequest(request, callback) {
    const calling = this.association.getCallingAeTitle();
    stats.finds++;
    const ds = request.getDataset() ? request.getDataset().getElements() : {};
    const query = wl.extractQuery(ds);
    log.debug('MWL query ' + JSON.stringify(ds));
    wl.findOrders(query, stations.get(String(calling).trim().toUpperCase()), stations)
      .then((rows) => {
        const responses = [];
        const skipped = [];
        const sent = []; // accession yang dikirim ke alat, dicatat di log
        const dumped = [];
        for (const o of rows) {
          // Satu order dengan data rusak dilewati (dicatat), worklist lain tetap terkirim normal
          try {
            const r = CFindResponse.fromRequest(request);
            const item = wl.project(ds, wl.buildItem(o, { callingAe: calling }));
            r.setDataset(new Dataset(item));
            dumped.push(item);
            r.setStatus(Status.Pending);
            responses.push(r);
            sent.push(`${o.dicom_accession || o.accession_number} ${o.patient_name}`.slice(0, 60));
          } catch (e) {
            skipped.push(`${o.accession_number}: ${e.message}`);
            if (!badLogged.has(o.id)) { badLogged.add(o.id); log.warn(`Order ${o.accession_number} dilewati dari worklist: ${e.message}`); }
          }
        }
        const done = CFindResponse.fromRequest(request);
        done.setStatus(Status.Success);
        responses.push(done);
        log.info(`C-FIND MWL dari ${calling}: ${responses.length - 1} item${skipped.length ? `, ${skipped.length} dilewati (data tidak valid)` : ''}`);
        dlog('C-FIND', calling, this.peerIp, JSON.stringify(query) + (sent.length ? ` | DIKIRIM: ${sent.join('; ')}` : '') + (skipped.length ? ` | DILEWATI: ${skipped.join('; ')}` : ''), responses.length - 1, skipped.length ? 'WARN' : 'OK');
        dumpFind(calling, this.peerIp, request, dumped);
        callback(responses);
      })
      .catch((e) => {
        log.error('C-FIND gagal', e);
        dlog('C-FIND', calling, this.peerIp, e.message, 0, 'ERROR');
        const r = CFindResponse.fromRequest(request);
        r.setStatus(Status.ProcessingFailure);
        callback([r]);
      });
  }

  nCreateRequest(request, callback) {
    const calling = this.association.getCallingAeTitle();
    stats.mppsCreate++;
    const uid = request.getAffectedSopInstanceUid() || generateUid();
    const ds = request.getDataset() ? request.getDataset().getElements() : {};
    mpps.onCreate(uid, ds, calling)
      .then((r) => {
        dlog('N-CREATE', calling, this.peerIp, `${uid} matched=${r.matched}`, null, 'OK');
        const res = NCreateResponse.fromRequest(request);
        if (res.setAffectedSopInstanceUid) res.setAffectedSopInstanceUid(uid);
        res.setStatus(Status.Success);
        callback(res);
      })
      .catch((e) => {
        log.error('MPPS N-CREATE gagal', e);
        dlog('N-CREATE', calling, this.peerIp, e.message, null, 'ERROR');
        const res = NCreateResponse.fromRequest(request);
        res.setStatus(Status.ProcessingFailure);
        callback(res);
      });
  }

  nSetRequest(request, callback) {
    const calling = this.association.getCallingAeTitle();
    stats.mppsSet++;
    const uid = request.getRequestedSopInstanceUid();
    const ds = request.getDataset() ? request.getDataset().getElements() : {};
    mpps.onSet(uid, ds, calling)
      .then((r) => {
        dlog('N-SET', calling, this.peerIp, `${uid} ${r.status || ''} ${r.notFound ? 'NOT FOUND' : ''}`, null, r.notFound ? 'NOT_FOUND' : 'OK');
        const res = NSetResponse.fromRequest(request);
        res.setStatus(r.notFound ? Status.NoSuchObjectInstance : Status.Success);
        callback(res);
      })
      .catch((e) => {
        log.error('MPPS N-SET gagal', e);
        const res = NSetResponse.fromRequest(request);
        res.setStatus(Status.ProcessingFailure);
        callback(res);
      });
  }

  associationReleaseRequested() {
    this.sendAssociationReleaseResponse();
  }

  // C-FIND dibatalkan oleh alat: respons sudah dikirim sekaligus, cukup diabaikan
  cCancelRequest() {}

  abort(source, reason) {
    log.debug(`A-ABORT dari ${this.association ? this.association.getCallingAeTitle() : '?'} (source ${source}, reason ${reason})`);
  }
}

let server = null;
let timer = null;
async function start() {
  await refreshStations();
  timer = setInterval(refreshStations, 30000);
  server = new Server(RisScp);
  server.on('networkError', (e) => log.warn('Network error', e));
  server.listen(config.dicom.port);
  log.info(`DICOM MWL/MPPS SCP aktif: AE=${config.dicom.aeTitle} port=${config.dicom.port}`);
}
function stop() { if (timer) clearInterval(timer); if (server) server.close(); }

module.exports = { start, stop, stats, refreshStations };
