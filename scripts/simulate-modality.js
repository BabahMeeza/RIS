#!/usr/bin/env node
'use strict';
/**
 * SIMULATOR ALAT RADIOLOGI — untuk uji integrasi tanpa alat fisik.
 * Alur yang sama seperti CR/DX/CT sungguhan:
 *   1. C-FIND Modality Worklist ke RIS
 *   2. MPPS N-CREATE (IN PROGRESS)
 *   3. (opsional) C-STORE gambar sintetis ke PACS dengan Accession & Study UID dari worklist
 *   4. MPPS N-SET (COMPLETED)
 *
 * Contoh:
 *   node scripts/simulate-modality.js --ris 127.0.0.1:11113 --aec RISHANAU --aet CR_FUJI \
 *        [--accession HN2611030002] [--pacs 127.0.0.1:4242 --pacs-aec ORTHANC] [--list]
 *        [--pause 30] [--end DISCONTINUED]   (jeda sebelum selesai / simulasi pemeriksaan dibatalkan di alat)
 */
const dimse = require('dcmjs-dimse');
const { generateUid, nowLocal } = require('../src/lib/util');

const { Client, Dataset } = dimse;
dimse.log.setLevel('error');
const { CFindRequest, NCreateRequest, NSetRequest, CStoreRequest } = dimse.requests;
const { Status, SopClass, StorageClass } = dimse.constants;

const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]] : a), [])
);
const [risHost, risPort] = String(args.ris || '127.0.0.1:11113').split(':');
const AEC = args.aec || 'RISHANAU';
const AET = args.aet || 'CR_FUJI';

function run(requests, host, port, aet, aec) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    const out = [];
    for (const r of requests) {
      r.on('response', (res) => out.push(res));
      client.addRequest(r);
    }
    client.on('networkError', reject);
    client.on('associationRejected', (e) => reject(new Error('Asosiasi ditolak: ' + JSON.stringify(e))));
    client.on('closed', () => resolve(out));
    client.send(host, +port, aet, aec);
  });
}

const pn = (v) => (Array.isArray(v) ? (v[0] && v[0].Alphabetic) || '' : v || '');

