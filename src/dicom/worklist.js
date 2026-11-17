'use strict';
/**
 * DICOM Modality Worklist (PS3.4 Annex K) — pembentukan dataset & pencocokan kunci C-FIND.
 * Atribut mengikuti IHE Radiology Scheduled Workflow (SWF).
 */
const db = require('../lib/db');
const config = require('../config');
const { nowLocal, addDays, toDicomName, toDicomPhysician, dcmText, dcmCs, dcmAe, dcmDate, dcmTime, isDicomUid } = require('../lib/util');

const CODING_LOINC = 'LN';
const CODING_LOCAL = '99RSHANAU';

// Grup modalitas yang dianggap setara saat mencocokkan (alat CR sering dijadwalkan sebagai DX & sebaliknya)
const EQUIV = { CR: ['CR', 'DX'], DX: ['DX', 'CR'] };

const str = (v) => {
  if (Array.isArray(v)) v = v[0];
  if (v === undefined || v === null) return '';
  if (typeof v === 'object') return String(v.Alphabetic ?? '').trim(); // PN ternaturalisasi
  return String(v).trim();
};
const isWildAll = (v) => !v || /^\*+$/.test(v);
const wildToLike = (v) => v.replace(/[%_]/g, '\\$&').replace(/\*/g, '%').replace(/\?/g, '_');

/** Ambil kunci pencarian dari dataset C-FIND (naturalized dcmjs). */
function extractQuery(ds) {
  const spsSeq = ds.ScheduledProcedureStepSequence;
  const sps = (Array.isArray(spsSeq) ? spsSeq[0] : spsSeq) || {};
  return {
    modality: str(sps.Modality),
    stationAe: str(sps.ScheduledStationAETitle),
    date: str(sps.ScheduledProcedureStepStartDate),
    patientId: str(ds.PatientID),
    accession: str(ds.AccessionNumber),
    patientName: str(ds.PatientName).replace(/\^+$/, ''),
    studyUid: str(ds.StudyInstanceUID),
    rpId: str(ds.RequestedProcedureID),
  };
}

function parseDateRange(v) {
  if (isWildAll(v)) return null;
  const m = v.match(/^(\d{8})?(-)?(\d{8})?$/);
  if (!m) return null;
  const fmt = (s) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  if (!m[2]) return { from: fmt(m[1]), to: fmt(m[1]) };
  return { from: m[1] ? fmt(m[1]) : null, to: m[3] ? fmt(m[3]) : null };
}

/** Cari order yang cocok untuk C-FIND. callingStation = baris ris_modalities milik AE pemanggil (boleh null). */
async function findOrders(query, callingStation, stationsByAe = new Map()) {
  // Hanya yang masih menunggu diperiksa; yang sedang/sudah diperiksa tidak dikirim ulang ke alat
  const where = [config.dicom.hideStarted ? "o.status = 'SCHEDULED'" : "o.status IN ('SCHEDULED','IN_PROGRESS')"];
  const p = [];

  const range = parseDateRange(query.date);
  if (range) {
    if (range.from) { where.push('o.scheduled_at >= ?'); p.push(range.from + ' 00:00:00'); }
    if (range.to) { where.push('o.scheduled_at <= ?'); p.push(range.to + ' 23:59:59'); }
  } else {
    const today = nowLocal().date;
    where.push('o.scheduled_at >= ?'); p.push(addDays(today, -(config.dicom.defaultDays - 1)) + ' 00:00:00');
    where.push('o.scheduled_at <= ?'); p.push(today + ' 23:59:59');
  }

  if (!isWildAll(query.modality)) {
    const mods = EQUIV[query.modality] || [query.modality];
    where.push(`o.modality IN (${mods.map(() => '?').join(',')})`); p.push(...mods);
  }
  // Filter stasiun: AE yang diminta di kunci SPS, atau (default) AE pemanggil.
  // Order tanpa AE tujuan ikut tampil di semua alat bermodalitas sama.
  const station = !isWildAll(query.stationAe)
    ? stationsByAe.get(query.stationAe.toUpperCase()) || { ae_title: query.stationAe, modality: null }
    : config.dicom.filterByCallingAe ? callingStation : null;
  if (station) {
    if (station.modality) {
      const mods = EQUIV[station.modality] || [station.modality];
      where.push(`(o.station_ae = ? OR ((o.station_ae IS NULL OR o.station_ae = '') AND o.modality IN (${mods.map(() => '?').join(',')})))`);
      p.push(station.ae_title, ...mods);
    } else {
      where.push("(o.station_ae = ? OR o.station_ae IS NULL OR o.station_ae = '')"); p.push(station.ae_title);
    }
  }
  for (const [val, cols] of [[query.patientId, ['o.no_rkm_medis']], [query.accession, ['o.dicom_accession', 'o.accession_number']], [query.studyUid, ['o.study_instance_uid']], [query.rpId, ['o.requested_procedure_id']]]) {
    if (isWildAll(val)) continue;
    const like = /[*?]/.test(val);
    where.push(`(${cols.map((c) => (like ? `${c} LIKE ?` : `${c} = ?`)).join(' OR ')})`);
    cols.forEach(() => p.push(like ? wildToLike(val) : val));
  }
  if (!isWildAll(query.patientName)) {
    where.push('o.patient_name LIKE ?');
    p.push(/[*?]/.test(query.patientName) ? wildToLike(query.patientName.replace(/\^/g, ' ')) : `%${query.patientName.replace(/\^/g, ' ')}%`);
  }

  return db.risQuery(
    `SELECT o.*, m.loinc_code, m.loinc_display, m.body_part, m.protocol_code, m.protocol_meaning,
            st.name AS station_name_full, st.station_name, st.room
       FROM ris_orders o
       LEFT JOIN ris_procedure_map m ON m.kd_jenis_prw = o.kd_jenis_prw
       LEFT JOIN ris_modalities st ON st.ae_title = o.station_ae
      WHERE ${where.join(' AND ')}
      ORDER BY (o.priority='STAT') DESC, o.scheduled_at LIMIT 500`,
    p
  );
}

