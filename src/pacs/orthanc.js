'use strict';
/**
 * Integrasi PACS Orthanc (REST API):
 *  - memantau /changes (StableStudy) -> mencocokkan study dengan order (Accession / Study UID / No.RM)
 *  - study yang tidak cocok masuk daftar rekonsiliasi
 *  - koreksi tag (modify), forward ke DICOM Router Satu Sehat, preview JPG untuk Khanza
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');
const db = require('../lib/db');
const log = require('../lib/logger')('orthanc');
const orders = require('../services/orderService');
const { nowLocal, fromDicomDate } = require('../lib/util');

const O = config.orthanc;
const authHeader = O.user ? { Authorization: 'Basic ' + Buffer.from(`${O.user}:${O.pass}`).toString('base64') } : {};

async function api(p, { method = 'GET', body, accept = 'application/json', raw = false, timeout = 30000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(O.url + p, {
      method, signal: ctl.signal,
      headers: { ...authHeader, Accept: accept, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    });
    if (!res.ok) throw new Error(`Orthanc ${method} ${p} -> HTTP ${res.status} ${await res.text().catch(() => '')}`.slice(0, 500));
    if (raw) return Buffer.from(await res.arrayBuffer());
    const ct = res.headers.get('content-type') || '';
    return ct.includes('json') ? res.json() : res.text();
  } finally { clearTimeout(t); }
}

const viewerUrl = (o) =>
  O.viewerTemplate && o && o.pacs_study_id
    ? O.viewerTemplate.replace('{studyUid}', encodeURIComponent(o.study_instance_uid)).replace('{accession}', encodeURIComponent(orders.dicomAcc(o))).replace('{orthancId}', o.pacs_study_id)
    : null;

async function studyInfo(id) {
  const st = await api(`/studies/${id}`);
  let count = 0;
  try { count = (await api(`/studies/${id}/statistics`)).CountInstances || 0; } catch { count = 0; }
  const tags = st.MainDicomTags || {};
  const pt = st.PatientMainDicomTags || {};
  let modalities = tags.ModalitiesInStudy || '';
  if (!modalities && st.Series && st.Series.length) {
    try { modalities = [...new Set(await Promise.all(st.Series.slice(0, 5).map(async (s) => (await api(`/series/${s}`)).MainDicomTags.Modality)))].join('\\'); } catch { /* abaikan */ }
  }
  return {
    id, count, accession: tags.AccessionNumber || '', studyUid: tags.StudyInstanceUID || '', studyDate: tags.StudyDate || '',
    description: tags.StudyDescription || '', patientId: pt.PatientID || '', patientName: pt.PatientName || '', modalities,
  };
}

async function attach(order, info, how, actor = 'PACS') {
  await orders.updateFields(order.id, { pacs_study_id: info.id, images_count: info.count, images_at: nowLocal().dt });
  await orders.addEvent(order.id, 'IMAGES', `${info.count} gambar di PACS (${how})`, actor);
  if (['SCHEDULED', 'IN_PROGRESS'].includes(order.status)) {
    // Alat tanpa MPPS: gambar masuk = pemeriksaan selesai
    await orders.setStatus(order.id, 'COMPLETED', { actor, detail: 'Gambar diterima PACS', extra: { exam_ended_at: nowLocal().dt } });
  }
  await db.risQuery('UPDATE ris_unmatched_studies SET resolved_order_id=?, resolved_by=?, resolved_at=NOW() WHERE pacs_study_id=? AND resolved_order_id IS NULL', [order.id, actor, info.id]);
  orders.bus.emit('images.available', await orders.getById(order.id));
}

async function handleStudy(id) {
  const info = await studyInfo(id);
  const mods = info.modalities.split('\\').filter(Boolean);
  let order = null, how = '';

  // Study UID / Accession (noorder). Satu noorder bisa berisi beberapa pemeriksaan:
  // dipersempit dengan modalitas; bila tetap >1 (mis. 2 foto DX dalam satu study), semua ditautkan.
  const found = (await orders.resolveOrders({ studyUid: info.studyUid, accession: info.accession, modalities: mods }))
    .filter((o) => !o.pacs_study_id || o.pacs_study_id === id);
  if (found.length) {
    const how1 = found[0].study_instance_uid === info.studyUid ? 'Study UID' : 'Accession';
    for (const o of found.slice(1)) await attach(o, info, `${how1}, satu study untuk beberapa pemeriksaan`);
    order = found[0]; how = how1;
  }
  if (!order) {
    const existing = await db.risOne('SELECT * FROM ris_orders WHERE pacs_study_id=?', [id]);
    if (existing) { order = existing; how = 'update'; }
  }
  if (!order && info.patientId && info.studyDate) {
    // Cadangan: No.RM + tanggal + modalitas, hanya jika kandidat tunggal
    const date = fromDicomDate(info.studyDate);
    const cands = await db.risQuery(
      `SELECT * FROM ris_orders WHERE no_rkm_medis=? AND DATE(scheduled_at)=? AND pacs_study_id IS NULL
         AND status NOT IN ('CANCELLED') ${mods.length ? `AND modality IN (${mods.map(() => '?').join(',')})` : ''}`,
      [info.patientId, date, ...mods]
    );
    if (cands.length === 1) { order = cands[0]; how = 'No.RM + tanggal (accession tidak cocok)'; }
  }
  if (order) {
    await attach(order, info, how);
    return { matched: true, orderId: order.id, how };
  }
  await db.risQuery(
    `INSERT INTO ris_unmatched_studies (pacs_study_id, study_instance_uid, accession_number, patient_id, patient_name, study_date, modalities, description, images_count)
     VALUES (?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE images_count=VALUES(images_count)`,
    [id, info.studyUid, info.accession, info.patientId, info.patientName, info.studyDate, info.modalities, info.description, info.count]
  );
  log.warn(`Study ${id} (RM ${info.patientId}, ACC ${info.accession || '-'}) tidak cocok dengan order -> rekonsiliasi`);
  return { matched: false };
}

