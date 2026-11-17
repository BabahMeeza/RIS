'use strict';
/**
 * Sinkronisasi order: SIMRS Khanza (permintaan_radiologi) -> RIS (ris_orders).
 * Setiap item pemeriksaan pada satu noorder menjadi satu Requested Procedure
 * dengan Accession Number & Study Instance UID sendiri.
 */
const db = require('../lib/db');
const config = require('../config');
const log = require('../lib/logger')('sync');
const khanza = require('../khanza/khanzaRepo');
const orders = require('./orderService');
const mapping = require('./mappingService');
const { nowLocal, addDays, generateUid, isZeroDate } = require('../lib/util');

let running = false;
let lastRun = null;
let lastError = null;
let lastCount = 0;
const failedLogged = new Set(); // agar error order yang sama tidak membanjiri log tiap 15 detik

async function syncOnce() {
  if (running) return { skipped: true };
  running = true;
  try {
    const since = addDays(nowLocal().date, -config.sync.lookbackDays);
    const rows = (await khanza.listOrdersSince(since)).filter((r) => !mapping.isExcluded(r.kd_jenis_prw));
    const existing = await db.risQuery(
      'SELECT id, noorder, kd_jenis_prw, status FROM ris_orders WHERE requested_at >= ?', [since + ' 00:00:00']
    );
    const key = (a, b) => `${a}|${b}`;
    const have = new Map(existing.map((e) => [key(e.noorder, e.kd_jenis_prw), e]));
    const seen = new Set();
    let created = 0, failed = 0;

    for (const r of rows) {
      const k = key(r.noorder, r.kd_jenis_prw);
      seen.add(k);
      if (have.has(k)) continue;
      // Duplikasi di luar jendela lookback (mis. order lama yang diedit) - cek langsung
      const dup = await db.risOne('SELECT id FROM ris_orders WHERE noorder=? AND kd_jenis_prw=?', [r.noorder, r.kd_jenis_prw]);
      if (dup) continue;
      // Satu order bermasalah tidak boleh menghentikan sinkron order lain
      try {
        await createOrder(r);
        created++;
        failedLogged.delete(k);
      } catch (e) {
        failed++;
        lastError = `${r.noorder}/${r.kd_jenis_prw}: ${e.message}`;
        if (!failedLogged.has(k)) { failedLogged.add(k); log.error(`Order ${r.noorder}/${r.kd_jenis_prw} gagal disimpan`, e); }
      }
    }

    // Order yang dihapus/dibatalkan di Khanza dan belum dikerjakan -> CANCELLED
    for (const e of existing) {
      if (!seen.has(key(e.noorder, e.kd_jenis_prw)) && e.status === 'SCHEDULED') {
        await orders.setStatus(e.id, 'CANCELLED', { detail: 'Permintaan tidak ditemukan lagi di SIMRS Khanza' });
        log.info(`Order ${e.noorder}/${e.kd_jenis_prw} dibatalkan (hilang dari Khanza)`);
      }
    }
    lastRun = nowLocal().dt; lastCount = created;
    if (!failed) lastError = null;
    if (created) log.info(`${created} order baru dari Khanza`);
    return { created, failed, scanned: rows.length };
  } catch (e) {
    lastError = e.message;
    log.error('Sinkron gagal', e);
    throw e;
  } finally {
    running = false;
  }
}

