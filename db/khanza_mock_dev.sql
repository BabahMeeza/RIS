-- =====================================================================
--  HANYA UNTUK DEVELOPMENT / UJI COBA.
--  Subset tabel SIMRS Khanza (database `sik`) yang dipakai RIS, dengan
--  kolom yang relevan saja. JANGAN dijalankan di server Khanza produksi.
-- =====================================================================
CREATE DATABASE IF NOT EXISTS sik_dev CHARACTER SET latin1;
USE sik_dev;

CREATE TABLE IF NOT EXISTS pasien (
  no_rkm_medis VARCHAR(15) PRIMARY KEY, nm_pasien VARCHAR(40), no_ktp VARCHAR(20),
  jk ENUM('L','P'), tmp_lahir VARCHAR(15), tgl_lahir DATE, alamat VARCHAR(200), no_peserta VARCHAR(25)
);
CREATE TABLE IF NOT EXISTS dokter (kd_dokter VARCHAR(20) PRIMARY KEY, nm_dokter VARCHAR(50));
CREATE TABLE IF NOT EXISTS pegawai (nik VARCHAR(20) PRIMARY KEY, nama VARCHAR(50), no_ktp VARCHAR(20));
CREATE TABLE IF NOT EXISTS petugas (nip VARCHAR(20) PRIMARY KEY, nama VARCHAR(50));
CREATE TABLE IF NOT EXISTS poliklinik (kd_poli CHAR(5) PRIMARY KEY, nm_poli VARCHAR(50));
CREATE TABLE IF NOT EXISTS penjab (kd_pj CHAR(3) PRIMARY KEY, png_jawab VARCHAR(30));
CREATE TABLE IF NOT EXISTS bangsal (kd_bangsal CHAR(5) PRIMARY KEY, nm_bangsal VARCHAR(30));
CREATE TABLE IF NOT EXISTS kamar (kd_kamar VARCHAR(15) PRIMARY KEY, kd_bangsal CHAR(5));
CREATE TABLE IF NOT EXISTS kamar_inap (no_rawat VARCHAR(17), kd_kamar VARCHAR(15), tgl_masuk DATE, jam_masuk TIME, stts_pulang VARCHAR(20) DEFAULT '-');
CREATE TABLE IF NOT EXISTS reg_periksa (
  no_reg VARCHAR(8), no_rawat VARCHAR(17) PRIMARY KEY, tgl_registrasi DATE, jam_reg TIME,
  kd_dokter VARCHAR(20), no_rkm_medis VARCHAR(15), kd_poli CHAR(5), kd_pj CHAR(3), status_lanjut ENUM('Ralan','Ranap')
);
CREATE TABLE IF NOT EXISTS jns_perawatan_radiologi (
  kd_jenis_prw VARCHAR(15) PRIMARY KEY, nm_perawatan VARCHAR(80), bagian_rs DOUBLE, bhp DOUBLE,
  tarif_perujuk DOUBLE, tarif_tindakan_dokter DOUBLE, tarif_tindakan_petugas DOUBLE, kso DOUBLE,
  menejemen DOUBLE, total_byr DOUBLE, kd_pj CHAR(3), status ENUM('0','1') DEFAULT '1', kelas VARCHAR(20) DEFAULT '-'
);
CREATE TABLE IF NOT EXISTS permintaan_radiologi (
  noorder VARCHAR(15) PRIMARY KEY, no_rawat VARCHAR(17), tgl_permintaan DATE, jam_permintaan TIME,
  tgl_sampel DATE, jam_sampel TIME, tgl_hasil DATE, jam_hasil TIME, dokter_perujuk VARCHAR(20),
  status ENUM('ralan','ranap'), informasi_tambahan VARCHAR(60), diagnosa_klinis VARCHAR(80)
);
CREATE TABLE IF NOT EXISTS permintaan_pemeriksaan_radiologi (
  noorder VARCHAR(15), kd_jenis_prw VARCHAR(15), stts_bayar ENUM('Sudah','Belum') DEFAULT 'Belum',
  PRIMARY KEY (noorder, kd_jenis_prw)
);
CREATE TABLE IF NOT EXISTS periksa_radiologi (
  no_rawat VARCHAR(17), nip VARCHAR(20), kd_jenis_prw VARCHAR(15), tgl_periksa DATE, jam TIME,
  dokter_perujuk VARCHAR(20), bagian_rs DOUBLE, bhp DOUBLE, tarif_perujuk DOUBLE, tarif_tindakan_dokter DOUBLE,
  tarif_tindakan_petugas DOUBLE, kso DOUBLE, menejemen DOUBLE, biaya DOUBLE, kd_dokter VARCHAR(20),
  status ENUM('Ralan','Ranap'), proyeksi VARCHAR(50), kV VARCHAR(10), mAS VARCHAR(10), FFD VARCHAR(10),
  BSF VARCHAR(10), inak VARCHAR(10), jml_penyinaran VARCHAR(10), dosis VARCHAR(20),
  PRIMARY KEY (no_rawat, kd_jenis_prw, tgl_periksa, jam)
);
CREATE TABLE IF NOT EXISTS hasil_radiologi (
  no_rawat VARCHAR(17), tgl_periksa DATE, jam TIME, hasil TEXT, PRIMARY KEY (no_rawat, tgl_periksa, jam)
);
CREATE TABLE IF NOT EXISTS gambar_radiologi (
  no_rawat VARCHAR(17), tgl_periksa DATE, jam TIME, lokasi_gambar VARCHAR(500),
  PRIMARY KEY (no_rawat, tgl_periksa, jam, lokasi_gambar(200))
);
CREATE TABLE IF NOT EXISTS satu_sehat_encounter (no_rawat VARCHAR(17) PRIMARY KEY, id_encounter VARCHAR(40));
CREATE TABLE IF NOT EXISTS user (id_user VARBINARY(100), password VARBINARY(100));

