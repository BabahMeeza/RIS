'use strict';
/**
 * Tulis balik hasil ke SIMRS Khanza.
 *
 * Kunci hasil_radiologi di Khanza = (no_rawat, tgl_periksa, jam) dan harus sama
 * dengan baris periksa_radiologi agar tampil di form Periksa Radiologi / riwayat.
 * Urutan penentuan tgl_periksa+jam:
 *   1) sudah tersimpan di order (khanza_tgl_periksa/khanza_jam)
 *   2) baris periksa_radiologi yang diinput petugas di Khanza (no_rawat + kd_jenis_prw)
 *   3) KHANZA_WRITE_PERIKSA=true -> RIS membuat baris periksa_radiologi (billing)
 *   4) waktu mulai pemeriksaan (hasil tetap tersimpan, peringatan dicatat)
 */
const config = require('../config');
const db = require('../lib/db');
const log = require('../lib/logger')('khanza');
const khanza = require('../khanza/khanzaRepo');
const orders = require('./orderService');
const { nowLocal } = require('../lib/util');

async function resolveKey(o, report) {
  if (o.khanza_tgl_periksa && o.khanza_jam) return { tgl: o.khanza_tgl_periksa, jam: o.khanza_jam, source: 'order' };
  const p = await khanza.findPeriksa(o.no_rawat, o.kd_jenis_prw, String(o.requested_at).slice(0, 10));
  if (p) return { tgl: p.tgl_periksa, jam: p.jam, source: 'periksa_radiologi' };
  const when = o.exam_started_at || o.images_at || nowLocal().dt;
  const tgl = String(when).slice(0, 10), jam = String(when).slice(11, 19);
  if (config.khanza.writePeriksa) {
    const mp = o.mpps_uid ? await db.risOne('SELECT kvp, mas, dose FROM ris_mpps WHERE sop_instance_uid=?', [o.mpps_uid]) : null;
    const user = o.radiographer ? await db.risOne('SELECT nip FROM ris_users WHERE full_name=? AND nip IS NOT NULL', [o.radiographer]) : null;
    await khanza.insertPeriksa({
      noRawat: o.no_rawat, nip: (user && user.nip) || config.khanza.defaultNip, kdJenisPrw: o.kd_jenis_prw, tgl, jam,
      dokterPerujuk: o.referring_kd_dokter, kdDokter: report.radiologist_kd_dokter, statusRawat: o.status_rawat,
      kv: mp && mp.kvp, mas: mp && mp.mas, dosis: mp && mp.dose,
    });
    await orders.addEvent(o.id, 'KHANZA', `periksa_radiologi dibuat ${tgl} ${jam}`);
    return { tgl, jam, source: 'insert' };
  }
  await orders.addEvent(o.id, 'WARNING', 'periksa_radiologi belum diinput di Khanza; hasil disimpan dengan waktu pemeriksaan');
  return { tgl, jam, source: 'fallback' };
}

function composeText(o, r) {
  const lines = [`PEMERIKSAAN : ${o.procedure_name}`, `No. Accession : ${o.accession_number}`, ''];
  if (r.findings) lines.push(r.findings.trim(), '');
  if (r.impression) lines.push('KESAN :', r.impression.trim(), '');
  if (r.status === 'AMENDED') lines.push(`(Revisi ke-${r.version - 1})`);
  lines.push(`Radiolog : ${r.radiologist_name || '-'}`);
  return lines.join('\n');
}

async function writeHasil(orderId) {
  const o = await orders.getById(orderId);
  const r = await db.risOne('SELECT * FROM ris_reports WHERE order_id=?', [orderId]);
  if (!o || !r || !['FINAL', 'AMENDED'].includes(r.status)) throw new Error('Expertise belum final');
  const key = await resolveKey(o, r);
  await orders.updateFields(o.id, { khanza_tgl_periksa: key.tgl, khanza_jam: key.jam });

  // Beberapa pemeriksaan dalam satu kunjungan & waktu periksa yang sama digabung dalam satu hasil_radiologi
  const siblings = await db.risQuery(
    `SELECT o.*, r.findings, r.impression, r.status AS rstatus, r.version, r.radiologist_name
       FROM ris_orders o JOIN ris_reports r ON r.order_id = o.id
      WHERE o.no_rawat=? AND o.khanza_tgl_periksa=? AND o.khanza_jam=? AND r.status IN ('FINAL','AMENDED')
      ORDER BY o.id`,
    [o.no_rawat, key.tgl, key.jam]
  );
  const text = siblings
    .map((s) => composeText(s, { findings: s.findings, impression: s.impression, status: s.rstatus, version: s.version, radiologist_name: s.radiologist_name }))
    .join('\n\n----------------------------------------\n\n');
  await khanza.upsertHasil(o.no_rawat, key.tgl, key.jam, text);
  const now = nowLocal();
  await khanza.markHasil(o.noorder, now.date, now.time);
  if (config.khanza.writeGambar) await writeGambar(o, key).catch((e) => orders.addEvent(o.id, 'KHANZA_ERROR', 'Gambar: ' + e.message));
  await orders.updateFields(o.id, { khanza_written_at: now.dt });
  await orders.addEvent(o.id, 'KHANZA', `hasil_radiologi tersimpan (${key.tgl} ${key.jam}, sumber ${key.source})`);
  return key;
}

async function writeGambar(o, key) {
  if (!o.pacs_study_id || !config.khanza.gambarDir) return 0;
  const orthanc = require('../pacs/orthanc');
  const base = `${o.no_rawat.replace(/\//g, '')}_${o.accession_number}`;
  const files = await orthanc.savePreviews(o.pacs_study_id, config.khanza.gambarDir, base);
  for (const f of files) await khanza.insertGambar(o.no_rawat, key.tgl, key.jam, config.khanza.gambarPrefix + f);
  await orders.addEvent(o.id, 'KHANZA', `${files.length} gambar preview ditulis ke gambar_radiologi`);
  return files.length;
}

/** Dipanggil saat expertise diverifikasi (tidak melempar error ke pemanggil). */
async function onVerified(order) {
  if (!config.khanza.writeHasil) return;
  try {
    await writeHasil(order.id);
  } catch (e) {
    log.error(`Tulis hasil ke Khanza gagal (order ${order.id})`, e);
    await orders.addEvent(order.id, 'KHANZA_ERROR', e.message);
  }
}

module.exports = { writeHasil, writeGambar, onVerified, composeText, resolveKey };
