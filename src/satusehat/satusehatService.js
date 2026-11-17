'use strict';
/**
 * Orkestrasi alur radiologi SATUSEHAT:
 *  1. ServiceRequest (berisi Accession Number) dikirim SEBELUM gambar dikirim ke DICOM Router
 *  2. Study di Orthanc diteruskan ke DICOM Router (C-STORE) -> Router membuat ImagingStudy
 *  3. RIS mencari ImagingStudy berdasarkan ACSN
 *  4. Setelah expertise final: Observation + DiagnosticReport
 */
const config = require('../config');
const db = require('../lib/db');
const log = require('../lib/logger')('satusehat');
const ss = require('./client');
const fhir = require('./fhirMapper');
const orders = require('../services/orderService');
const mapping = require('../services/mappingService');
const khanza = require('../khanza/khanzaRepo');
const { nowLocal } = require('../lib/util');

const S = config.satusehat;
const NIK_SYSTEM = 'https://fhir.kemkes.go.id/id/nik';

async function ihs(kind, nik) {
  if (!nik || !/^\d{16}$/.test(String(nik))) throw new Error(`NIK ${kind === 'Patient' ? 'pasien' : 'dokter'} kosong / tidak valid (16 digit)`);
  const c = await db.risOne('SELECT ihs_id FROM ris_ihs_cache WHERE kind=? AND nik=?', [kind, nik]);
  if (c) return c.ihs_id;
  const b = await ss.get(`/${kind}?identifier=${encodeURIComponent(NIK_SYSTEM + '|' + nik)}`);
  const id = ss.firstId(b);
  if (!id) throw new Error(`${kind} dengan NIK ${nik} tidak ditemukan di SATUSEHAT`);
  const name = b.entry[0].resource.name && b.entry[0].resource.name[0] ? b.entry[0].resource.name[0].text : null;
  await db.risQuery('INSERT INTO ris_ihs_cache (kind, nik, ihs_id, name) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE ihs_id=VALUES(ihs_id), name=VALUES(name)', [kind, nik, id, name]);
  return id;
}

async function practitionerByKdDokter(kd) {
  if (!kd) throw new Error('Kode dokter kosong');
  const nik = await khanza.getDoctorNik(kd);
  return ihs('Practitioner', nik);
}

async function baseContext(o) {
  const patientId = await ihs('Patient', o.patient_nik);
  const encounterId = await khanza.getEncounterId(o.no_rawat);
  if (!encounterId) throw new Error('Encounter kunjungan ini belum dikirim ke SATUSEHAT dari Khanza (satu_sehat_encounter)');
  return { patientId, encounterId };
}

async function fail(o, e) {
  const msg = e.message.slice(0, 1000);
  if (o.ss_error !== msg) await orders.addEvent(o.id, 'SATUSEHAT_ERROR', e.message); // jejak hanya bila error berubah
  await orders.updateFields(o.id, { ss_error: msg });
  throw e;
}

async function sendServiceRequest(orderId) {
  const o = await orders.getById(orderId);
  if (o.ss_servicerequest_id) return { id: o.ss_servicerequest_id, existing: true };
  try {
    const map = await mapping.getMap(o.kd_jenis_prw);
    const ctx = await baseContext(o);
    ctx.requesterId = await practitionerByKdDokter(o.referring_kd_dokter);
    ctx.multiItem = (await db.risOne('SELECT COUNT(*) n FROM ris_orders WHERE noorder=?', [o.noorder])).n > 1;
    const body = fhir.serviceRequest(o, map, ctx);
    const r = await ss.post('/ServiceRequest', body, { orderId: o.id, resource: 'ServiceRequest' });
    await orders.updateFields(o.id, { ss_servicerequest_id: r.id, ss_error: null });
    await orders.addEvent(o.id, 'SATUSEHAT', `ServiceRequest ${r.id}`);
    return { id: r.id };
  } catch (e) { return fail(o, e); }
}

async function forwardDicom(orderId) {
  const o = await orders.getById(orderId);
  if (!o.pacs_study_id) throw new Error('Study belum ada di PACS');
  if (!o.ss_servicerequest_id) throw new Error('ServiceRequest belum terkirim (DICOM Router akan menolak)');
  if (!S.routerModality) throw new Error('SATUSEHAT_ROUTER_MODALITY belum diatur');
  const orthanc = require('../pacs/orthanc');
  try {
    const job = await orthanc.forwardStudy(o.pacs_study_id, S.routerModality);
    await orders.updateFields(o.id, { ss_dicom_forwarded_at: nowLocal().dt, ss_error: null });
    await orders.addEvent(o.id, 'SATUSEHAT', `Study diteruskan ke DICOM Router (job ${job && job.ID ? job.ID : '-'})`);
    return job;
  } catch (e) { return fail(o, e); }
}

async function findImagingStudy(orderId) {
  const o = await orders.getById(orderId);
  const b = await ss.get(`/ImagingStudy?identifier=${encodeURIComponent(fhir.ACSN_SYSTEM() + '|' + orders.dicomAcc(o))}`);
  // Accession = noorder bisa dipakai beberapa study: pilih yang Study UID-nya sama dengan order ini
  const entries = (b && b.entry) || [];
  const exact = entries.find((e) => (e.resource.identifier || []).some((i) => String(i.value || '').replace(/^urn:oid:/, '') === o.study_instance_uid));
  const id = exact ? exact.resource.id : entries.length === 1 ? entries[0].resource.id : null;
  if (id && id !== o.ss_imagingstudy_id) {
    await orders.updateFields(o.id, { ss_imagingstudy_id: id });
    await orders.addEvent(o.id, 'SATUSEHAT', `ImagingStudy ${id}`);
  }
  return { id };
}

