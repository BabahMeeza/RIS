#!/usr/bin/env node
'use strict';
/**
 * Ganti Accession Number order lama ke format SIMRS Khanza (noorder tanpa "PR" + kd_jenis_prw).
 * Catatan: RIS juga menjalankan ini otomatis saat start bila ACCESSION_FORMAT=khanza.
 *
 * Pemakaian:
 *   node scripts/migrate-accession-khanza.js          -> tampilkan rencana (tanpa mengubah)
 *   node scripts/migrate-accession-khanza.js --apply  -> jalankan
 */
const { migrate } = require('../src/services/accessionMigration');

(async () => {
  const apply = process.argv.includes('--apply');
  const r = await migrate({ apply, onLine: (l) => console.log(l) });
  console.log(`\n${apply ? 'Diubah' : 'Akan diubah'}: ${r.changed}, dilewati: ${r.skipped}${apply ? '' : '\nJalankan dengan --apply untuk menerapkan.'}`);
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
