'use strict';
/**
 * Antarmuka HL7 v2 (IHE SWF):
 *  OUT  ORM^O01  NW (order baru) / CA (batal) / XO (ubah)  -> PACS/broker/alat yang memakai HL7
 *  IN   ORU^R01  hasil bacaan dari PACS/reporting           -> ris_reports
 *  IN   ORM^O01  ORC-5=CM/IP (status dari PACS)              -> status order
 */
const config = require('../config');
const db = require('../lib/db');
const log = require('../lib/logger')('hl7');
const H = require('./hl7');
const mllp = require('./mllp');
const orders = require('../services/orderService');
const mapping = require('../services/mappingService');
const { nowLocal, toDicomName } = require('../lib/util');

const H7 = config.hl7;
const hl7Log = (row) =>
  db.risQuery(
    'INSERT INTO ris_hl7_log (direction, msg_type, control_id, peer, order_id, message, ack, status, error) VALUES (?,?,?,?,?,?,?,?,?)',
    [row.direction, row.msgType, row.controlId, row.peer, row.orderId || null, row.message, row.ack || null, row.status, row.error || null]
  ).catch(() => {});

const visitClass = (o) => (o.status_rawat === 'ranap' ? 'I' : /IGD|GAWAT/i.test(o.location || '') ? 'E' : 'O');
const sex = (s) => (s === 'M' || s === 'F' ? s : 'O');

async function buildOrm(o, control = 'NW') {
  const map = await mapping.getMap(o.kd_jenis_prw);
  const svc = map && map.loinc_code
    ? H.comp(map.loinc_code, map.loinc_display || o.procedure_name, 'LN', o.kd_jenis_prw, o.procedure_name, 'L')
    : H.comp(o.kd_jenis_prw, o.procedure_name, 'L');
  const prio = o.priority === 'STAT' ? 'S' : 'R';
  const sched = H.dbToTs(o.scheduled_at);
  const ref = H.comp(o.referring_kd_dokter || '', o.referring_name || '');
  const controlId = H.newControlId();
  const ids = [H.comp(o.no_rkm_medis, '', '', config.hospital.code, 'MR')];
  if (o.patient_nik) ids.push(H.comp(o.patient_nik, '', '', 'NIK', 'NNIDN'));
  const orcStatus = control === 'CA' ? 'CA' : 'SC';
  const acc = orders.dicomAcc(o); // sama dengan yang diterima alat lewat worklist (maks 16)
  const msg = [
    H.msh({ sendingApp: H7.sendingApp, sendingFac: config.hospital.code, receivingApp: H7.receivingApp, receivingFac: config.hospital.code, type: 'ORM^O01', controlId, version: H7.version }),
    H.seg('PID', '1', '', ids.join('~'), '', H.escape(toDicomName(o.patient_name, config.dicom.nameUppercase)), '', (o.patient_birthdate || '').replace(/-/g, ''), sex(o.patient_sex), '', '', H.escape(o.patient_address || '')),
    H.seg('PV1', '1', visitClass(o), H.escape(o.location || ''), '', '', '', '', ref, '', '', '', '', '', '', '', '', '', '', H.escape(o.no_rawat)),
    H.seg('ORC', control, H.escape(o.noorder), acc, '', orcStatus, '', `^^^${sched}^^${prio}`, '', H.ts(), '', '', ref),
    H.seg('OBR', '1', H.escape(o.noorder), acc, svc, '', '', H.dbToTs(o.requested_at), '', '', '', '', '',
      H.escape(o.clinical_info || ''), '', '', ref, '', acc, o.requested_procedure_id, o.sps_id, '', '', '', o.modality || '',
      '', '', `^^^${sched}^^${prio}`, '', '', '', H.escape(o.diagnosis || '')),
    H.seg('ZDS', H.comp(o.study_instance_uid, 'RIS', 'Application', 'DICOM')),
  ].join('\r');
  return { msg, controlId };
}

async function targetsFor(o) {
  const t = [];
  if (H7.outHost) t.push({ host: H7.outHost, port: H7.outPort, name: 'PACS' });
  if (o.station_ae) {
    const st = await db.risOne('SELECT * FROM ris_modalities WHERE ae_title=? AND hl7_enabled=1 AND active=1', [o.station_ae]);
    if (st && st.hl7_host) t.push({ host: st.hl7_host, port: st.hl7_port, name: st.ae_title });
  }
  return t;
}

async function sendOrm(o, control = 'NW') {
  const targets = await targetsFor(o);
  if (!targets.length) return { sent: 0 };
  const { msg, controlId } = await buildOrm(o, control);
  let sent = 0;
  for (const t of targets) {
    try {
      const ackRaw = await mllp.send(t.host, t.port, msg);
      const ack = H.parse(ackRaw);
      const code = ack.get('MSA', 1);
      const ok = code === 'AA' || code === 'CA';
      await hl7Log({ direction: 'OUT', msgType: `ORM^O01 ${control}`, controlId, peer: `${t.name} ${t.host}:${t.port}`, orderId: o.id, message: msg, ack: ackRaw, status: ok ? 'OK' : 'NACK', error: ok ? null : ack.get('MSA', 3) });
      if (ok) sent++;
    } catch (e) {
      log.warn(`Kirim ORM ke ${t.host}:${t.port} gagal`, e);
      await hl7Log({ direction: 'OUT', msgType: `ORM^O01 ${control}`, controlId, peer: `${t.name} ${t.host}:${t.port}`, orderId: o.id, message: msg, status: 'ERROR', error: e.message });
    }
  }
  if (sent) {
    await orders.updateFields(o.id, { hl7_sent_at: nowLocal().dt });
    await orders.addEvent(o.id, 'HL7_SENT', `ORM ${control} ke ${sent} tujuan`);
  }
  return { sent, targets: targets.length };
}