-- Data contoh
INSERT IGNORE INTO pasien VALUES
 ('000123','BUDI SANTOSO, TN','6207010101800001','L','KUALA PEMBUANG','1980-01-01','JL. AHMAD YANI NO. 5','0001234567890'),
 ('000124','SITI AMINAH, NY','6207014505850002','P','SERUYAN','1985-05-05','DESA HANAU','0001234567891');
INSERT IGNORE INTO dokter VALUES ('D001','dr. Andi Pratama, Sp.PD'),('D002','dr. Rina Wulandari, Sp.Rad');
INSERT IGNORE INTO pegawai VALUES ('D001','dr. Andi Pratama, Sp.PD','6207010000000011'),('D002','dr. Rina Wulandari, Sp.Rad','6207010000000022');
INSERT IGNORE INTO petugas VALUES ('P001','Rudi Radiografer');
INSERT IGNORE INTO poliklinik VALUES ('U0001','Poli Penyakit Dalam'),('IGDK','IGD');
INSERT IGNORE INTO penjab VALUES ('BPJ','BPJS Kesehatan'),('A09','Umum');
INSERT IGNORE INTO bangsal VALUES ('B01','Bangsal Melati');
INSERT IGNORE INTO kamar VALUES ('K01','B01');
INSERT IGNORE INTO jns_perawatan_radiologi VALUES
 ('RAD001','Thorax PA',20000,10000,5000,40000,20000,0,5000,100000,'-','1','-'),
 ('RAD002','CT Scan Kepala Tanpa Kontras',100000,50000,20000,300000,100000,0,30000,600000,'-','1','-'),
 ('RAD003','USG Abdomen',30000,10000,10000,100000,30000,0,20000,200000,'-','1','-');
INSERT IGNORE INTO user VALUES (AES_ENCRYPT('radiologi','nur'), AES_ENCRYPT('rahasia','windi'));
