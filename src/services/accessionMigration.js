'use strict';
/**
 * Ganti Accession Number order lama (mis. HNyymmddNNNN) ke format SIMRS Khanza
 * (noorder tanpa "PR" + kd_jenis_prw, tanpa titik/strip).
 * Hanya order yang AMAN diubah: Terjadwal, belum ada MPPS, belum ada gambar di PACS,
 * belum dikirim ke SATUSEHAT. Order lain tetap memakai accession lama karena
 * gambarnya sudah membawa nilai itu.
 */
const db = require('../lib/db');
const log = require('../lib/logger')('accession');
const orders = require('./orderService');

async function migrate({ apply = false, onLine = () => {} } = {}) {
  const rows = await db.risQuery('SELECT * FROM ris_orders ORDER BY id');
  let changed = 0, skipped = 0;
  for (const o of rows) {
    const ids = orders.khanzaIds(o.noorder, o.kd_jenis_prw);
    if (o.accession_number === ids.accession) continue;
    const safe = o.status === 'SCHEDULED' && !o.mpps_uid && !o.pacs_study_id && !o.ss_servicerequest_id;
    if (!safe) {
      skipped++;
      onLine(`LEWATI  ${o.accession_number} (${o.noorder}/${o.kd_jenis_prw}) status ${o.status} — sudah diproses, accession lama dipertahankan`);
      continue;
    }
    onLine(`${apply ? 'UBAH   ' : 'RENCANA'} ${o.accession_number} -> ${ids.accession}  (${o.patient_name}, ${o.procedure_name})`);
    if (apply) {
      const clash = await db.risOne('SELECT id FROM ris_orders WHERE accession_number=? AND id<>?', [ids.accession, o.id]);
      if (clash) { skipped++; onLine(`LEWATI  ${ids.accession} sudah dipakai order ${clash.id}`); continue; }
      await db.risQuery('UPDATE ris_orders SET accession_number=?, requested_procedure_id=?, sps_id=? WHERE id=?',
        [ids.accession, ids.rpId, ids.spsId, o.id]);
      await orders.addEvent(o.id, 'ACCESSION', `Accession ${o.accession_number} -> ${ids.accession} (format Khanza)`, 'migrasi');
      if (o.hl7_sent_at) {
        const hl7 = require('../hl7/hl7Service');
        await hl7.sendOrm(await orders.getById(o.id), 'XO').catch(() => {});
      }
    }
    changed++;
  }
  return { changed, skipped };
}

/** Dipanggil saat RIS start bila ACCESSION_FORMAT=khanza. */
async function autoMigrate() {
  try {
    const r = await migrate({ apply: true });
    if (r.changed) log.info(`${r.changed} order Terjadwal diganti ke accession format Khanza`);
  } catch (e) {
    log.error('Migrasi accession otomatis gagal', e);
  }
}

module.exports = { migrate, autoMigrate };
