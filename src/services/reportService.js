'use strict';
/** Expertise radiolog: draft -> FINAL (verifikasi) -> AMENDED (revisi, berversi). */
const db = require('../lib/db');
const orders = require('./orderService');
const writeback = require('./khanzaWriteback');
const { nowLocal } = require('../lib/util');

const get = (orderId) => db.risOne('SELECT * FROM ris_reports WHERE order_id=?', [orderId]);
const history = (reportId) => db.risQuery('SELECT * FROM ris_report_history WHERE report_id=? ORDER BY version DESC, id DESC', [reportId]);

async function snapshot(r, changedBy, reason) {
  await db.risQuery(
    'INSERT INTO ris_report_history (report_id, version, findings, impression, status, radiologist_name, changed_by, reason) VALUES (?,?,?,?,?,?,?,?)',
    [r.id, r.version, r.findings, r.impression, r.status, r.radiologist_name, changedBy, reason]
  );
}

async function saveDraft(orderId, { findings, impression }, user, source = 'RIS') {
  const o = await orders.getById(orderId);
  if (!o) throw new Error('Order tidak ditemukan');
  if (['CANCELLED'].includes(o.status)) throw new Error('Order dibatalkan');
  const r = await get(orderId);
  if (r && r.status !== 'DRAFT') throw new Error('Expertise sudah final. Gunakan Revisi (amend).');
  if (r) {
    await db.risQuery('UPDATE ris_reports SET findings=?, impression=?, source=? WHERE id=?', [findings || '', impression || '', source, r.id]);
  } else {
    await db.risQuery(
      'INSERT INTO ris_reports (order_id, findings, impression, status, source, radiologist_kd_dokter, radiologist_name, created_by) VALUES (?,?,?,?,?,?,?,?)',
      [orderId, findings || '', impression || '', 'DRAFT', source, user.kd_dokter || null, user.role === 'radiolog' ? user.full_name : null, user.username]
    );
  }
  await orders.setStatus(orderId, 'REPORTED', { actor: user.username, detail: 'Draft expertise' });
  return get(orderId);
}

async function verify(orderId, user) {
  if (user.role !== 'radiolog') throw new Error('Hanya radiolog yang dapat memverifikasi expertise');
  if (!user.kd_dokter) throw new Error('Akun radiolog belum ditautkan ke kd_dokter Khanza');
  const r = await get(orderId);
  if (!r) throw new Error('Belum ada draft expertise');
  if (r.status !== 'DRAFT') throw new Error('Expertise sudah final');
  if (!String(r.findings || '').trim() && !String(r.impression || '').trim()) throw new Error('Expertise masih kosong');
  await db.risQuery(
    "UPDATE ris_reports SET status='FINAL', radiologist_kd_dokter=?, radiologist_name=?, verified_by=?, verified_at=? WHERE id=?",
    [user.kd_dokter, user.full_name, user.username, nowLocal().dt, r.id]
  );
  await snapshot({ ...r, status: 'FINAL', radiologist_name: user.full_name }, user.username, 'Verifikasi');
  const o = await orders.setStatus(orderId, 'VERIFIED', { actor: user.username, detail: 'Expertise diverifikasi', force: true });
  const order = o || (await orders.getById(orderId));
  await writeback.onVerified(order);
  orders.bus.emit('report.verified', order);
  return get(orderId);
}

async function amend(orderId, { findings, impression, reason }, user) {
  if (user.role !== 'radiolog') throw new Error('Hanya radiolog yang dapat merevisi expertise');
  if (!reason || !reason.trim()) throw new Error('Alasan revisi wajib diisi');
  const r = await get(orderId);
  if (!r || r.status === 'DRAFT') throw new Error('Expertise belum final');
  await snapshot(r, user.username, 'Sebelum revisi');
  await db.risQuery(
    "UPDATE ris_reports SET findings=?, impression=?, status='AMENDED', version=version+1, radiologist_kd_dokter=?, radiologist_name=?, verified_by=?, verified_at=? WHERE id=?",
    [findings || '', impression || '', user.kd_dokter, user.full_name, user.username, nowLocal().dt, r.id]
  );
  const nr = await get(orderId);
  await snapshot(nr, user.username, reason);
  await orders.addEvent(orderId, 'REPORT_AMENDED', reason, user.username);
  const order = await orders.getById(orderId);
  await writeback.onVerified(order);
  orders.bus.emit('report.verified', order, { amended: true });
  return nr;
}

/** Hasil dari PACS/reporting eksternal via HL7 ORU. */
async function saveFromHl7(order, { findings, impression, final, radiologistId, radiologistName }) {
  const r = await get(order.id);
  if (r && r.status !== 'DRAFT') {
    await orders.addEvent(order.id, 'HL7_ORU_IGNORED', 'ORU diterima tetapi expertise sudah final di RIS');
    return r;
  }
  const doc = radiologistId ? await db.risOne("SELECT * FROM ris_users WHERE kd_dokter=? AND role='radiolog' AND active=1", [radiologistId]) : null;
  const pseudoUser = doc || { username: 'HL7', role: 'radiolog', kd_dokter: radiologistId || null, full_name: radiologistName || null };
  await saveDraft(order.id, { findings, impression }, pseudoUser, 'HL7');
  await orders.addEvent(order.id, 'HL7_ORU', `Hasil diterima dari PACS${radiologistName ? ' (' + radiologistName + ')' : ''}`);
  if (final && doc) return verify(order.id, doc);
  return get(order.id);
}

module.exports = { get, history, saveDraft, verify, amend, saveFromHl7 };
