-- =====================================================================
--  Migrasi: Accession Number format SIMRS Khanza
--  (noorder tanpa "PR" + kd_jenis_prw, bisa > 16 karakter)
--  Jalankan SEKALI pada database RIS yang sudah ada:
--    mysql --force -u root -p ris_hanau < db/migrations/2026-11-04_accession_khanza.sql
--  (--force: lanjut walau indeks sudah ada)
-- =====================================================================
ALTER TABLE ris_orders MODIFY accession_number VARCHAR(40) NOT NULL;
ALTER TABLE ris_orders ADD INDEX ix_sps (sps_id), ADD INDEX ix_rp (requested_procedure_id);
ALTER TABLE ris_mpps MODIFY accession_number VARCHAR(40) NULL;