async function createOrder(r) {
  const map = await mapping.getMap(r.kd_jenis_prw);
  const modality = (map && map.modality) || mapping.guessModality(r.nm_perawatan);
  const station = await mapping.pickStation(map, modality);
  const { accession, dicomAccession, rpId, spsId } = await orders.assignIds(r.noorder, r.kd_jenis_prw);
  const requestedAt = `${r.tgl_permintaan} ${r.jam_permintaan || '00:00:00'}`;
  const isStat = /CITO|STAT|SEGERA/i.test(`${r.informasi_tambahan || ''} ${r.diagnosa_klinis || ''}`) || r.kd_poli === 'IGDK';
  const location = r.status_rawat === 'ranap' ? r.nm_bangsal || 'Rawat Inap' : r.nm_poli || 'Rawat Jalan';

  const row = {
    noorder: r.noorder,
    kd_jenis_prw: r.kd_jenis_prw,
    no_rawat: r.no_rawat,
    no_rkm_medis: r.no_rkm_medis,
    patient_name: r.nm_pasien,
    patient_sex: r.jk === 'P' ? 'F' : r.jk === 'L' ? 'M' : 'O',
    patient_birthdate: isZeroDate(r.tgl_lahir) ? null : r.tgl_lahir,
    patient_nik: r.no_ktp || null,
    patient_address: r.alamat || null,
    status_rawat: r.status_rawat,
    location,
    penjamin: r.png_jawab || null,
    procedure_name: r.nm_perawatan,
    modality,
    station_ae: station,
    accession_number: accession,
    dicom_accession: dicomAccession,
    requested_procedure_id: rpId,
    sps_id: spsId,
    study_instance_uid: generateUid(),
    referring_kd_dokter: r.dokter_perujuk || null,
    referring_name: r.nm_perujuk || null,
    clinical_info: r.informasi_tambahan || null,
    diagnosis: r.diagnosa_klinis || null,
    priority: isStat ? 'STAT' : 'ROUTINE',
    requested_at: requestedAt,
    scheduled_at: requestedAt,
  };
  const cols = Object.keys(row);
  const [res] = await db.ris.query(
    `INSERT INTO ris_orders (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
    cols.map((c) => row[c])
  );
  await orders.addEvent(res.insertId, 'CREATED', {
    source: 'Khanza', noorder: r.noorder, accession, modality, station_ae: station, mapped: !!map,
  });
  if (dicomAccession) await orders.addEvent(res.insertId, 'ACCESSION_ALAT', `Accession untuk alat ${dicomAccession} (accession Khanza ${accession} > 16 karakter, batas DICOM)`);
  if (!map) await orders.addEvent(res.insertId, 'WARNING', `Jenis pemeriksaan ${r.kd_jenis_prw} belum dipetakan; modalitas ditebak ${modality}`);
  const order = await orders.getById(res.insertId);
  orders.bus.emit('order.created', order);
  return order;
}

const brief = (o, isNew) => ({
  id: o.id, kd_jenis_prw: o.kd_jenis_prw, nama: o.procedure_name, accession: o.accession_number, accession_alat: orders.dicomAcc(o),
  modality: o.modality, station: o.station_ae || `semua alat ${o.modality}`, status: o.status, baru: isNew,
});

/**
 * Kirim satu noorder dari Khanza ke RIS (dipanggil tombol "Kirim ke RIS").
 * Idempoten: item yang sudah ada tidak dibuat ulang; item yang sebelumnya dibatalkan diaktifkan lagi;
 * item yang sudah dihapus dari permintaan di Khanza (dan belum dikerjakan) dibatalkan.
 * Setelah tersimpan, order langsung tersedia di Modality Worklist + ORM HL7 dikirim (bila dikonfigurasi).
 */
async function pushOrder(noorder, actor = 'khanza') {
  noorder = String(noorder || '').trim();
  if (!noorder) throw Object.assign(new Error('noorder wajib diisi'), { status: 400 });
  const all = await khanza.listOrdersByNoorder(noorder);
  if (!all.length) throw Object.assign(new Error(`Permintaan ${noorder} tidak ditemukan di SIMRS Khanza (atau belum ada item pemeriksaan)`), { status: 404 });
  const rows = all.filter((r) => !mapping.isExcluded(r.kd_jenis_prw));
  const dilewati = all.filter((r) => mapping.isExcluded(r.kd_jenis_prw)).map((r) => ({ kd_jenis_prw: r.kd_jenis_prw, nama: r.nm_perawatan }));
  const items = [];
  for (const r of rows) {
    const ex = await db.risOne('SELECT * FROM ris_orders WHERE noorder=? AND kd_jenis_prw=?', [r.noorder, r.kd_jenis_prw]);
    if (!ex) {
      const o = await createOrder(r);
      await orders.addEvent(o.id, 'KIRIM_KHANZA', 'Dikirim dari SIMRS Khanza', actor);
      items.push(brief(o, true));
    } else if (['CANCELLED', 'DISCONTINUED'].includes(ex.status)) {
      const o = await orders.setStatus(ex.id, 'SCHEDULED', { actor, force: true, detail: 'Dikirim ulang dari Khanza' });
      orders.bus.emit('order.created', o); // kirim ulang ORM HL7
      items.push(brief(o, true));
    } else {
      items.push(brief(ex, false));
    }
  }
  const kd = new Set(rows.map((r) => r.kd_jenis_prw));
  const gone = await db.risQuery("SELECT * FROM ris_orders WHERE noorder=? AND status='SCHEDULED'", [noorder]);
  for (const g of gone.filter((g) => !kd.has(g.kd_jenis_prw))) {
    await orders.setStatus(g.id, 'CANCELLED', { actor, detail: mapping.isExcluded(g.kd_jenis_prw) ? 'Bukan pemeriksaan (BHP/cetak film)' : 'Item tidak ada lagi di permintaan Khanza' });
  }
  const baru = items.filter((i) => i.baru).length;
  const lewat = dilewati.length ? `. Dilewati (bukan pemeriksaan): ${dilewati.map((d) => d.nama || d.kd_jenis_prw).join(', ')}` : '';
  log.info(`Kirim dari Khanza ${noorder}: ${baru} baru, ${items.length - baru} sudah ada, ${dilewati.length} dilewati`);
  if (!rows.length) {
    return { ok: false, noorder, items, dilewati, message: `Permintaan ${noorder} hanya berisi BHP/cetak film, tidak ada pemeriksaan yang dikirim ke alat` };
  }
  return {
    ok: true, noorder, items, dilewati,
    message: (baru
      ? `${baru} pemeriksaan terkirim ke RIS dan siap di worklist alat`
      : 'Permintaan ini sudah ada di RIS (tidak ada perubahan)') + lewat,
  };
}

/** Batalkan order dari Khanza (seluruh noorder atau satu kd_jenis_prw). Hanya yang belum dikerjakan. */
async function cancelOrder(noorder, kdJenisPrw = null, actor = 'khanza') {
  const rows = await db.risQuery(
    `SELECT * FROM ris_orders WHERE noorder=? ${kdJenisPrw ? 'AND kd_jenis_prw=?' : ''}`, kdJenisPrw ? [noorder, kdJenisPrw] : [noorder]);
  if (!rows.length) throw Object.assign(new Error(`Order ${noorder} tidak ada di RIS`), { status: 404 });
  const items = [];
  for (const o of rows) {
    if (o.status === 'SCHEDULED') {
      const u = await orders.setStatus(o.id, 'CANCELLED', { actor, detail: 'Dibatalkan dari SIMRS Khanza' });
      items.push({ ...brief(u, false), dibatalkan: true });
    } else {
      items.push({ ...brief(o, false), dibatalkan: false, alasan: o.status === 'CANCELLED' ? 'sudah batal' : 'sudah diperiksa/diproses' });
    }
  }
  const n = items.filter((i) => i.dibatalkan).length;
  return { ok: n > 0, noorder, items, message: n ? `${n} pemeriksaan dibatalkan & dihapus dari worklist alat` : 'Tidak ada yang bisa dibatalkan (sudah diperiksa atau sudah batal)' };
}

/** Batalkan order BHP/non-pemeriksaan yang terlanjur masuk sebelum aturan ini (hanya yang masih Terjadwal). */
async function cancelExcluded() {
  const rows = await db.risQuery("SELECT id, noorder, kd_jenis_prw FROM ris_orders WHERE status='SCHEDULED'");
  let n = 0;
  for (const o of rows.filter((x) => mapping.isExcluded(x.kd_jenis_prw))) {
    await orders.setStatus(o.id, 'CANCELLED', { actor: 'system', detail: 'Bukan pemeriksaan (BHP/cetak film), dihapus dari worklist alat' });
    n++;
  }
  if (n) log.info(`${n} order BHP/non-pemeriksaan dibatalkan dari worklist`);
  return n;
}

let timer = null;
function start() {
  if (config.sync.mode !== 'auto') {
    log.info('Mode kirim MANUAL: order masuk saat dikirim dari Khanza (POST /api/khanza/order)');
    return;
  }
  const tick = () => syncOnce().catch(() => {}).finally(() => { timer = setTimeout(tick, config.sync.intervalMs); });
  tick();
  log.info(`Sinkron Khanza otomatis setiap ${config.sync.intervalMs / 1000} detik (lookback ${config.sync.lookbackDays} hari)`);
}
const stop = () => timer && clearTimeout(timer);
const status = () => ({ mode: config.sync.mode, running, lastRun, lastError, lastCount });

module.exports = { syncOnce, start, stop, status, createOrder, pushOrder, cancelOrder, cancelExcluded };
