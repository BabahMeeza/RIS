'use strict';
const db = require('../lib/db');
const khanza = require('../khanza/khanzaRepo');
const config = require('../config');

const MODALITIES = {
  CR: 'Computed Radiography', DX: 'Digital Radiography', CT: 'Computed Tomography', MR: 'Magnetic Resonance',
  US: 'Ultrasound', MG: 'Mammography', RF: 'Radio Fluoroscopy', XA: 'X-Ray Angiography', NM: 'Nuclear Medicine',
  PT: 'PET', OT: 'Other', IO: 'Intra-oral Radiography', PX: 'Panoramic X-Ray', BMD: 'Bone Densitometry',
};

/** Tebak modalitas dari nama pemeriksaan bila belum dipetakan (agar order tetap masuk worklist). */
function guessModality(name = '') {
  const n = name.toUpperCase();
  if (/\b(CT|CT-SCAN|CTSCAN|MSCT)\b|CT SCAN/.test(n)) return 'CT';
  if (/\bMRI?\b/.test(n)) return 'MR';
  if (/USG|ULTRASO|DOPPLER|ECHO/.test(n)) return 'US';
  if (/MAMMO/.test(n)) return 'MG';
  if (/PANORAMI|OPG/.test(n)) return 'PX';
  if (/DENTAL|PERIAPIKAL/.test(n)) return 'IO';
  if (/FLUORO|BNO.?IVP|IVP|COLON IN LOOP|OMD|HSG|ESOFAGOGRAFI|URETROGRAFI/.test(n)) return 'RF';
  return 'DX';
}

/**
 * Kamus bagian tubuh: kata kunci nama pemeriksaan Khanza (Indonesia/Latin/Inggris)
 *   -> DICOM Body Part Examined (PS3.16 Annex L) + SNOMED CT body structure.
 * Urutan penting: yang lebih spesifik (vertebra, sendi) didahulukan dari yang umum (thorax, kepala).
 */
const BODY_PARTS = [
  [/CERVICAL|SERVIKAL|CERVIKAL|\bVC\b/, 'CSPINE', '122494005', 'Cervical spine structure'],
  [/THORACAL|THORAKAL|TORAKAL|VERTEBRA\s*TH/, 'TSPINE', '122495006', 'Thoracic spine structure'],
  [/LUMB|\bVL\b/, 'LSPINE', '122496007', 'Lumbar spine structure'],
  [/SACR|COCCY|KOKSIGEUS/, 'SSPINE', '54735007', 'Bone structure of sacrum'],
  [/PANORAMI|\bOPG\b|DENTAL|GIGI|PERIAPIKAL|MANDIBUL|RAHANG|\bTMJ\b/, 'JAW', '661005', 'Jaw region structure'],
  [/SINUS|\bSPN\b|WATERS|NASAL|MASTOID|SCHEDEL|SKULL|CRANIUM|KRANIUM|CEPHAL|SEFAL/, 'SKULL', '89546000', 'Bone structure of cranium'],
  [/KEPALA|HEAD|BRAIN|OTAK/, 'HEAD', '69536005', 'Head structure'],
  [/CLAVICUL|KLAVIKUL/, 'CLAVICLE', '51299004', 'Bone structure of clavicle'],
  [/SHOULDER|BAHU|SCAPULA|SKAPULA/, 'SHOULDER', '16982005', 'Shoulder region structure'],
  [/ELBOW|CUBITI|CUBITUS|KUBITI|SIKU/, 'ELBOW', '127949000', 'Elbow region structure'],
  [/WRIST|CARPAL|KARPAL|PERGELANGAN\s*TANGAN/, 'WRIST', '74670003', 'Wrist region structure'],
  [/MANUS|HAND|TANGAN|DIGITI\s*MANUS|JARI\s*TANGAN|PHALANX\s*MANUS/, 'HAND', '85562004', 'Hand structure'],
  [/ANTEBRACHI|FOREARM|LENGAN\s*BAWAH/, 'ARM', '14975008', 'Forearm structure'],
  [/HUMERUS|LENGAN\s*ATAS|BRACHI/, 'ARM', '40983000', 'Upper arm structure'],
  [/\bHIP\b|COXAE|COXA\b/, 'HIP', '29836001', 'Hip region structure'],
  [/FEMUR|PAHA/, 'LEG', '71341001', 'Bone structure of femur'],
  [/GENU|KNEE|LUTUT|PATELLA/, 'KNEE', '72696002', 'Knee region structure'],
  [/CRURIS|KRURIS|TIBIA|FIBULA|TUNGKAI\s*BAWAH/, 'LEG', '30021000', 'Lower leg structure'],
  [/ANKLE|TALOCRURAL|PERGELANGAN\s*KAKI/, 'ANKLE', '344001', 'Ankle region structure'],
  [/PEDIS|FOOT|CALCANE|KALKANE|TELAPAK\s*KAKI|DIGITI\s*PEDIS/, 'FOOT', '56459004', 'Foot structure'],
  [/MAMMO|MAMMAE|MAMAE|BREAST|PAYUDARA/, 'BREAST', '76752008', 'Breast structure'],
  [/THYROID|TIROID|COLLI|LEHER|NECK/, 'NECK', '45048000', 'Neck structure'],
  [/JANTUNG|CARDIAC|HEART|ECHOCARD/, 'HEART', '80891009', 'Heart structure'],
  [/THORAX|THORAKS|TORAKS|DADA|CHEST|PULMO|PARU|COSTAE|IGA|STERNUM/, 'CHEST', '51185008', 'Thoracic structure'],
  [/PELVIS|PANGGUL|PELVIC|OBSTETRI|KANDUNGAN|UTERUS|PROSTAT|HSG|URETROGRAF|BULI|VESIKA/, 'PELVIS', '12921003', 'Pelvic structure'],
  [/ABDOMEN|BNO|\bIVP\b|PERUT|HEPAR|GINJAL|RENAL|KIDNEY|APPENDIK|APPENDIC|APENDIK|OMD|COLON|LAMBUNG|ESOFAG/, 'ABDOMEN', '113345001', 'Abdominal structure'],
];

