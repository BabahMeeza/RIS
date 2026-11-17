'use strict';
const EventEmitter = require('events');
const db = require('../lib/db');
const { nowLocal } = require('../lib/util');
const config = require('../config');

/** Event bus antar-modul: 'order.created', 'order.status', 'order.cancelled', 'report.verified', 'images.available' */
const bus = new EventEmitter();
bus.setMaxListeners(50);

// Urutan alur kerja. Status hanya bergerak maju (kecuali pembatalan / koreksi manual).
const RANK = { SCHEDULED: 1, IN_PROGRESS: 2, COMPLETED: 3, REPORTED: 4, VERIFIED: 5 };
const TERMINAL = ['CANCELLED', 'DISCONTINUED'];
const ALL_STATUS = ['SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'DISCONTINUED', 'CANCELLED', 'REPORTED', 'VERIFIED'];

async function addEvent(orderId, event, detail = null, actor = 'system') {
  await db.risQuery('INSERT INTO ris_order_events (order_id, event, detail, actor) VALUES (?,?,?,?)', [
    orderId, event, detail == null ? null : typeof detail === 'string' ? detail : JSON.stringify(detail), actor,
  ]);
}

const getById = (id) => db.risOne('SELECT * FROM ris_orders WHERE id=?', [id]);
const getByAccession = (acc) => db.risOne('SELECT * FROM ris_orders WHERE accession_number=? OR dicom_accession=? ORDER BY id LIMIT 1', [acc, acc]);
/** Accession yang dipakai ALAT/gambar DICOM (maks 16): dicom_accession bila ada, selain itu accession_number. */
const dicomAcc = (o) => (o && (o.dicom_accession || o.accession_number)) || '';
const getByStudyUid = (uid) => db.risOne('SELECT * FROM ris_orders WHERE study_instance_uid=?', [uid]);

/** Accession Number: PREFIX + yymmdd + nomor urut 4 digit per hari (maks 16 karakter, sesuai DICOM SH & DICOM Router Satu Sehat). */
async function nextAccession() {
  const ymd = nowLocal().dicomDate.slice(2);
  const key = 'ACC' + ymd;
  const [res] = await db.ris.query(
    'INSERT INTO ris_counters (k, v) VALUES (?, LAST_INSERT_ID(1)) ON DUPLICATE KEY UPDATE v = LAST_INSERT_ID(v + 1)',
    [key]
  );
  const seq = res.insertId || (await db.risOne('SELECT v FROM ris_counters WHERE k=?', [key])).v;
  const acc = `${config.sync.accessionPrefix}${ymd}${String(seq).padStart(4, '0')}`;
  if (acc.length > 16) throw new Error(`Accession ${acc} melebihi 16 karakter, perpendek ACCESSION_PREFIX`);
  return acc;
}

const SH_MAX = 16; // panjang maksimal DICOM SH (AccessionNumber, Requested Procedure ID, SPS ID)

/**
 * Accession format SIMRS Khanza (modul Orthanc Khanza, orthanc.UbahAccession):
 *   noorder.replaceAll("PR","") + kd_jenis_prw   ->  PR20261104004 + J000081 = 20261104004J000081
 * Karakter selain huruf/angka (titik, strip, spasi) dibuang: PR20261102001 + BHP.02 = 20261102001BHP02
 * Unik per item pemeriksaan. Requested Procedure ID & SPS ID (DICOM SH, maks 16 karakter)
 * memakai nilai yang sama, dipotong dari depan bila terlalu panjang.
 */
function khanzaIds(noorder, kdJenisPrw) {
  const accession = (String(noorder).replace(/PR/g, '') + String(kdJenisPrw)).replace(/[^A-Za-z0-9]/g, '');
  const tail = (s) => (s.length <= SH_MAX ? s : s.slice(-SH_MAX));
  return { accession, rpId: tail(accession), spsId: tail(accession), tooLong: accession.length > SH_MAX };
}

/**
 * Accession untuk alat bila format Khanza > 16 karakter:
 *   noorder tanpa "PR" + nomor urut item 2 digit   PR202611044020 (item ke-1) -> 20261104402001
 * Disimpan di ris_orders.dicom_accession (unik). Dicek agar tidak bentrok dengan accession lain.
 */
async function shortAccession(noorder) {
  let base = String(noorder).replace(/PR/g, '').replace(/[^A-Za-z0-9]/g, '');
  if (base.length > SH_MAX - 2) base = base.slice(-(SH_MAX - 2));
  for (let seq = 1; seq < 100; seq++) { // 01, 02, ... nomor pertama yang belum dipakai
    const cand = base + String(seq).padStart(2, '0');
    const clash = await db.risOne('SELECT id FROM ris_orders WHERE dicom_accession=? OR accession_number=? LIMIT 1', [cand, cand]);
    if (!clash) return cand;
  }
  throw new Error(`Tidak bisa membuat accession alat untuk ${noorder}`);
}

/** Tentukan Accession / Requested Procedure ID / SPS ID untuk order baru sesuai ACCESSION_FORMAT. */
async function assignIds(noorder, kdJenisPrw) {
  if (config.sync.accessionFormat === 'ris') {
    const acc = await nextAccession();
    return { accession: acc, dicomAccession: null, rpId: acc, spsId: acc + '1' };
  }
  const ids = khanzaIds(noorder, kdJenisPrw);
  if (!ids.tooLong) return { ...ids, dicomAccession: null };
  const short = await shortAccession(noorder);
  // RP ID & SPS ID ikut accession alat agar ketiganya konsisten di alat (semua <= 16)
  return { ...ids, dicomAccession: short, rpId: short, spsId: short };
}

const MOD_GROUP = (m) => (m === 'CR' || m === 'DX' ? ['CR', 'DX'] : [m]);

/**
 * Cari order dari identitas DICOM/HL7. Karena satu Accession (noorder) bisa berisi beberapa
 * pemeriksaan, urutan pencocokan: Study UID -> SPS ID -> Requested Procedure ID -> Accession
 * (+ modalitas untuk mempersempit). Mengembalikan array (bisa >1 bila tetap ambigu).
 */
async function resolveOrders({ studyUid, spsId, rpId, accession, modalities = [] } = {}) {
  if (studyUid) {
    const o = await getByStudyUid(studyUid);
    if (o) return [o];
  }
  for (const [col, val] of [['sps_id', spsId], ['requested_procedure_id', rpId]]) {
    if (!val) continue;
    const rows = await db.risQuery(
      `SELECT * FROM ris_orders WHERE ${col}=? ${accession ? 'AND (accession_number=? OR dicom_accession=?)' : ''} AND status<>'CANCELLED' ORDER BY id`,
      accession ? [val, accession, accession] : [val]
    );
    if (rows.length === 1) return rows;
  }
  if (!accession) return [];
  const rows = await db.risQuery("SELECT * FROM ris_orders WHERE (accession_number=? OR dicom_accession=?) AND status<>'CANCELLED' ORDER BY id", [accession, accession]);
  if (rows.length <= 1) return rows;
  const mods = modalities.flatMap(MOD_GROUP);
  const byMod = mods.length ? rows.filter((r) => mods.includes(r.modality)) : [];
  return byMod.length ? byMod : rows;
}

/**
 * Order lama (format Khanza > 16 karakter) yang masih Terjadwal diberi accession alat <= 16,
 * supaya tidak ada nilai melebihi batas DICOM yang dikirim ke alat. Order yang sudah diperiksa tidak diubah.
 */
async function backfillDicomAccession() {
  const rows = await db.risQuery(
    "SELECT * FROM ris_orders WHERE dicom_accession IS NULL AND CHAR_LENGTH(accession_number) > ? AND status='SCHEDULED' AND mpps_uid IS NULL AND pacs_study_id IS NULL ORDER BY id",
    [SH_MAX]);
  for (const o of rows) {
    const short = await shortAccession(o.noorder);
    await db.risQuery('UPDATE ris_orders SET dicom_accession=?, requested_procedure_id=?, sps_id=? WHERE id=?', [short, short, short, o.id]);
    await addEvent(o.id, 'ACCESSION_ALAT', `Accession untuk alat ${short} (accession Khanza ${o.accession_number} > 16 karakter)`);
    if (o.hl7_sent_at) bus.emit('order.updated', await getById(o.id));
  }
  return rows.length;
}

/**
 * Ubah status order. force=true untuk koreksi manual (boleh mundur).
 * Mengembalikan order terbaru atau null bila tidak berubah.
 */
async function setStatus(orderId, status, { actor = 'system', detail = null, force = false, extra = {} } = {}) {
  if (!ALL_STATUS.includes(status)) throw new Error('Status tidak dikenal: ' + status);
  const o = await getById(orderId);
  if (!o) throw new Error('Order tidak ditemukan');
  if (!force) {
    if (TERMINAL.includes(o.status) && !TERMINAL.includes(status)) return null;
    if (RANK[status] && RANK[o.status] && RANK[status] <= RANK[o.status]) {
      // status tidak maju; tetap simpan kolom tambahan (mis. waktu selesai)
      if (Object.keys(extra).length) await updateFields(orderId, extra);
      return null;
    }
  }
  await updateFields(orderId, { ...extra, status });
  await addEvent(orderId, 'STATUS', { from: o.status, to: status, ...(detail ? { info: detail } : {}) }, actor);
  const updated = await getById(orderId);
  bus.emit('order.status', updated, o.status);
  if (TERMINAL.includes(status)) bus.emit('order.cancelled', updated);
  return updated;
}

const UPDATABLE = new Set([
  'modality', 'station_ae', 'scheduled_at', 'priority', 'status', 'mpps_uid', 'exam_started_at', 'exam_ended_at',
  'radiographer', 'pacs_study_id', 'images_count', 'images_at', 'khanza_tgl_periksa', 'khanza_jam',
  'khanza_written_at', 'hl7_sent_at', 'ss_servicerequest_id', 'ss_imagingstudy_id', 'ss_observation_id',
  'ss_diagnosticreport_id', 'ss_dicom_forwarded_at', 'ss_error', 'clinical_info', 'diagnosis',
]);

async function updateFields(orderId, fields) {
  const keys = Object.keys(fields).filter((k) => UPDATABLE.has(k));
  if (!keys.length) return;
  await db.risQuery(
    `UPDATE ris_orders SET ${keys.map((k) => `\`${k}\`=?`).join(', ')} WHERE id=?`,
    [...keys.map((k) => fields[k]), orderId]
  );
}

async function listOrders({ dateFrom, dateTo, status, modality, q, limit = 300 } = {}) {
  const where = [];
  const p = [];
  if (dateFrom) { where.push('o.scheduled_at >= ?'); p.push(dateFrom + ' 00:00:00'); }
  if (dateTo) { where.push('o.scheduled_at <= ?'); p.push(dateTo + ' 23:59:59'); }
  if (status) {
    const st = String(status).split(',').filter((s) => ALL_STATUS.includes(s));
    if (st.length) { where.push(`o.status IN (${st.map(() => '?').join(',')})`); p.push(...st); }
  }
  if (modality) { where.push('o.modality = ?'); p.push(modality); }
  if (q) {
    where.push('(o.patient_name LIKE ? OR o.no_rkm_medis LIKE ? OR o.accession_number LIKE ? OR o.dicom_accession LIKE ? OR o.noorder LIKE ? OR o.no_rawat LIKE ?)');
    const like = `%${q}%`;
    p.push(like, like, like, like, like, like);
  }
  return db.risQuery(
    `SELECT o.*, r.status AS report_status, r.radiologist_name
       FROM ris_orders o LEFT JOIN ris_reports r ON r.order_id = o.id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY (o.priority='STAT') DESC, o.scheduled_at DESC LIMIT ${Math.min(+limit || 300, 1000)}`,
    p
  );
}

module.exports = {
  bus, RANK, ALL_STATUS, addEvent, getById, getByAccession, dicomAcc, shortAccession, backfillDicomAccession, getByStudyUid, nextAccession, setStatus,
  updateFields, listOrders, khanzaIds, assignIds, resolveOrders, MOD_GROUP,
};