async function findOrderFromMsg(m) {
  const accession = m.get('OBR', 18) || m.get('OBR', 3) || m.get('ORC', 3) || m.get('OBR', 2) || m.get('ORC', 2);
  const modality = m.get('OBR', 24);
  let rows = await orders.resolveOrders({
    studyUid: m.get('ZDS', 1), spsId: m.get('OBR', 20), rpId: m.get('OBR', 19), accession,
    modalities: modality ? [modality] : [],
  });
  if (!rows.length && accession) rows = await db.risQuery("SELECT * FROM ris_orders WHERE noorder=? AND status<>'CANCELLED' ORDER BY id", [accession]);
  if (rows.length > 1) {
    // Satu noorder, beberapa pemeriksaan: pilih dari kode di OBR-4 (kode Khanza atau LOINC)
    const codes = [m.get('OBR', 4, 1), m.get('OBR', 4, 4)].filter(Boolean);
    for (const r of rows) {
      const map = await mapping.getMap(r.kd_jenis_prw);
      if (codes.includes(r.kd_jenis_prw) || (map && codes.includes(map.loinc_code))) return r;
    }
  }
  return rows[0] || null;
}

/** Ambil teks laporan dari segmen OBX: OBX-3 yang mengandung IMP/KESAN -> kesan, sisanya -> temuan. */
function extractReport(m) {
  const findings = [], impression = [];
  for (const s of m.all('OBX')) {
    const id = (s.fields[3] || '').toUpperCase();
    const val = (s.fields[5] || '').split('~').map(H.unescape).join('\n');
    if (!val.trim()) continue;
    (/IMP|KESAN|CONCL|KESIMPULAN/.test(id) ? impression : findings).push(val);
  }
  return { findings: findings.join('\n'), impression: impression.join('\n') };
}

let reportService = null; // diinjeksi saat start untuk menghindari require melingkar

async function handleInbound(raw, socket) {
  const peer = socket ? `${socket.remoteAddress}:${socket.remotePort}` : 'local';
  let m;
  try { m = H.parse(raw); } catch (e) {
    await hl7Log({ direction: 'IN', msgType: '?', peer, message: raw, status: 'ERROR', error: e.message });
    return null;
  }
  let code = 'AA', text = '', orderId = null;
  try {
    const order = await findOrderFromMsg(m);
    orderId = order && order.id;
    if (m.type.startsWith('ORU^R01')) {
      if (!order) throw new Error('Order tidak ditemukan (cek OBR-3/OBR-18 accession)');
      const rep = extractReport(m);
      const resultStatus = m.get('OBR', 25);
      await reportService.saveFromHl7(order, {
        ...rep,
        final: H7.oruAsFinal && (resultStatus === 'F' || resultStatus === 'C'),
        radiologistId: m.get('OBR', 32, 1) || m.get('OBX', 16, 1),
        radiologistName: m.get('OBR', 32, 2) || m.get('OBX', 16, 2),
      });
      text = 'Hasil diterima';
    } else if (m.type.startsWith('ORM^O01')) {
      if (!order) throw new Error('Order tidak ditemukan');
      const st = m.get('ORC', 5);
      if (st === 'IP') await orders.setStatus(order.id, 'IN_PROGRESS', { actor: 'HL7', detail: 'ORC-5=IP' });
      if (st === 'CM') await orders.setStatus(order.id, 'COMPLETED', { actor: 'HL7', detail: 'ORC-5=CM' });
    } else {
      text = 'Tipe pesan diabaikan';
    }
  } catch (e) {
    code = 'AE'; text = e.message;
    log.warn(`Pesan ${m.type} ${m.controlId}: ${e.message}`);
  }
  const ackMsg = H.ack(m, code, text, { sendingApp: H7.sendingApp });
  await hl7Log({ direction: 'IN', msgType: m.type, controlId: m.controlId, peer, orderId, message: raw, ack: ackMsg, status: code === 'AA' ? 'OK' : 'ERROR', error: code === 'AA' ? null : text });
  return ackMsg;
}

let server = null;
function start(deps) {
  reportService = deps.reportService;
  server = mllp.createServer(handleInbound, (e) => log.warn('Socket HL7', e));
  server.listen(H7.listenPort, () => log.info(`HL7 MLLP listener aktif di port ${H7.listenPort}`));
  orders.bus.on('order.created', (o) => sendOrm(o, 'NW').catch((e) => log.error('ORM NW', e)));
  orders.bus.on('order.cancelled', (o) => sendOrm(o, 'CA').catch((e) => log.error('ORM CA', e)));
  orders.bus.on('order.updated', (o) => sendOrm(o, 'XO').catch((e) => log.error('ORM XO', e)));
}
const stop = () => server && server.close();

module.exports = { start, stop, buildOrm, sendOrm, handleInbound, extractReport, injectReportService: (r) => { reportService = r; } };
