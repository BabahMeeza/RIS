-- =====================================================================
--  RIS RSUD HANAU - Skema database RIS (terpisah dari database Khanza)
--  MySQL 5.7+ / MariaDB 10.3+
--  Jalankan:  mysql -u root -p < db/ris_schema.sql
-- =====================================================================
CREATE DATABASE IF NOT EXISTS ris_hanau CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
USE ris_hanau;

-- ---------------------------------------------------------------------
-- Master alat / modalitas radiologi (DICOM Application Entity)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ris_modalities (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  ae_title        VARCHAR(16)  NOT NULL UNIQUE,       -- AE Title alat (maks 16 karakter)
  name            VARCHAR(100) NOT NULL,              -- nama alat, mis. "CR Fuji Ruang 1"
  modality        VARCHAR(4)   NOT NULL,              -- kode DICOM: CR, DX, CT, MR, US, MG, RF, XA, NM, PT, OT
  room            VARCHAR(50)  NULL,
  ip_address      VARCHAR(45)  NULL,
  port            INT          NULL,
  manufacturer    VARCHAR(64)  NULL,
  model           VARCHAR(64)  NULL,
  station_name    VARCHAR(16)  NULL,                  -- Scheduled Station Name (opsional)
  hl7_enabled     TINYINT(1)   NOT NULL DEFAULT 0,    -- kirim ORM HL7 ke alat ini (alat non-MWL lewat gateway)
  hl7_host        VARCHAR(64)  NULL,
  hl7_port        INT          NULL,
  active          TINYINT(1)   NOT NULL DEFAULT 1,
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- Pemetaan standar: jenis pemeriksaan Khanza (jns_perawatan_radiologi)
--   -> modalitas DICOM, LOINC (Satu Sehat), SNOMED CT body site,
--      RadLex Playbook, BodyPartExamined DICOM, protokol alat
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ris_procedure_map (
  kd_jenis_prw            VARCHAR(15)  NOT NULL PRIMARY KEY,
  nm_perawatan            VARCHAR(100) NULL,           -- salinan nama dari Khanza (informasi)
  modality                VARCHAR(4)   NOT NULL,       -- DICOM Modality (CID 29)
  default_ae_title        VARCHAR(16)  NULL,           -- alat default; NULL = semua alat bermodalitas sama
  body_part               VARCHAR(16)  NULL,           -- DICOM Body Part Examined (0018,0015), mis. CHEST, HEAD, ABDOMEN
  loinc_code              VARCHAR(20)  NULL,           -- LOINC (ServiceRequest.code Satu Sehat)
  loinc_display           VARCHAR(200) NULL,
  kode_nasional           VARCHAR(30)  NULL,           -- Kode Pemeriksaan Penunjang Nasional (jika dipakai Satu Sehat)
  snomed_bodysite_code    VARCHAR(20)  NULL,           -- SNOMED CT body structure
  snomed_bodysite_display VARCHAR(200) NULL,
  radlex_code             VARCHAR(20)  NULL,           -- RadLex Playbook RPID (opsional)
  radlex_display          VARCHAR(200) NULL,
  laterality              VARCHAR(1)   NULL,           -- R / L / B (opsional)
  protocol_code           VARCHAR(16)  NULL,           -- Scheduled Protocol Code (sesuai protokol di alat)
  protocol_meaning        VARCHAR(64)  NULL,
  contrast                TINYINT(1)   NOT NULL DEFAULT 0,
  active                  TINYINT(1)   NOT NULL DEFAULT 1,
  updated_at              DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- Order RIS: satu baris = satu Requested Procedure (= satu Accession Number)
-- Sumber: permintaan_radiologi + permintaan_pemeriksaan_radiologi (Khanza)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ris_orders (
  id                      INT AUTO_INCREMENT PRIMARY KEY,
  noorder                 VARCHAR(20)  NOT NULL,
  kd_jenis_prw            VARCHAR(15)  NOT NULL,
  no_rawat                VARCHAR(17)  NOT NULL,
  no_rkm_medis            VARCHAR(15)  NOT NULL,
  patient_name            VARCHAR(100) NOT NULL,
  patient_sex             CHAR(1)      NULL,
  patient_birthdate       DATE         NULL,
  patient_nik             VARCHAR(20)  NULL,
  patient_address         VARCHAR(200) NULL,
  status_rawat            VARCHAR(10)  NULL,           -- ralan / ranap
  location                VARCHAR(100) NULL,           -- poli / bangsal asal
  penjamin                VARCHAR(60)  NULL,
  procedure_name          VARCHAR(100) NOT NULL,
  modality                VARCHAR(4)   NULL,
  station_ae              VARCHAR(16)  NULL,
  accession_number        VARCHAR(40)  NOT NULL,           -- format Khanza: noorder tanpa 'PR' + kd_jenis_prw
  dicom_accession         VARCHAR(16)  NULL,               -- accession untuk ALAT bila format Khanza > 16 karakter
  requested_procedure_id  VARCHAR(16)  NOT NULL,
  sps_id                  VARCHAR(16)  NOT NULL,
  study_instance_uid      VARCHAR(64)  NOT NULL,
  referring_kd_dokter     VARCHAR(20)  NULL,
  referring_name          VARCHAR(100) NULL,
  clinical_info           TEXT         NULL,
  diagnosis               VARCHAR(255) NULL,
  priority                VARCHAR(8)   NOT NULL DEFAULT 'ROUTINE',  -- ROUTINE / STAT
  requested_at            DATETIME     NOT NULL,
  scheduled_at            DATETIME     NOT NULL,
  status                  VARCHAR(16)  NOT NULL DEFAULT 'SCHEDULED',
      -- SCHEDULED, IN_PROGRESS, COMPLETED, DISCONTINUED, CANCELLED, REPORTED, VERIFIED
  mpps_uid                VARCHAR(64)  NULL,
  exam_started_at         DATETIME     NULL,
  exam_ended_at           DATETIME     NULL,
  radiographer            VARCHAR(100) NULL,
  pacs_study_id           VARCHAR(64)  NULL,           -- ID study di Orthanc
  images_count            INT          NOT NULL DEFAULT 0,
  images_at               DATETIME     NULL,
  khanza_tgl_periksa      DATE         NULL,           -- kunci periksa_radiologi/hasil_radiologi di Khanza
  khanza_jam              TIME         NULL,
  khanza_written_at       DATETIME     NULL,
  hl7_sent_at             DATETIME     NULL,
  ss_servicerequest_id    VARCHAR(64)  NULL,
  ss_imagingstudy_id      VARCHAR(64)  NULL,
  ss_observation_id       VARCHAR(64)  NULL,
  ss_diagnosticreport_id  VARCHAR(64)  NULL,
  ss_dicom_forwarded_at   DATETIME     NULL,
  ss_error                TEXT         NULL,
  created_at              DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at              DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_order_item (noorder, kd_jenis_prw),
  UNIQUE KEY uq_accession (accession_number),
  UNIQUE KEY ux_dicom_acc (dicom_accession),
  KEY ix_sps (sps_id),
  KEY ix_rp (requested_procedure_id),
  UNIQUE KEY uq_study_uid (study_instance_uid),
  KEY ix_status (status),
  KEY ix_sched (scheduled_at),
  KEY ix_rawat (no_rawat),
  KEY ix_rm (no_rkm_medis)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS ris_order_events (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  order_id    INT          NOT NULL,
  event       VARCHAR(40)  NOT NULL,
  detail      TEXT         NULL,
  actor       VARCHAR(64)  NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_order (order_id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- Expertise / hasil bacaan radiolog
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ris_reports (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  order_id              INT          NOT NULL UNIQUE,
  version               INT          NOT NULL DEFAULT 1,
  findings              MEDIUMTEXT   NULL,             -- uraian / temuan
  impression            TEXT         NULL,             -- kesan / kesimpulan
  status                VARCHAR(10)  NOT NULL DEFAULT 'DRAFT',  -- DRAFT / FINAL / AMENDED
  source                VARCHAR(10)  NOT NULL DEFAULT 'RIS',    -- RIS / HL7
  radiologist_kd_dokter VARCHAR(20)  NULL,
  radiologist_name      VARCHAR(100) NULL,
  created_by            VARCHAR(64)  NULL,
  verified_by           VARCHAR(64)  NULL,
  verified_at           DATETIME     NULL,
  created_at            DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS ris_report_history (
  id                    BIGINT AUTO_INCREMENT PRIMARY KEY,
  report_id             INT          NOT NULL,
  version               INT          NOT NULL,
  findings              MEDIUMTEXT   NULL,
  impression            TEXT         NULL,
  status                VARCHAR(10)  NOT NULL,
  radiologist_name      VARCHAR(100) NULL,
  changed_by            VARCHAR(64)  NULL,
  reason                VARCHAR(255) NULL,
  created_at            DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_report (report_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS ris_report_templates (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(100) NOT NULL,
  modality      VARCHAR(4)   NULL,
  kd_jenis_prw  VARCHAR(15)  NULL,
  findings      MEDIUMTEXT   NULL,
  impression    TEXT         NULL,
  created_by    VARCHAR(64)  NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- MPPS (Modality Performed Procedure Step) dari alat
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ris_mpps (
  sop_instance_uid  VARCHAR(64)  NOT NULL PRIMARY KEY,
  order_id          INT          NULL,
  accession_number  VARCHAR(40)  NULL,
  status            VARCHAR(16)  NOT NULL,          -- IN PROGRESS / COMPLETED / DISCONTINUED
  station_ae        VARCHAR(16)  NULL,
  started_at        DATETIME     NULL,
  ended_at          DATETIME     NULL,
  series_count      INT          NOT NULL DEFAULT 0,
  image_count       INT          NOT NULL DEFAULT 0,
  kvp               VARCHAR(16)  NULL,
  mas               VARCHAR(16)  NULL,
  dose              VARCHAR(32)  NULL,
  dataset           LONGTEXT     NULL,              -- JSON dataset terakhir
  created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY ix_order (order_id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- Study di PACS yang tidak cocok dengan order (perlu rekonsiliasi manual)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ris_unmatched_studies (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  pacs_study_id      VARCHAR(64)  NOT NULL UNIQUE,
  study_instance_uid VARCHAR(64)  NULL,
  accession_number   VARCHAR(64)  NULL,
  patient_id         VARCHAR(64)  NULL,
  patient_name       VARCHAR(128) NULL,
  study_date         VARCHAR(8)   NULL,
  modalities         VARCHAR(32)  NULL,
  description        VARCHAR(128) NULL,
  images_count       INT          NOT NULL DEFAULT 0,
  resolved_order_id  INT          NULL,
  resolved_by        VARCHAR(64)  NULL,
  resolved_at        DATETIME     NULL,
  created_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- Log integrasi
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ris_dicom_log (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  op          VARCHAR(16)  NOT NULL,     -- C-ECHO, C-FIND, N-CREATE, N-SET, ASSOC-REJECT
  calling_ae  VARCHAR(16)  NULL,
  peer_ip     VARCHAR(45)  NULL,
  detail      TEXT         NULL,
  results     INT          NULL,
  status      VARCHAR(16)  NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_created (created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS ris_hl7_log (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  direction   VARCHAR(3)   NOT NULL,     -- IN / OUT
  msg_type    VARCHAR(16)  NULL,
  control_id  VARCHAR(40)  NULL,
  peer        VARCHAR(64)  NULL,
  order_id    INT          NULL,
  message     MEDIUMTEXT   NULL,
  ack         TEXT         NULL,
  status      VARCHAR(16)  NULL,         -- OK / ERROR
  error       TEXT         NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_created (created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS ris_satusehat_log (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  order_id     INT          NULL,
  resource     VARCHAR(32)  NOT NULL,
  method       VARCHAR(8)   NOT NULL,
  url          VARCHAR(255) NULL,
  http_status  INT          NULL,
  request      LONGTEXT     NULL,
  response     LONGTEXT     NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_order (order_id)
) ENGINE=InnoDB;

-- Cache ID IHS Satu Sehat (pasien & praktisi) berdasarkan NIK
CREATE TABLE IF NOT EXISTS ris_ihs_cache (
  kind        VARCHAR(16)  NOT NULL,     -- Patient / Practitioner
  nik         VARCHAR(20)  NOT NULL,
  ihs_id      VARCHAR(64)  NOT NULL,
  name        VARCHAR(100) NULL,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (kind, nik)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- Pengguna, pengaturan, counter
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ris_users (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  username       VARCHAR(64)  NOT NULL UNIQUE,
  password_hash  VARCHAR(100) NULL,                 -- NULL jika login memakai akun Khanza
  full_name      VARCHAR(100) NOT NULL,
  role           VARCHAR(16)  NOT NULL DEFAULT 'radiografer', -- admin / radiografer / radiolog / viewer
  kd_dokter      VARCHAR(20)  NULL,                 -- wajib untuk radiolog (kd_dokter di Khanza)
  nip            VARCHAR(20)  NULL,                 -- NIP petugas di Khanza (untuk periksa_radiologi.nip)
  active         TINYINT(1)   NOT NULL DEFAULT 1,
  last_login_at  DATETIME     NULL,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS ris_settings (
  k  VARCHAR(64) NOT NULL PRIMARY KEY,
  v  TEXT        NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS ris_counters (
  k  VARCHAR(32) NOT NULL PRIMARY KEY,
  v  INT         NOT NULL
) ENGINE=InnoDB;

-- =====================================================================
-- Data awal pemetaan (CONTOH). Sesuaikan kd_jenis_prw dengan master
-- jns_perawatan_radiologi di Khanza RSUD Hanau, lalu verifikasi kode
-- terhadap file Terminologi Radiologi Satu Sehat / loinc.org.
-- =====================================================================
INSERT IGNORE INTO ris_procedure_map
 (kd_jenis_prw, nm_perawatan, modality, body_part, loinc_code, loinc_display,
  snomed_bodysite_code, snomed_bodysite_display, protocol_code, protocol_meaning)
VALUES
 ('RAD001','Thorax PA','DX','CHEST','24648-8','XR Chest PA upright','51185008','Thoracic structure','THX_PA','Thorax PA'),
 ('RAD002','CT Scan Kepala Tanpa Kontras','CT','HEAD','30799-1','CT Head WO contrast','69536005','Head structure','CT_HEAD_NC','CT Head Non Contrast'),
 ('RAD003','USG Abdomen','US','ABDOMEN','24558-9','US Abdomen','113345001','Abdominal structure','US_ABD','USG Abdomen');

INSERT IGNORE INTO ris_report_templates (name, modality, findings, impression) VALUES
 ('Thorax Normal','DX',
  'Cor: bentuk dan ukuran normal, CTR < 50%.\nPulmo: corakan bronkovaskular normal, tidak tampak infiltrat maupun nodul.\nSinus kostofrenikus kanan dan kiri lancip.\nDiafragma kanan dan kiri licin.\nTulang-tulang intak.',
  'Cor dan pulmo dalam batas normal.'),
 ('USG Abdomen Normal','US',
  'Hepar: ukuran normal, tepi tajam, ekostruktur homogen, tidak tampak lesi fokal.\nKandung empedu: dinding tidak menebal, tidak tampak batu.\nPankreas dan lien: normal.\nGinjal kanan dan kiri: ukuran normal, tidak tampak batu maupun hidronefrosis.\nVesika urinaria: dinding licin, tidak tampak batu.',
  'USG abdomen dalam batas normal.');