/** Rekonsiliasi manual. fixTags=true: tulis ulang AccessionNumber/PatientID/PatientName di PACS. */
async function linkStudy(orderId, pacsStudyId, { fixTags = false, actor } = {}) {
  let order = await orders.getById(orderId);
  if (!order) throw new Error('Order tidak ditemukan');
  let id = pacsStudyId;
  if (fixTags) {
    const { toDicomName } = require('../lib/util');
    const r = await api(`/studies/${id}/modify`, {
      method: 'POST', timeout: 300000,
      body: {
        Replace: { AccessionNumber: orders.dicomAcc(order), PatientID: order.no_rkm_medis, PatientName: toDicomName(order.patient_name) },
        Keep: ['StudyInstanceUID', 'SeriesInstanceUID', 'SOPInstanceUID'], Force: true, KeepSource: false,
      },
    });
    id = r.ID || id;
    await orders.addEvent(order.id, 'PACS_MODIFY', `Tag study dikoreksi (study baru ${id})`, actor);
    await db.risQuery('UPDATE ris_unmatched_studies SET resolved_order_id=?, resolved_by=?, resolved_at=NOW() WHERE pacs_study_id=?', [order.id, actor, pacsStudyId]);
  }
  const info = await studyInfo(id);
  if (info.studyUid && info.studyUid !== order.study_instance_uid) {
    // Pakai Study UID dari alat agar viewer & Satu Sehat konsisten dengan gambar sebenarnya
    await db.risQuery('UPDATE ris_orders SET study_instance_uid=? WHERE id=?', [info.studyUid, order.id]);
  }
  await attach(order, info, 'rekonsiliasi manual', actor);
  return orders.getById(order.id);
}

async function forwardStudy(pacsStudyId, modalityName) {
  return api(`/modalities/${encodeURIComponent(modalityName)}/store`, { method: 'POST', body: { Resources: [pacsStudyId], Synchronous: false } });
}

/** Simpan preview JPG setiap instance (maks n) ke folder tujuan; mengembalikan nama file. */
async function savePreviews(pacsStudyId, dir, baseName, max = 12) {
  fs.mkdirSync(dir, { recursive: true });
  const inst = await api(`/studies/${pacsStudyId}/instances`);
  const files = [];
  for (const [i, it] of inst.slice(0, max).entries()) {
    const buf = await api(`/instances/${it.ID}/preview`, { accept: 'image/jpeg', raw: true });
    const name = `${baseName}_${String(i + 1).padStart(2, '0')}.jpg`;
    fs.writeFileSync(path.join(dir, name), buf);
    files.push(name);
  }
  return files;
}

// ---------------- polling /changes ----------------
let timer = null;
let lastOk = null, lastError = null;
async function poll() {
  let since = await db.getSetting('orthanc_last_seq');
  if (since === null) {
    if (O.replayHistory) since = 0;
    else { since = (await api('/changes?last')).Last || 0; await db.setSetting('orthanc_last_seq', since); }
  }
  for (let guard = 0; guard < 50; guard++) {
    const r = await api(`/changes?since=${since}&limit=100`);
    for (const c of r.Changes || []) {
      if (c.ChangeType === 'StableStudy') {
        try { await handleStudy(c.ID); } catch (e) { log.error(`Gagal memproses study ${c.ID}`, e); }
      }
    }
    since = r.Last;
    await db.setSetting('orthanc_last_seq', since);
    if (r.Done) break;
  }
  lastOk = nowLocal().dt; lastError = null;
}

function start() {
  const tick = () => poll().catch((e) => { lastError = e.message; log.warn('Polling Orthanc gagal', e); }).finally(() => { timer = setTimeout(tick, O.pollMs); });
  tick();
  log.info(`Memantau Orthanc ${O.url} setiap ${O.pollMs / 1000} detik`);
}
const stop = () => timer && clearTimeout(timer);
const status = () => ({ lastOk, lastError, url: O.url });
const system = () => api('/system', { timeout: 5000 });

module.exports = { api, start, stop, status, system, handleStudy, linkStudy, forwardStudy, savePreviews, viewerUrl, studyInfo };
