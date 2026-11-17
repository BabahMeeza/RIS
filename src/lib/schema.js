'use strict';
/**
 * Penyesuaian skema otomatis saat RIS start (idempoten), supaya instalasi lama
 * tidak perlu menjalankan file migrasi secara manual.
 */
const db = require('./db');
const log = require('./logger')('schema');

async function columnLength(table, column) {
  const r = await db.risOne(
    `SELECT CHARACTER_MAXIMUM_LENGTH len FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`, [table, column]);
  return r ? Number(r.len) : null;
}

async function hasIndex(table, name) {
  const r = await db.risOne(
    `SELECT 1 x FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`, [table, name]);
  return !!r;
}

async function ensureSchema() {
  const steps = [
    // 2026-11-04: Accession format Khanza (noorder tanpa PR + kd_jenis_prw) bisa > 16 karakter
    async () => {
      if ((await columnLength('ris_orders', 'accession_number')) < 40) {
        await db.risQuery('ALTER TABLE ris_orders MODIFY accession_number VARCHAR(40) NOT NULL');
        return 'ris_orders.accession_number -> VARCHAR(40)';
      }
    },
    async () => {
      if ((await columnLength('ris_mpps', 'accession_number')) < 40) {
        await db.risQuery('ALTER TABLE ris_mpps MODIFY accession_number VARCHAR(40) NULL');
        return 'ris_mpps.accession_number -> VARCHAR(40)';
      }
    },
    async () => {
      if (!(await hasIndex('ris_orders', 'ix_sps'))) { await db.risQuery('ALTER TABLE ris_orders ADD INDEX ix_sps (sps_id)'); return 'indeks ix_sps'; }
    },
    async () => {
      if (!(await hasIndex('ris_orders', 'ix_rp'))) { await db.risQuery('ALTER TABLE ris_orders ADD INDEX ix_rp (requested_procedure_id)'); return 'indeks ix_rp'; }
    },
    // 2026-11-04: Accession untuk ALAT maks 16 karakter (DICOM SH); accession_number tetap format Khanza
    async () => {
      if ((await columnLength('ris_orders', 'dicom_accession')) === null) {
        await db.risQuery('ALTER TABLE ris_orders ADD COLUMN dicom_accession VARCHAR(16) NULL AFTER accession_number, ADD UNIQUE INDEX ux_dicom_acc (dicom_accession)');
        return 'kolom ris_orders.dicom_accession';
      }
    },
  ];
  for (const step of steps) {
    try {
      const done = await step();
      if (done) log.info(`Skema diperbarui: ${done}`);
    } catch (e) {
      log.error('Gagal memperbarui skema (jalankan db/migrations secara manual)', e);
    }
  }
}

module.exports = { ensureSchema };