/** Saran pemetaan otomatis dari nama pemeriksaan Khanza (tanpa LOINC: wajib dicek manual terhadap Terminologi SATUSEHAT). */
function suggestMap(kd, name = '') {
  const n = String(name).toUpperCase();
  const modality = guessModality(n);
  const bp = BODY_PARTS.find(([re]) => re.test(n));
  const laterality = /BILATERAL|KANAN\s*(DAN|&|\+)\s*KIRI|DEX.*SIN/.test(n) ? 'B'
    : /DEXTRA|DEKSTRA|\bDEX\b|KANAN|\bRIGHT\b/.test(n) ? 'R'
    : /SINISTRA|\bSIN\b|KIRI|\bLEFT\b/.test(n) ? 'L' : null;
  return {
    nm_perawatan: name,
    modality,
    body_part: bp ? bp[1] : null,
    snomed_bodysite_code: bp ? bp[2] : null,
    snomed_bodysite_display: bp ? bp[3] : null,
    laterality,
    contrast: /KONTRAS|CONTRAST|\bIVP\b|OMD|COLON IN LOOP|HSG|URETROGRAF|ESOFAGOGRAF/.test(n) && !/TANPA\s*KONTRAS|NON\s*KONTRAS|WITHOUT/.test(n) ? 1 : 0,
    // kode yang dipetakan di alat (Carestream "HIS/RIS Procedure Mapping") = kode Khanza
    protocol_code: String(kd).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 16),
    protocol_meaning: String(name).slice(0, 64),
    active: 1,
  };
}

/**
 * Petakan otomatis semua jenis pemeriksaan yang belum dipetakan (atau semua bila overwrite).
 * LOINC tidak diisi otomatis. Nilai yang sudah diisi manual tidak ditimpa kecuali overwrite=true.
 */
async function autoMapAll({ overwrite = false } = {}) {
  const rows = await listMerged();
  const done = [], noBodyPart = [];
  for (const r of rows) {
    if (r.orphan || (r.mapped && !overwrite)) continue;
    const s = suggestMap(r.kd_jenis_prw, r.nm_perawatan);
    const keep = r.map || {};
    // overwrite: tetap pertahankan LOINC/RadLex/alat default/kode nasional yang sudah diisi manual
    await saveMap(r.kd_jenis_prw, {
      ...s,
      loinc_code: keep.loinc_code || '', loinc_display: keep.loinc_display || '',
      radlex_code: keep.radlex_code || '', radlex_display: keep.radlex_display || '',
      default_ae_title: keep.default_ae_title || '', kode_nasional: keep.kode_nasional || '',
      protocol_code: keep.protocol_code || s.protocol_code, protocol_meaning: keep.protocol_meaning || s.protocol_meaning,
    });
    done.push(r.kd_jenis_prw);
    if (!s.body_part) noBodyPart.push(`${r.kd_jenis_prw} ${r.nm_perawatan}`);
  }
  return { mapped: done.length, total: rows.filter((r) => !r.orphan).length, noBodyPart };
}

