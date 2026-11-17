'use strict';
/**
 * Modality Performed Procedure Step (PS3.4 Annex F) — status pemeriksaan dari alat.
 *   N-CREATE  IN PROGRESS  -> order IN_PROGRESS, Khanza tgl_sampel/jam_sampel
 *   N-SET     COMPLETED    -> order COMPLETED (+ jumlah gambar, kV/mAs/dosis)
 *   N-SET     DISCONTINUED -> order kembali SCHEDULED (muncul lagi di worklist)
 */
const db = require('../lib/db');
const config = require('../config');
const log = require('../lib/logger')('mpps');
const orders = require('./orderService');
const khanza = require('../khanza/khanzaRepo');
const { fromDicomDate, fromDicomTime, nowLocal } = require('../lib/util');

const first = (v) => (Array.isArray(v) ? v[0] : v);
const s = (v) => {
  v = first(v);
  if (v && typeof v === 'object') return v.Alphabetic || '';
  return v === undefined || v === null ? '' : String(v);
};
const dt = (d, t) => {
  const date = fromDicomDate(s(d));
  return date ? `${date} ${fromDicomTime(s(t)) || '00:00:00'}` : null;
};

function summarize(ds) {
  const series = Array.isArray(ds.PerformedSeriesSequence) ? ds.PerformedSeriesSequence : [];
  const images = series.reduce((n, se) => n + (Array.isArray(se.ReferencedImageSequence) ? se.ReferencedImageSequence.length : 0), 0);
  const operators = [...new Set(series.map((se) => s(se.OperatorsName) || s(se.PerformingPhysicianName)).filter(Boolean))];
  const exp = Array.isArray(ds.ExposureDoseSequence) ? ds.ExposureDoseSequence[0] || {} : {};
  return {
    seriesCount: series.length,
    imageCount: images,
    operator: operators.join(', ').replace(/\^/g, ' ').trim() || null,
    kvp: s(exp.KVP) || null,
    mas: exp.ExposureInuAs ? String(Math.round(Number(s(exp.ExposureInuAs)) / 1000 * 100) / 100) : null,
    dose: s(ds.ImageAndFluoroscopyAreaDoseProduct) || s(ds.EntranceDoseInmGy) || s(ds.TotalTimeOfFluoroscopy) || null,
  };
}

async function resolveOrder(ds) {
  const items = Array.isArray(ds.ScheduledStepAttributesSequence) ? ds.ScheduledStepAttributesSequence : [];
  const modality = s(ds.Modality);
  for (const it of items) {
    const found = await orders.resolveOrders({
      studyUid: s(it.StudyInstanceUID), spsId: s(it.ScheduledProcedureStepID), rpId: s(it.RequestedProcedureID),
      accession: s(it.AccessionNumber), modalities: modality ? [modality] : [],
    });
    if (found.length) return found.find((o) => o.status === 'SCHEDULED') || found[0];
  }
  return null;
}

async function onCreate(sopUid, ds, callingAe) {
  const order = await resolveOrder(ds);
  const status = s(ds.PerformedProcedureStepStatus) || 'IN PROGRESS';
  const started = dt(ds.PerformedProcedureStepStartDate, ds.PerformedProcedureStepStartTime) || nowLocal().dt;
  const acc = order ? order.accession_number : s((ds.ScheduledStepAttributesSequence || [])[0]?.AccessionNumber) || null;
  await db.risQuery(
    `INSERT INTO ris_mpps (sop_instance_uid, order_id, accession_number, status, station_ae, started_at, dataset)
     VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE status=VALUES(status), dataset=VALUES(dataset)`,
    [sopUid, order ? order.id : null, acc, status, callingAe, started, JSON.stringify(ds)]
  );
  if (!order) {
    log.warn(`MPPS ${sopUid} dari ${callingAe} tanpa order yang cocok (accession ${acc || '-'})`);
    return { matched: false };
  }
  await orders.setStatus(order.id, 'IN_PROGRESS', {
    actor: callingAe, detail: 'MPPS N-CREATE', extra: { mpps_uid: sopUid, exam_started_at: started },
  });
  if (config.khanza.writeSampel) {
    try {
      await khanza.markSampel(order.noorder, started.slice(0, 10), started.slice(11, 19));
    } catch (e) {
      await orders.addEvent(order.id, 'KHANZA_ERROR', 'Gagal update tgl_sampel: ' + e.message);
    }
  }
  return { matched: true, orderId: order.id };
}

async function onSet(sopUid, ds, callingAe) {
  const row = await db.risOne('SELECT * FROM ris_mpps WHERE sop_instance_uid=?', [sopUid]);
  if (!row) return { notFound: true };
  const prev = JSON.parse(row.dataset || '{}');
  const merged = { ...prev, ...ds };
  const status = s(merged.PerformedProcedureStepStatus) || row.status;
  const ended = dt(merged.PerformedProcedureStepEndDate, merged.PerformedProcedureStepEndTime);
  const sum = summarize(merged);
  await db.risQuery(
    `UPDATE ris_mpps SET status=?, ended_at=?, series_count=?, image_count=?, kvp=?, mas=?, dose=?, dataset=? WHERE sop_instance_uid=?`,
    [status, ended, sum.seriesCount, sum.imageCount, sum.kvp, sum.mas, sum.dose, JSON.stringify(merged), sopUid]
  );
  if (!row.order_id) return { matched: false };
  if (status === 'COMPLETED') {
    await orders.setStatus(row.order_id, 'COMPLETED', {
      actor: callingAe,
      detail: `MPPS selesai: ${sum.seriesCount} series, ${sum.imageCount} gambar`,
      extra: { exam_ended_at: ended || nowLocal().dt, ...(sum.operator ? { radiographer: sum.operator } : {}) },
    });
  } else if (status === 'DISCONTINUED') {
    const o = await orders.getById(row.order_id);
    if (o && o.status === 'IN_PROGRESS') {
      await orders.setStatus(row.order_id, 'SCHEDULED', { actor: callingAe, force: true, detail: 'MPPS DISCONTINUED – dijadwalkan ulang' });
    }
  }
  return { matched: true, status };
}

module.exports = { onCreate, onSet, summarize };
