-- =====================================================================
--  Hak akses MINIMAL user RIS di database SIMRS Khanza (sik).
--  Jalankan di server MySQL Khanza sebagai root. Ganti IP & password.
-- =====================================================================
CREATE USER IF NOT EXISTS 'ris_bridge'@'192.168.1.%' IDENTIFIED BY 'GANTI_PASSWORD_KUAT';

-- Baca order & master
GRANT SELECT ON sik.permintaan_radiologi              TO 'ris_bridge'@'192.168.1.%';
GRANT SELECT ON sik.permintaan_pemeriksaan_radiologi  TO 'ris_bridge'@'192.168.1.%';
GRANT SELECT ON sik.jns_perawatan_radiologi           TO 'ris_bridge'@'192.168.1.%';
GRANT SELECT ON sik.reg_periksa                       TO 'ris_bridge'@'192.168.1.%';
GRANT SELECT ON sik.pasien                            TO 'ris_bridge'@'192.168.1.%';
GRANT SELECT ON sik.dokter                            TO 'ris_bridge'@'192.168.1.%';
GRANT SELECT ON sik.pegawai                           TO 'ris_bridge'@'192.168.1.%';
GRANT SELECT ON sik.poliklinik                        TO 'ris_bridge'@'192.168.1.%';
GRANT SELECT ON sik.penjab                            TO 'ris_bridge'@'192.168.1.%';
GRANT SELECT ON sik.kamar_inap                        TO 'ris_bridge'@'192.168.1.%';
GRANT SELECT ON sik.kamar                             TO 'ris_bridge'@'192.168.1.%';
GRANT SELECT ON sik.bangsal                           TO 'ris_bridge'@'192.168.1.%';
GRANT SELECT ON sik.satu_sehat_encounter              TO 'ris_bridge'@'192.168.1.%';  -- jika modul Satu Sehat Khanza dipakai

-- Tulis status & hasil
GRANT UPDATE (tgl_sampel, jam_sampel, tgl_hasil, jam_hasil) ON sik.permintaan_radiologi TO 'ris_bridge'@'192.168.1.%';
GRANT SELECT, INSERT, UPDATE ON sik.hasil_radiologi   TO 'ris_bridge'@'192.168.1.%';
GRANT SELECT, INSERT ON sik.gambar_radiologi          TO 'ris_bridge'@'192.168.1.%';
GRANT SELECT ON sik.periksa_radiologi                 TO 'ris_bridge'@'192.168.1.%';

-- HANYA jika KHANZA_WRITE_PERIKSA=true (RIS membuat baris tarif/billing)
-- GRANT INSERT ON sik.periksa_radiologi              TO 'ris_bridge'@'192.168.1.%';

-- HANYA jika AUTH_MODE=khanza (login memakai akun SIMRS)
-- GRANT SELECT ON sik.user                           TO 'ris_bridge'@'192.168.1.%';

FLUSH PRIVILEGES;