/**
 * Dataset MWL lengkap untuk satu order. SEMUA nilai dibersihkan sesuai VR DICOM (PS3.5 tabel 6.2)
 * supaya alat tidak menolak / error: ASCII saja, tanpa backslash & karakter kontrol, panjang dipotong,
 * tanggal/jam divalidasi. Atribut wajib (Type 1) yang rusak -> lempar error, item dilewati (bukan seluruh worklist).
 */
function buildItem(o, { callingAe = '' } = {}) {
  const SH = (v) => dcmText(v, 16);
  const LO = (v) => dcmText(v, 64);
  const acc = SH(o.dicom_accession || o.accession_number);
  const procName = LO(o.procedure_name) || LO(o.kd_jenis_prw) || 'PEMERIKSAAN';
  if (!isDicomUid(o.study_instance_uid)) throw new Error(`Study Instance UID tidak valid: ${o.study_instance_uid}`);
  if (!acc) throw new Error('Accession kosong');
  if (String(o.dicom_accession || o.accession_number).length > 16) throw new Error(`Accession ${o.accession_number} > 16 karakter`);
  const patientId = LO(o.no_rkm_medis);
  if (!patientId) throw new Error('No. RM kosong');
  const modality = dcmCs(o.modality) || 'OT';

  const code = (value, scheme, meaning) => ({ CodeValue: SH(value) || '-', CodingSchemeDesignator: SH(scheme), CodeMeaning: LO(meaning) || procName });
  // Kode yang dipetakan di alat (mis. Carestream "HIS/RIS Procedure Mapping") harus stabil:
  // default kd_jenis_prw Khanza. MWL_PROCEDURE_CODE=loinc -> pakai LOINC bila sudah dipetakan.
  const procCode = config.dicom.procedureCode === 'loinc' && o.loinc_code
    ? code(o.loinc_code, CODING_LOINC, o.loinc_display || o.procedure_name)
    : code(o.kd_jenis_prw, CODING_LOCAL, o.procedure_name);
  const protocol = code(o.protocol_code || o.kd_jenis_prw, CODING_LOCAL, o.protocol_meaning || o.procedure_name);
  const referring = toDicomPhysician(o.referring_name || '');
  const nik = String(o.patient_nik || '').replace(/[^0-9]/g, '').slice(0, 64);
  const schedDate = dcmDate(o.scheduled_at) || nowLocal().dicomDate; // Type 1: wajib terisi
  const schedTime = dcmTime(o.scheduled_at) || '000000';
  // Scheduled Station AE Title = Type 1 (PS3.4 K.6.1.2.2): tidak boleh kosong. Order tanpa alat tujuan ->
  // isi AE alat yang sedang bertanya (alat Philips menolak item dengan atribut Type 1 kosong).
  const stationAe = dcmAe(o.station_ae) || dcmAe(callingAe) || dcmAe(config.dicom.aeTitle);

  return {
    SpecificCharacterSet: 'ISO_IR 100', // nilai sudah ASCII murni, kompatibel dengan semua alat
    AccessionNumber: acc,
    ReferringPhysicianName: referring,
    PatientName: toDicomName(o.patient_name, config.dicom.nameUppercase) || patientId,
    PatientID: patientId,
    IssuerOfPatientID: LO(config.hospital.code),
    PatientBirthDate: dcmDate(o.patient_birthdate),
    PatientSex: ['M', 'F', 'O'].includes(o.patient_sex) ? o.patient_sex : 'O',
    OtherPatientIDsSequence: nik ? [{ PatientID: nik, IssuerOfPatientID: 'NIK', TypeOfPatientID: 'TEXT' }] : [],
    AdmissionID: LO(o.no_rawat),
    CurrentPatientLocation: LO(o.location),
    StudyInstanceUID: o.study_instance_uid,
    RequestingPhysician: referring,
    RequestedProcedureDescription: procName,
    RequestedProcedureCodeSequence: [procCode],
    RequestedProcedureID: SH(o.requested_procedure_id) || acc,
    RequestedProcedurePriority: o.priority === 'STAT' ? 'STAT' : 'ROUTINE',
    ReasonForTheRequestedProcedure: LO(o.diagnosis),
    MedicalAlerts: LO(o.clinical_info),
    PregnancyStatus: 4, // US enum 1-4; 4 = unknown (nilai 0 tidak sah, ditolak alat Philips)
    ScheduledProcedureStepSequence: [
      {
        Modality: modality,
        ScheduledStationAETitle: stationAe,
        ScheduledStationName: SH(o.station_name),
        ScheduledProcedureStepLocation: SH(o.room),
        ScheduledProcedureStepStartDate: schedDate,
        ScheduledProcedureStepStartTime: schedTime,
        ScheduledPerformingPhysicianName: '',
        ScheduledProcedureStepDescription: procName,
        ScheduledProtocolCodeSequence: [protocol],
        ScheduledProcedureStepID: SH(o.sps_id) || acc,
        ScheduledProcedureStepStatus: o.status === 'IN_PROGRESS' ? 'STARTED' : 'SCHEDULED',
      },
    ],
  };
}

