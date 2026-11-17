'use strict';
/**
 * Pemetaan data RIS -> resource FHIR SATUSEHAT untuk alur radiologi:
 *   ServiceRequest (dengan Accession Number) -> [DICOM Router membuat ImagingStudy]
 *   -> Observation (temuan) -> DiagnosticReport (kesan)
 * Format identifier mengikuti Panduan Interoperabilitas SATUSEHAT (pemeriksaan penunjang radiologi).
 */
const config = require('../config');
const { toFhirDateTime, nowLocal } = require('../lib/util');

const ORG = () => config.satusehat.orgId;
const ACSN_SYSTEM = () => `http://sys-ids.kemkes.go.id/acsn/${ORG()}`;

function procedureCoding(o, map) {
  if (!map || !map.loinc_code) throw new Error(`Jenis pemeriksaan ${o.kd_jenis_prw} belum dipetakan ke kode LOINC`);
  return {
    coding: [{ system: 'http://loinc.org', code: map.loinc_code, display: map.loinc_display || o.procedure_name }],
    text: o.procedure_name,
  };
}

function serviceRequest(o, map, ctx) {
  const res = {
    resourceType: 'ServiceRequest',
    identifier: [
      // satu payload = satu kode pemeriksaan; noorder Khanza bisa berisi beberapa item -> diberi akhiran kode
      { system: `http://sys-ids.kemkes.go.id/servicerequest/${ORG()}`, value: ctx.multiItem ? `${o.noorder}-${o.kd_jenis_prw}` : o.noorder },
      {
        use: 'usual',
        type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'ACSN' }] },
        system: ACSN_SYSTEM(),
        value: o.dicom_accession || o.accession_number, // ACSN harus sama dengan AccessionNumber di gambar DICOM
      },
    ],
    status: 'active',
    intent: 'original-order',
    priority: o.priority === 'STAT' ? 'stat' : 'routine',
    category: [{ coding: [{ system: 'http://snomed.info/sct', code: '363679005', display: 'Imaging' }] }],
    code: procedureCoding(o, map),
    orderDetail: [
      { coding: [{ system: 'http://dicom.nema.org/resources/ontology/DCM', code: o.modality }], text: `Modality Code: ${o.modality}` },
      ...(o.station_ae ? [{ coding: [{ system: 'http://sys-ids.kemkes.go.id/ae-title', display: o.station_ae }] }] : []),
    ],
    subject: { reference: `Patient/${ctx.patientId}`, display: o.patient_name },
    encounter: { reference: `Encounter/${ctx.encounterId}` },
    occurrenceDateTime: toFhirDateTime(o.scheduled_at),
    authoredOn: toFhirDateTime(o.requested_at),
    requester: { reference: `Practitioner/${ctx.requesterId}`, display: o.referring_name || undefined },
    performer: ctx.performerId ? [{ reference: `Practitioner/${ctx.performerId}` }] : undefined,
    reasonCode: o.diagnosis ? [{ text: o.diagnosis }] : undefined,
    note: o.clinical_info ? [{ text: o.clinical_info }] : undefined,
  };
  if (map.snomed_bodysite_code) {
    res.bodySite = [{ coding: [{ system: 'http://snomed.info/sct', code: map.snomed_bodysite_code, display: map.snomed_bodysite_display || undefined }] }];
  }
  return JSON.parse(JSON.stringify(res)); // buang undefined
}

function observation(o, map, report, ctx) {
  return JSON.parse(JSON.stringify({
    resourceType: 'Observation',
    identifier: [{ system: `http://sys-ids.kemkes.go.id/observation/${ORG()}`, value: `${o.accession_number}-${report.version}` }],
    status: report.status === 'AMENDED' ? 'amended' : 'final',
    category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'imaging', display: 'Imaging' }] }],
    code: procedureCoding(o, map),
    subject: { reference: `Patient/${ctx.patientId}` },
    encounter: { reference: `Encounter/${ctx.encounterId}` },
    effectiveDateTime: toFhirDateTime(o.exam_started_at || o.images_at || o.scheduled_at),
    issued: toFhirDateTime(report.verified_at || nowLocal().dt),
    performer: [{ reference: `Practitioner/${ctx.radiologistId}` }],
    basedOn: [{ reference: `ServiceRequest/${o.ss_servicerequest_id}` }],
    derivedFrom: o.ss_imagingstudy_id ? [{ reference: `ImagingStudy/${o.ss_imagingstudy_id}` }] : undefined,
    bodySite: map.snomed_bodysite_code ? { coding: [{ system: 'http://snomed.info/sct', code: map.snomed_bodysite_code, display: map.snomed_bodysite_display || undefined }] } : undefined,
    valueString: String(report.findings || report.impression || '').trim(),
  }));
}

function diagnosticReport(o, map, report, ctx) {
  return JSON.parse(JSON.stringify({
    resourceType: 'DiagnosticReport',
    identifier: [{ system: `http://sys-ids.kemkes.go.id/diagnostic/${ORG()}/rad`, use: 'official', value: `${o.accession_number}-${report.version}` }],
    status: report.status === 'AMENDED' ? 'amended' : 'final',
    category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0074', code: 'RAD', display: 'Radiology' }] }],
    code: procedureCoding(o, map), // harus sama dengan ServiceRequest.code
    subject: { reference: `Patient/${ctx.patientId}` },
    encounter: { reference: `Encounter/${ctx.encounterId}` },
    effectiveDateTime: toFhirDateTime(o.exam_started_at || o.images_at || o.scheduled_at),
    issued: toFhirDateTime(report.verified_at || nowLocal().dt),
    performer: [{ reference: `Practitioner/${ctx.radiologistId}` }, { reference: `Organization/${ORG()}` }],
    basedOn: [{ reference: `ServiceRequest/${o.ss_servicerequest_id}` }],
    imagingStudy: o.ss_imagingstudy_id ? [{ reference: `ImagingStudy/${o.ss_imagingstudy_id}` }] : undefined,
    result: ctx.observationId ? [{ reference: `Observation/${ctx.observationId}` }] : undefined,
    conclusion: String(report.impression || '').trim() || undefined,
  }));
}

module.exports = { ACSN_SYSTEM, serviceRequest, observation, diagnosticReport };
