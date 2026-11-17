'use strict';
const path = require('path');
require('dotenv').config({ quiet: true, path: process.env.RIS_ENV_FILE || path.join(__dirname, '..', '.env') });

const env = (k, d = '') => {
  const v = process.env[k];
  if (v === undefined || v === '') return d;
  return String(v).replace(/\s+#.*$/, '').trim(); // izinkan komentar di belakang nilai
};
const bool = (k, d = false) => {
  const v = env(k, d ? 'true' : 'false').toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
};
const int = (k, d) => parseInt(env(k, String(d)), 10);

process.env.TZ = env('TZ', 'Asia/Jakarta');

const config = {
  tz: process.env.TZ,
  hospital: {
    name: env('HOSPITAL_NAME', 'RSUD HANAU'),
    address: env('HOSPITAL_ADDRESS', ''),
    code: env('HOSPITAL_CODE', 'RSUDHANAU'),
  },
  http: { port: int('HTTP_PORT', 8090) },
  auth: {
    mode: env('AUTH_MODE', 'local'),
    jwtSecret: env('JWT_SECRET', 'dev-secret-ganti'),
    tokenHours: int('JWT_HOURS', 12),
  },
  risDb: {
    host: env('RIS_DB_HOST', '127.0.0.1'), port: int('RIS_DB_PORT', 3306),
    user: env('RIS_DB_USER', 'root'), password: env('RIS_DB_PASS', ''), database: env('RIS_DB_NAME', 'ris_hanau'),
  },
  khanzaDb: {
    host: env('KHANZA_DB_HOST', '127.0.0.1'), port: int('KHANZA_DB_PORT', 3306),
    user: env('KHANZA_DB_USER', 'root'), password: env('KHANZA_DB_PASS', ''), database: env('KHANZA_DB_NAME', 'sik'),
  },
  sync: {
    // manual = order masuk hanya saat dikirim dari Khanza (tombol "Kirim ke RIS" -> POST /api/khanza/order)
    // auto   = RIS menarik permintaan_radiologi dari Khanza setiap SYNC_INTERVAL_MS
    mode: env('SYNC_MODE', 'manual').toLowerCase(),
    intervalMs: int('SYNC_INTERVAL_MS', 15000),
    lookbackDays: int('SYNC_LOOKBACK_DAYS', 2),
    // khanza = format modul Orthanc SIMRS Khanza: noorder tanpa "PR" + kd_jenis_prw
    //          (PR20261104004 + J000081 -> 20261104004J000081; titik/strip dibuang: BHP.02 -> BHP02)
    // ris    = dibuat RIS: ACCESSION_PREFIX + yymmdd + 4 digit
    accessionFormat: env('ACCESSION_FORMAT', 'khanza').toLowerCase(),
    accessionPrefix: env('ACCESSION_PREFIX', 'HN'),
    // kd_jenis_prw yang BUKAN pemeriksaan (mis. BHP = billing cetak film/kontras): tidak dikirim ke alat & tidak dipetakan
    excludeKdPrefix: env('SYNC_EXCLUDE_KD', 'BHP').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
  },
  khanzaApi: {
    key: env('KHANZA_API_KEY', ''),                                   // kunci rahasia yang dikirim Khanza di header X-RIS-Key
    allow: env('KHANZA_API_ALLOW', '').split(',').map((s) => s.trim()).filter(Boolean), // IP yang boleh (kosong = semua)
  },
  khanza: {
    writeSampel: bool('KHANZA_WRITE_SAMPEL', true),
    writeHasil: bool('KHANZA_WRITE_HASIL', true),
    writePeriksa: bool('KHANZA_WRITE_PERIKSA', false),
    defaultNip: env('KHANZA_DEFAULT_NIP', '-'),
    writeGambar: bool('KHANZA_WRITE_GAMBAR', false),
    gambarDir: env('KHANZA_GAMBAR_DIR', ''),
    gambarPrefix: env('KHANZA_GAMBAR_PREFIX', 'pages/upload/'),
  },
  dicom: {
    enabled: bool('DICOM_ENABLED', true),
    aeTitle: env('DICOM_AE_TITLE', 'RISHANAU'),
    port: int('DICOM_PORT', 11113),
    acceptUnknownAe: bool('DICOM_ACCEPT_UNKNOWN_AE', false),
    filterByCallingAe: bool('MWL_FILTER_BY_CALLING_AE', true),
    defaultDays: int('MWL_DEFAULT_DAYS', 1),
    // true = pasien yang sudah mulai diperiksa (MPPS IN PROGRESS / tombol Mulai) tidak dikirim lagi saat alat query ulang.
    // Bila pemeriksaan dibatalkan di alat (MPPS DISCONTINUED) atau "Jadwal Ulang" di RIS, pasien muncul lagi.
    hideStarted: bool('MWL_HIDE_STARTED', true),
    // Kode Requested Procedure yang dikirim ke alat: khanza = kd_jenis_prw (stabil untuk mapping di alat), loinc = kode LOINC
    procedureCode: env('MWL_PROCEDURE_CODE', 'khanza').toLowerCase(),
    nameUppercase: bool('DICOM_NAME_UPPERCASE', true),
    // Diagnosa: simpan query C-FIND dari alat + jawaban RIS (file .dcm & .json) ke folder ini. Kosong = mati.
    dumpDir: env('DICOM_DUMP_DIR', ''),
  },
  hl7: {
    enabled: bool('HL7_ENABLED', true),
    listenPort: int('HL7_LISTEN_PORT', 2575),
    outHost: env('HL7_OUT_HOST', ''),
    outPort: int('HL7_OUT_PORT', 2576),
    sendingApp: env('HL7_SENDING_APP', 'RIS_HANAU'),
    receivingApp: env('HL7_RECEIVING_APP', 'PACS'),
    version: env('HL7_VERSION', '2.3.1'),
    oruAsFinal: bool('HL7_ORU_AS_FINAL', false),
  },
  orthanc: {
    enabled: bool('ORTHANC_ENABLED', true),
    url: env('ORTHANC_URL', 'http://127.0.0.1:8042').replace(/\/$/, ''),
    user: env('ORTHANC_USER', ''), pass: env('ORTHANC_PASS', ''),
    pollMs: int('ORTHANC_POLL_MS', 10000),
    replayHistory: bool('ORTHANC_REPLAY_HISTORY', false),
    viewerTemplate: env('VIEWER_URL_TEMPLATE', ''),
  },
  satusehat: {
    enabled: bool('SATUSEHAT_ENABLED', false),
    authUrl: env('SATUSEHAT_AUTH_URL', '').replace(/\/$/, ''),
    baseUrl: env('SATUSEHAT_BASE_URL', '').replace(/\/$/, ''),
    clientId: env('SATUSEHAT_CLIENT_ID', ''),
    clientSecret: env('SATUSEHAT_CLIENT_SECRET', ''),
    orgId: env('SATUSEHAT_ORG_ID', ''),
    auto: bool('SATUSEHAT_AUTO', true),
    intervalMs: int('SATUSEHAT_INTERVAL_MS', 60000),
    routerModality: env('SATUSEHAT_ROUTER_MODALITY', ''),
  },
};

module.exports = config;