// Atribut VR angka yang mungkin diminta alat dan tidak kami isi
const NUMERIC_KEYS = new Set(['PregnancyStatus', 'NumberOfStudyRelatedSeries', 'NumberOfStudyRelatedInstances', 'NumberOfPatientRelatedStudies', 'SmokingStatus']);

const isSeq = (v) => Array.isArray(v) && v.length > 0 && v[0] && typeof v[0] === 'object' && !('Alphabetic' in v[0]);

/**
 * Proyeksi: kembalikan hanya atribut yang diminta SCU (PS3.4 C.4.1.2.3).
 * Kunci sekuens kosong / tanpa item -> seluruh item dikembalikan.
 */
function project(template, full) {
  const out = { SpecificCharacterSet: full.SpecificCharacterSet };
  for (const k of Object.keys(template || {})) {
    if (k.startsWith('_') || k === 'SpecificCharacterSet') continue;
    const t = template[k];
    const v = full[k];
    if (isSeq(v)) {
      const tItem = Array.isArray(t) && t[0] && typeof t[0] === 'object' ? t[0] : null;
      out[k] = tItem && Object.keys(tItem).filter((x) => !x.startsWith('_')).length
        ? v.map((it) => { const r = project(tItem, it); delete r.SpecificCharacterSet; return r; })
        : v;
    } else if (v !== undefined) {
      out[k] = v;
    } else if (Array.isArray(t)) {
      out[k] = []; // sequence / multi-nilai kosong
    } else if (typeof t === 'number' || NUMERIC_KEYS.has(k)) {
      continue; // VR angka (US/UL/SS/FL/FD): jangan kirim 0 palsu, lebih aman dihilangkan
    } else {
      out[k] = ''; // atribut teks yang tidak kami miliki -> panjang nol (Type 2)
    }
  }
  return out;
}

module.exports = { extractQuery, parseDateRange, findOrders, buildItem, project };