(async () => {
  const today = nowLocal().dicomDate;
  // 1. Worklist
  const find = CFindRequest.createWorklistFindRequest({
    ScheduledProcedureStepSequence: [{ ScheduledStationAETitle: '', ScheduledProcedureStepStartDate: today, Modality: '', ScheduledProcedureStepID: '', ScheduledProcedureStepDescription: '' }],
  });
  const responses = await run([find], risHost, risPort, AET, AEC);
  const items = responses.filter((r) => r.getStatus() === Status.Pending).map((r) => r.getDataset().getElements());
  console.log(`[1] Worklist ${AET}: ${items.length} item`);
  for (const it of items) {
    const sps = it.ScheduledProcedureStepSequence[0];
    console.log(`    ${it.AccessionNumber}  ${pn(it.PatientName).padEnd(22)} RM ${it.PatientID}  ${sps.Modality}  ${it.RequestedProcedureDescription}`);
  }
  if (args.list || !items.length) return;

  const it = args.accession ? items.find((i) => i.AccessionNumber === args.accession) : items[0];
  if (!it) throw new Error('Accession tidak ada di worklist');
  const sps = it.ScheduledProcedureStepSequence[0];
  const mppsUid = generateUid();
  const seriesUid = generateUid();
  const sopUid = generateUid();
  const t0 = nowLocal();

  // 2. MPPS N-CREATE
  const nc = new NCreateRequest(SopClass.ModalityPerformedProcedureStep, mppsUid);
  nc.setDataset(new Dataset({
    ScheduledStepAttributesSequence: [{
      AccessionNumber: it.AccessionNumber, StudyInstanceUID: it.StudyInstanceUID,
      RequestedProcedureID: it.RequestedProcedureID, RequestedProcedureDescription: it.RequestedProcedureDescription,
      ScheduledProcedureStepID: sps.ScheduledProcedureStepID, ScheduledProcedureStepDescription: sps.ScheduledProcedureStepDescription,
    }],
    PatientName: pn(it.PatientName), PatientID: it.PatientID, PatientBirthDate: it.PatientBirthDate, PatientSex: it.PatientSex,
    PerformedStationAETitle: AET, PerformedProcedureStepID: 'PPS' + Date.now().toString().slice(-8),
    PerformedProcedureStepStartDate: t0.dicomDate, PerformedProcedureStepStartTime: t0.dicomTime,
    PerformedProcedureStepStatus: 'IN PROGRESS', PerformedProcedureStepDescription: it.RequestedProcedureDescription,
    Modality: sps.Modality, StudyID: '1', PerformedSeriesSequence: [],
  }));
  const r2 = await run([nc], risHost, risPort, AET, AEC);
  console.log(`[2] MPPS N-CREATE IN PROGRESS -> status 0x${r2[0].getStatus().toString(16)}`);

  // 3. C-STORE gambar sintetis
  let stored = 0;
  if (args.pacs) {
    const [ph, pp] = String(args.pacs).split(':');
    const rows = 256, cols = 256;
    const px = new Uint8Array(rows * cols);
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) px[y * cols + x] = (Math.hypot(x - 128, y - 128) < 90 ? 200 : 40) + ((x * y) % 17);
    const img = new Dataset({
      _meta: { TransferSyntaxUID: '1.2.840.10008.1.2.1' },
      SOPClassUID: StorageClass.ComputedRadiographyImageStorage, SOPInstanceUID: sopUid,
      StudyInstanceUID: it.StudyInstanceUID, SeriesInstanceUID: seriesUid, AccessionNumber: it.AccessionNumber,
      PatientName: pn(it.PatientName), PatientID: it.PatientID, PatientBirthDate: it.PatientBirthDate, PatientSex: it.PatientSex,
      StudyDate: t0.dicomDate, StudyTime: t0.dicomTime, Modality: sps.Modality === 'DX' ? 'CR' : sps.Modality,
      StudyDescription: it.RequestedProcedureDescription, SeriesNumber: '1', InstanceNumber: '1', StudyID: '1',
      Rows: rows, Columns: cols, BitsAllocated: 8, BitsStored: 8, HighBit: 7, PixelRepresentation: 0,
      SamplesPerPixel: 1, PhotometricInterpretation: 'MONOCHROME2', PixelData: [px.buffer],
      _vrMap: { PixelData: 'OB' },
    });
    const cs = new CStoreRequest(img);
    const r3 = await run([cs], ph, pp, AET, args['pacs-aec'] || 'ORTHANC');
    stored = r3[0] && r3[0].getStatus() === Status.Success ? 1 : 0;
    console.log(`[3] C-STORE ke PACS ${args.pacs} -> ${stored ? 'OK' : 'GAGAL'}`);
  }

  // 4. MPPS N-SET COMPLETED (atau --end DISCONTINUED = pemeriksaan dibatalkan di alat)
  if (args.pause) { console.log(`    ... jeda ${args.pause} detik (pemeriksaan berlangsung)`); await new Promise((r) => setTimeout(r, +args.pause * 1000)); }
  const endStatus = String(args.end || 'COMPLETED').toUpperCase() === 'DISCONTINUED' ? 'DISCONTINUED' : 'COMPLETED';
  const t1 = nowLocal();
  const ns = new NSetRequest(SopClass.ModalityPerformedProcedureStep, mppsUid);
  ns.setDataset(new Dataset({
    PerformedProcedureStepStatus: endStatus,
    PerformedProcedureStepEndDate: t1.dicomDate, PerformedProcedureStepEndTime: t1.dicomTime,
    ExposureDoseSequence: [{ KVP: '110', ExposureInuAs: '8000', RadiationMode: 'CONTINUOUS' }],
    PerformedSeriesSequence: [{
      SeriesInstanceUID: seriesUid, SeriesDescription: it.RequestedProcedureDescription, OperatorsName: 'Rudi Radiografer',
      PerformingPhysicianName: '', ProtocolName: 'PA', RetrieveAETitle: 'ORTHANC',
      ReferencedImageSequence: stored ? [{ ReferencedSOPClassUID: StorageClass.ComputedRadiographyImageStorage, ReferencedSOPInstanceUID: sopUid }] : [],
      ReferencedNonImageCompositeSOPInstanceSequence: [],
    }],
  }));
  const r4 = await run([ns], risHost, risPort, AET, AEC);
  console.log(`[4] MPPS N-SET ${endStatus} -> status 0x${r4[0].getStatus().toString(16)}`);
  console.log(`Selesai: accession ${it.AccessionNumber}, study ${it.StudyInstanceUID}`);
})().catch((e) => { console.error('ERROR:', e.message || e); process.exit(1); });