const getMap = (kd) => db.risOne('SELECT * FROM ris_procedure_map WHERE kd_jenis_prw=?', [kd]);

/** true bila kd_jenis_prw bukan pemeriksaan (BHP/cetak film) -> tidak masuk worklist & tidak dipetakan. */
function isExcluded(kd) {
  const k = String(kd || '').toUpperCase();
  return config.sync.excludeKdPrefix.some((p) => k.startsWith(p));
}

/** Gabungan master Khanza + pemetaan RIS, untuk halaman pemetaan (tanpa item BHP/non-pemeriksaan). */
async function listMerged() {
  let [procs, maps] = await Promise.all([khanza.listProcedures(), db.risQuery('SELECT * FROM ris_procedure_map')]);
  const byKd = new Map(maps.map((m) => [m.kd_jenis_prw, m]));
  procs = procs.filter((p) => !isExcluded(p.kd_jenis_prw));
  const rows = procs.map((p) => ({ ...p, mapped: byKd.has(p.kd_jenis_prw), map: byKd.get(p.kd_jenis_prw) || null }));
  for (const m of maps) if (!isExcluded(m.kd_jenis_prw) && !procs.find((p) => p.kd_jenis_prw === m.kd_jenis_prw)) rows.push({ kd_jenis_prw: m.kd_jenis_prw, nm_perawatan: m.nm_perawatan, mapped: true, orphan: true, map: m });
  return rows;
}

const FIELDS = ['nm_perawatan', 'modality', 'default_ae_title', 'body_part', 'loinc_code', 'loinc_display', 'kode_nasional',
  'snomed_bodysite_code', 'snomed_bodysite_display', 'radlex_code', 'radlex_display', 'laterality',
  'protocol_code', 'protocol_meaning', 'contrast', 'active'];

async function saveMap(kd, data) {
  if (isExcluded(kd)) throw new Error(`${kd} bukan pemeriksaan (BHP/billing) sehingga tidak dipetakan`);
  if (!data.modality || !MODALITIES[data.modality]) throw new Error('Modalitas DICOM wajib diisi & valid');
  if (data.loinc_code && !/^\d{1,7}-\d$/.test(data.loinc_code)) throw new Error('Format kode LOINC tidak valid (contoh 24648-8)');
  if (data.snomed_bodysite_code && !/^\d{6,18}$/.test(data.snomed_bodysite_code)) throw new Error('Kode SNOMED CT harus angka (SCTID)');
  const row = {};
  for (const f of FIELDS) row[f] = data[f] === '' || data[f] === undefined ? null : data[f];
  row.contrast = data.contrast ? 1 : 0;
  row.active = data.active === undefined ? 1 : data.active ? 1 : 0;
  const cols = ['kd_jenis_prw', ...FIELDS];
  await db.risQuery(
    `INSERT INTO ris_procedure_map (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})
     ON DUPLICATE KEY UPDATE ${FIELDS.map((f) => `${f}=VALUES(${f})`).join(', ')}`,
    [kd, ...FIELDS.map((f) => row[f])]
  );
  return getMap(kd);
}

/** Pilih AE Title alat untuk sebuah order: default pemetaan, atau satu-satunya alat aktif bermodalitas sama. */
async function pickStation(map, modality) {
  if (map && map.default_ae_title) return map.default_ae_title;
  const group = modality === 'CR' || modality === 'DX' ? ['CR', 'DX'] : [modality];
  const rows = await db.risQuery(`SELECT ae_title FROM ris_modalities WHERE active=1 AND modality IN (${group.map(() => '?').join(',')})`, group);
  return rows.length === 1 ? rows[0].ae_title : null; // >1 alat: biarkan kosong, semua alat modalitas tsb melihatnya
}

module.exports = { suggestMap, autoMapAll, isExcluded, MODALITIES, guessModality, getMap, listMerged, saveMap, pickStation };