async function sendReport(orderId) {
  let o = await orders.getById(orderId);
  const report = await db.risOne('SELECT * FROM ris_reports WHERE order_id=?', [orderId]);
  if (!report || !['FINAL', 'AMENDED'].includes(report.status)) throw new Error('Expertise belum final');
  try {
    if (!o.ss_servicerequest_id) { await sendServiceRequest(orderId); o = await orders.getById(orderId); }
    if (!o.ss_imagingstudy_id) { await findImagingStudy(orderId).catch(() => {}); o = await orders.getById(orderId); }
    const map = await mapping.getMap(o.kd_jenis_prw);
    const ctx = await baseContext(o);
    ctx.radiologistId = await practitionerByKdDokter(report.radiologist_kd_dokter);

    const obsBody = fhir.observation(o, map, report, ctx);
    let obs;
    if (o.ss_observation_id) obs = await ss.request('PUT', `/Observation/${o.ss_observation_id}`, { ...obsBody, id: o.ss_observation_id }, { orderId, resource: 'Observation' });
    else obs = await ss.post('/Observation', obsBody, { orderId, resource: 'Observation' });
    ctx.observationId = obs.id;

    const drBody = fhir.diagnosticReport(o, map, report, ctx);
    let dr;
    if (o.ss_diagnosticreport_id) dr = await ss.request('PUT', `/DiagnosticReport/${o.ss_diagnosticreport_id}`, { ...drBody, id: o.ss_diagnosticreport_id }, { orderId, resource: 'DiagnosticReport' });
    else dr = await ss.post('/DiagnosticReport', drBody, { orderId, resource: 'DiagnosticReport' });

    await orders.updateFields(o.id, { ss_observation_id: obs.id, ss_diagnosticreport_id: dr.id, ss_error: null });
    await orders.addEvent(o.id, 'SATUSEHAT', `Observation ${obs.id}, DiagnosticReport ${dr.id}${o.ss_imagingstudy_id ? '' : ' (tanpa ImagingStudy)'}`);
    return { observation: obs.id, diagnosticReport: dr.id };
  } catch (e) { return fail(o, e); }
}

// ---------------- worker otomatis ----------------
const backoff = new Map(); // orderId -> timestamp boleh dicoba lagi
const ready = (id) => !backoff.has(id) || Date.now() > backoff.get(id);
const later = (id, min = 10) => backoff.set(id, Date.now() + min * 60000);
const attempt = async (id, fn) => { if (!ready(id)) return; try { await fn(id); backoff.delete(id); } catch (e) { later(id); log.warn(`Order ${id}: ${e.message}`); } };

async function tick() {
  const since = nowLocal(new Date(Date.now() - 3 * 864e5)).dt;
  const needSr = await db.risQuery(
    "SELECT id FROM ris_orders WHERE ss_servicerequest_id IS NULL AND status NOT IN ('CANCELLED') AND requested_at >= ? LIMIT 50", [since]);
  for (const r of needSr) await attempt(r.id, sendServiceRequest);

  if (S.routerModality) {
    const needFwd = await db.risQuery(
      'SELECT id FROM ris_orders WHERE ss_servicerequest_id IS NOT NULL AND pacs_study_id IS NOT NULL AND ss_dicom_forwarded_at IS NULL LIMIT 20');
    for (const r of needFwd) await attempt(r.id, forwardDicom);
  }
  const needIs = await db.risQuery(
    'SELECT id FROM ris_orders WHERE ss_imagingstudy_id IS NULL AND ss_dicom_forwarded_at IS NOT NULL AND ss_dicom_forwarded_at < ? LIMIT 50',
    [nowLocal(new Date(Date.now() - 2 * 60000)).dt]);
  for (const r of needIs) await attempt(r.id, findImagingStudy);

  const needDr = await db.risQuery(
    "SELECT o.id FROM ris_orders o JOIN ris_reports r ON r.order_id=o.id WHERE r.status IN ('FINAL','AMENDED') AND o.ss_diagnosticreport_id IS NULL AND o.status='VERIFIED' LIMIT 20");
  for (const r of needDr) await attempt(r.id, sendReport);
}

let timer = null;
function start() {
  if (S.auto) {
    orders.bus.on('order.created', (o) => attempt(o.id, sendServiceRequest));
    orders.bus.on('images.available', (o) => S.routerModality && o.ss_servicerequest_id && attempt(o.id, forwardDicom));
    orders.bus.on('report.verified', (o, meta) => { if (meta && meta.amended) backoff.delete(o.id); attempt(o.id, sendReport); });
    const loop = () => tick().catch((e) => log.warn('Worker SATUSEHAT', e)).finally(() => { timer = setTimeout(loop, S.intervalMs); });
    timer = setTimeout(loop, 5000);
  }
  log.info(`Integrasi SATUSEHAT aktif (org ${S.orgId || '-'}, otomatis=${S.auto})`);
}
const stop = () => timer && clearTimeout(timer);

module.exports = { start, stop, sendServiceRequest, forwardDicom, findImagingStudy, sendReport, ihs };
