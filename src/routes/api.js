'use strict';
const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const db = require('../lib/db');
const auth = require('../auth');
const orders = require('../services/orderService');
const sync = require('../services/orderSync');
const mapping = require('../services/mappingService');
const reports = require('../services/reportService');
const writeback = require('../services/khanzaWriteback');
const khanza = require('../khanza/khanzaRepo');
const orthanc = require('../pacs/orthanc');
const hl7 = require('../hl7/hl7Service');
const satusehat = require('../satusehat/satusehatService');
const scp = require('../dicom/scp');
const wl = require('../dicom/worklist');
const { nowLocal } = require('../lib/util');

const r = express.Router();
const A = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const { requireAuth, requireRole } = auth;

// ---------- auth ----------
r.post('/auth/login', A(async (req, res) => res.json(await auth.login(String(req.body.username || ''), String(req.body.password || '')))));
r.get('/public/info', (req, res) => res.json({ hospital: config.hospital, syncMode: config.sync.mode }));

// ---------- dipanggil SIMRS Khanza (tombol "Kirim ke RIS") ----------
// Header wajib: X-RIS-Key: <KHANZA_API_KEY>
function khanzaKey(req, res, next) {
  const key = config.khanzaApi.key;
  if (!key) return res.status(503).json({ ok: false, message: 'KHANZA_API_KEY belum diatur di .env RIS' });
  const ip = String(req.socket.remoteAddress || '').replace('::ffff:', '');
  if (config.khanzaApi.allow.length && !config.khanzaApi.allow.includes(ip)) {
    return res.status(403).json({ ok: false, message: `IP ${ip} tidak diizinkan (KHANZA_API_ALLOW)` });
  }
  const given = Buffer.from(String(req.headers['x-ris-key'] || ''));
  const want = Buffer.from(key);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
    return res.status(401).json({ ok: false, message: 'X-RIS-Key salah' });
  }
  next();
}
const actorOf = (req) => `khanza${req.body && req.body.user ? ':' + String(req.body.user).slice(0, 40) : ''}`;
r.post('/khanza/order', khanzaKey, A(async (req, res) => res.json(await sync.pushOrder(req.body.noorder, actorOf(req)))));
r.post('/khanza/cancel', khanzaKey, A(async (req, res) => res.json(await sync.cancelOrder(String(req.body.noorder || ''), req.body.kd_jenis_prw || null, actorOf(req)))));
r.get('/khanza/order/:noorder', khanzaKey, A(async (req, res) => {
  const rows = await db.risQuery(
    `SELECT o.kd_jenis_prw, o.procedure_name nama, o.accession_number accession, COALESCE(o.dicom_accession, o.accession_number) accession_alat, o.modality, o.station_ae station, o.status,
            o.images_count gambar, r.status expertise
       FROM ris_orders o LEFT JOIN ris_reports r ON r.order_id=o.id WHERE o.noorder=? ORDER BY o.id`, [req.params.noorder]);
  res.json({ ok: rows.length > 0, noorder: req.params.noorder, items: rows, message: rows.length ? '' : 'Belum dikirim ke RIS' });
}));

r.use(requireAuth);
r.get('/me', (req, res) => res.json(req.user));

// ---------- dashboard ----------
r.get('/dashboard', A(async (req, res) => {
  const date = req.query.date || nowLocal().date;
  const byStatus = await db.risQuery(
    'SELECT status, COUNT(*) n FROM ris_orders WHERE DATE(scheduled_at)=? GROUP BY status', [date]);
  const byModality = await db.risQuery(
    "SELECT modality, COUNT(*) n, SUM(status IN ('VERIFIED')) done FROM ris_orders WHERE DATE(scheduled_at)=? AND status<>'CANCELLED' GROUP BY modality", [date]);
  const pendingReport = await db.risOne(
    "SELECT COUNT(*) n FROM ris_orders WHERE status IN ('COMPLETED','REPORTED') AND scheduled_at >= ?", [date + ' 00:00:00']);
  const unmatched = await db.risOne('SELECT COUNT(*) n FROM ris_unmatched_studies WHERE resolved_order_id IS NULL');
  const ssError = await db.risOne("SELECT COUNT(*) n FROM ris_orders WHERE ss_error IS NOT NULL AND scheduled_at >= ?", [date + ' 00:00:00']);
  res.json({ date, byStatus, byModality, pendingReport: pendingReport.n, unmatched: unmatched.n, ssError: ssError.n });
}));

r.get('/health', A(async (req, res) => {
  const out = { time: nowLocal().dt, ris_db: false, khanza_db: false, orthanc: null, sync: sync.status(), dicom: { ...scp.stats, ae: config.dicom.aeTitle, port: config.dicom.port, enabled: config.dicom.enabled }, hl7: { enabled: config.hl7.enabled, listen: config.hl7.listenPort, out: config.hl7.outHost ? `${config.hl7.outHost}:${config.hl7.outPort}` : null }, satusehat: { enabled: config.satusehat.enabled, org: config.satusehat.orgId, auto: config.satusehat.auto } };
  try { await db.risQuery('SELECT 1'); out.ris_db = true; } catch (e) { out.ris_db_error = e.message; }
  try { await db.khanzaQuery('SELECT 1'); out.khanza_db = true; } catch (e) { out.khanza_db_error = e.message; }
  if (config.orthanc.enabled) {
    try { const s = await orthanc.system(); out.orthanc = { ok: true, version: s.Version, name: s.Name, ...orthanc.status() }; }
    catch (e) { out.orthanc = { ok: false, error: e.message, ...orthanc.status() }; }
  }
  res.json(out);
}));

// ---------- orders ----------
r.get('/orders', A(async (req, res) => {
  const rows = await orders.listOrders({
    dateFrom: req.query.from, dateTo: req.query.to, status: req.query.status, modality: req.query.modality, q: req.query.q,
  });
  res.json(rows);
}));

r.get('/orders/:id', A(async (req, res) => {
  const o = await orders.getById(req.params.id);
  if (!o) return res.status(404).json({ error: 'Order tidak ditemukan' });
  const [events, report, mpps, map] = await Promise.all([
    db.risQuery('SELECT * FROM ris_order_events WHERE order_id=? ORDER BY id DESC', [o.id]),
    reports.get(o.id),
    db.risQuery('SELECT sop_instance_uid, status, station_ae, started_at, ended_at, series_count, image_count, kvp, mas, dose FROM ris_mpps WHERE order_id=? ORDER BY started_at DESC', [o.id]),
    mapping.getMap(o.kd_jenis_prw),
  ]);
  const hist = report ? await reports.history(report.id) : [];
  res.json({ order: o, events, report, reportHistory: hist, mpps, map, viewerUrl: orthanc.viewerUrl(o) });
}));

r.patch('/orders/:id', requireRole('radiografer'), A(async (req, res) => {
  const allowed = {};
  for (const k of ['modality', 'station_ae', 'scheduled_at', 'priority', 'clinical_info']) if (req.body[k] !== undefined) allowed[k] = req.body[k] === '' ? null : req.body[k];
  if (allowed.priority && !['ROUTINE', 'STAT'].includes(allowed.priority)) throw new Error('Prioritas tidak valid');
  if (allowed.modality && !mapping.MODALITIES[allowed.modality]) throw new Error('Modalitas tidak valid');
  await orders.updateFields(req.params.id, allowed);
  await orders.addEvent(req.params.id, 'UPDATED', allowed, req.user.username);
  const o = await orders.getById(req.params.id);
  if (o.hl7_sent_at) hl7.sendOrm(o, 'XO').catch(() => {});
  res.json(o);
}));

r.post('/orders/:id/status', requireRole('radiografer'), A(async (req, res) => {
  const { status, note } = req.body;
  if (!['SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'].includes(status)) throw new Error('Status manual tidak diizinkan');
  const extra = {};
  if (status === 'IN_PROGRESS') extra.exam_started_at = nowLocal().dt;
  if (status === 'COMPLETED') extra.exam_ended_at = nowLocal().dt;
  if (status !== 'SCHEDULED') extra.radiographer = req.user.full_name;
  const o = await orders.setStatus(req.params.id, status, { actor: req.user.username, detail: note || 'Manual', force: true, extra });
  if (status === 'IN_PROGRESS' && config.khanza.writeSampel && o) {
    const n = nowLocal();
    await khanza.markSampel(o.noorder, n.date, n.time).catch((e) => orders.addEvent(o.id, 'KHANZA_ERROR', e.message));
  }
  res.json(o || (await orders.getById(req.params.id)));
}));

r.get('/orders/:id/mwl-preview', A(async (req, res) => {
  const o = await db.risOne(
    `SELECT o.*, m.loinc_code, m.loinc_display, m.body_part, m.protocol_code, m.protocol_meaning, st.station_name, st.room
       FROM ris_orders o LEFT JOIN ris_procedure_map m ON m.kd_jenis_prw=o.kd_jenis_prw LEFT JOIN ris_modalities st ON st.ae_title=o.station_ae WHERE o.id=?`, [req.params.id]);
  if (!o) return res.status(404).json({ error: 'Order tidak ditemukan' });
  res.json(wl.buildItem(o));
}));

r.get('/orders/:id/hl7-preview', A(async (req, res) => {
  const o = await orders.getById(req.params.id);
  res.type('text/plain').send((await hl7.buildOrm(o, 'NW')).msg.replace(/\r/g, '\n'));
}));
r.post('/orders/:id/hl7/send', requireRole('radiografer'), A(async (req, res) => res.json(await hl7.sendOrm(await orders.getById(req.params.id), req.body.control || 'NW'))));

// ---------- report / expertise ----------
r.put('/orders/:id/report', requireRole('radiolog'), A(async (req, res) => res.json(await reports.saveDraft(req.params.id, req.body, req.user))));
r.post('/orders/:id/report/verify', requireRole('radiolog'), A(async (req, res) => res.json(await reports.verify(req.params.id, req.user))));
r.post('/orders/:id/report/amend', requireRole('radiolog'), A(async (req, res) => res.json(await reports.amend(req.params.id, req.body, req.user))));
r.post('/orders/:id/khanza/writeback', requireRole('radiolog', 'radiografer'), A(async (req, res) => res.json(await writeback.writeHasil(req.params.id))));
r.post('/orders/:id/khanza/gambar', requireRole('radiografer'), A(async (req, res) => {
  const o = await orders.getById(req.params.id);
  if (!o.khanza_tgl_periksa) throw new Error('Tulis hasil ke Khanza terlebih dahulu');
  res.json({ files: await writeback.writeGambar(o, { tgl: o.khanza_tgl_periksa, jam: o.khanza_jam }) });
}));

// ---------- satusehat ----------
r.post('/orders/:id/satusehat/:action', requireRole('radiografer', 'radiolog'), A(async (req, res) => {
  if (!config.satusehat.enabled) throw new Error('SATUSEHAT belum diaktifkan (SATUSEHAT_ENABLED)');
  const fn = { servicerequest: satusehat.sendServiceRequest, forward: satusehat.forwardDicom, imagingstudy: satusehat.findImagingStudy, report: satusehat.sendReport }[req.params.action];
  if (!fn) return res.status(404).json({ error: 'Aksi tidak dikenal' });
  res.json(await fn(+req.params.id));
}));

// ---------- PACS ----------
r.post('/sync/now', requireRole('radiografer'), A(async (req, res) => {
  // mode manual: ambil satu noorder; mode auto / tanpa noorder: tarik semua permintaan lookback
  if (req.body && req.body.noorder) return res.json(await sync.pushOrder(req.body.noorder, req.user.username));
  res.json(await sync.syncOnce());
}));
r.get('/unmatched', A(async (req, res) => res.json(await db.risQuery('SELECT * FROM ris_unmatched_studies WHERE resolved_order_id IS NULL ORDER BY id DESC LIMIT 200'))));
r.get('/unmatched/:id/candidates', A(async (req, res) => {
  const u = await db.risOne('SELECT * FROM ris_unmatched_studies WHERE id=?', [req.params.id]);
  if (!u) return res.status(404).json({ error: 'Tidak ditemukan' });
  res.json(await db.risQuery(
    "SELECT * FROM ris_orders WHERE pacs_study_id IS NULL AND status<>'CANCELLED' AND (no_rkm_medis=? OR patient_name LIKE ?) ORDER BY scheduled_at DESC LIMIT 20",
    [u.patient_id, `%${String(u.patient_name || '').split('^')[0].trim()}%`]));
}));
r.post('/unmatched/:id/link', requireRole('radiografer'), A(async (req, res) => {
  const u = await db.risOne('SELECT * FROM ris_unmatched_studies WHERE id=?', [req.params.id]);
  if (!u) return res.status(404).json({ error: 'Tidak ditemukan' });
  res.json(await orthanc.linkStudy(+req.body.order_id, u.pacs_study_id, { fixTags: !!req.body.fix_tags, actor: req.user.username }));
}));
r.post('/unmatched/:id/ignore', requireRole('radiografer'), A(async (req, res) => {
  await db.risQuery('UPDATE ris_unmatched_studies SET resolved_order_id=0, resolved_by=?, resolved_at=NOW() WHERE id=?', [req.user.username, req.params.id]);
  res.json({ ok: true });
}));

// ---------- master: modalitas ----------
const MOD_FIELDS = ['ae_title', 'name', 'modality', 'room', 'ip_address', 'port', 'manufacturer', 'model', 'station_name', 'hl7_enabled', 'hl7_host', 'hl7_port', 'active'];
function cleanModality(b) {
  const row = {};
  for (const f of MOD_FIELDS) row[f] = b[f] === '' || b[f] === undefined ? null : b[f];
  row.ae_title = String(row.ae_title || '').trim(); // simpan persis seperti di alat (mis. "Eleva"); dicocokkan tanpa peduli besar/kecil
  if (!/^[A-Za-z0-9_\-. ]{1,16}$/.test(row.ae_title)) throw new Error('AE Title wajib 1-16 karakter (huruf/angka/_-.), sama persis dengan di alat');
  if (!mapping.MODALITIES[row.modality]) throw new Error('Kode modalitas DICOM tidak valid');
  if (!row.name) throw new Error('Nama alat wajib diisi');
  row.hl7_enabled = row.hl7_enabled ? 1 : 0;
  row.active = row.active === null ? 1 : row.active ? 1 : 0;
  return row;
}
r.get('/modalities', A(async (req, res) => res.json(await db.risQuery('SELECT * FROM ris_modalities ORDER BY modality, ae_title'))));
r.get('/modality-codes', (req, res) => res.json(mapping.MODALITIES));
r.post('/modalities', requireRole('admin'), A(async (req, res) => {
  const row = cleanModality(req.body);
  await db.risQuery(`INSERT INTO ris_modalities (${MOD_FIELDS.join(',')}) VALUES (${MOD_FIELDS.map(() => '?').join(',')})`, MOD_FIELDS.map((f) => row[f]));
  await scp.refreshStations();
  res.json({ ok: true });
}));
r.put('/modalities/:id', requireRole('admin'), A(async (req, res) => {
  const row = cleanModality(req.body);
  await db.risQuery(`UPDATE ris_modalities SET ${MOD_FIELDS.map((f) => `${f}=?`).join(',')} WHERE id=?`, [...MOD_FIELDS.map((f) => row[f]), req.params.id]);
  await scp.refreshStations();
  res.json({ ok: true });
}));
r.delete('/modalities/:id', requireRole('admin'), A(async (req, res) => {
  await db.risQuery('DELETE FROM ris_modalities WHERE id=?', [req.params.id]);
  await scp.refreshStations();
  res.json({ ok: true });
}));

// ---------- master: pemetaan prosedur ----------
r.get('/mapping', A(async (req, res) => res.json(await mapping.listMerged())));
r.post('/mapping/auto', requireRole('admin'), A(async (req, res) => res.json(await mapping.autoMapAll({ overwrite: !!(req.body && req.body.overwrite) }))));
r.get('/mapping/suggest/:kd', A(async (req, res) => res.json(mapping.suggestMap(req.params.kd, String(req.query.name || '')))));
r.put('/mapping/:kd', requireRole('admin'), A(async (req, res) => res.json(await mapping.saveMap(req.params.kd, req.body))));
r.delete('/mapping/:kd', requireRole('admin'), A(async (req, res) => {
  await db.risQuery('DELETE FROM ris_procedure_map WHERE kd_jenis_prw=?', [req.params.kd]);
  res.json({ ok: true });
}));

// ---------- template expertise ----------
r.get('/templates', A(async (req, res) => res.json(await db.risQuery('SELECT * FROM ris_report_templates ORDER BY modality, name'))));
r.post('/templates', requireRole('radiolog'), A(async (req, res) => {
  const { name, modality, kd_jenis_prw, findings, impression } = req.body;
  if (!name) throw new Error('Nama template wajib');
  await db.risQuery('INSERT INTO ris_report_templates (name, modality, kd_jenis_prw, findings, impression, created_by) VALUES (?,?,?,?,?,?)',
    [name, modality || null, kd_jenis_prw || null, findings || '', impression || '', req.user.username]);
  res.json({ ok: true });
}));
r.put('/templates/:id', requireRole('radiolog'), A(async (req, res) => {
  const { name, modality, kd_jenis_prw, findings, impression } = req.body;
  await db.risQuery('UPDATE ris_report_templates SET name=?, modality=?, kd_jenis_prw=?, findings=?, impression=? WHERE id=?',
    [name, modality || null, kd_jenis_prw || null, findings || '', impression || '', req.params.id]);
  res.json({ ok: true });
}));
r.delete('/templates/:id', requireRole('radiolog'), A(async (req, res) => {
  await db.risQuery('DELETE FROM ris_report_templates WHERE id=?', [req.params.id]);
  res.json({ ok: true });
}));

// ---------- pengguna ----------
r.get('/users', requireRole('admin'), A(async (req, res) => res.json(await db.risQuery('SELECT id, username, full_name, role, kd_dokter, nip, active, last_login_at FROM ris_users ORDER BY role, username'))));
r.get('/khanza/doctors', A(async (req, res) => res.json(await khanza.listDoctors())));
r.post('/users', requireRole('admin'), A(async (req, res) => {
  const { username, password, full_name, role, kd_dokter, nip } = req.body;
  if (!username || !full_name) throw new Error('Username & nama wajib');
  if (!['admin', 'radiografer', 'radiolog', 'viewer'].includes(role)) throw new Error('Role tidak valid');
  if (role === 'radiolog' && !kd_dokter) throw new Error('Radiolog wajib ditautkan ke kd_dokter Khanza');
  if (!password && config.auth.mode !== 'khanza') throw new Error('Password wajib');
  await db.risQuery('INSERT INTO ris_users (username, password_hash, full_name, role, kd_dokter, nip) VALUES (?,?,?,?,?,?)',
    [username, password ? await auth.hashPassword(password) : null, full_name, role, kd_dokter || null, nip || null]);
  res.json({ ok: true });
}));
r.put('/users/:id', requireRole('admin'), A(async (req, res) => {
  const { password, full_name, role, kd_dokter, nip, active } = req.body;
  if (role && !['admin', 'radiografer', 'radiolog', 'viewer'].includes(role)) throw new Error('Role tidak valid');
  await db.risQuery('UPDATE ris_users SET full_name=?, role=?, kd_dokter=?, nip=?, active=? WHERE id=?',
    [full_name, role, kd_dokter || null, nip || null, active ? 1 : 0, req.params.id]);
  if (password) await db.risQuery('UPDATE ris_users SET password_hash=? WHERE id=?', [await auth.hashPassword(password), req.params.id]);
  res.json({ ok: true });
}));

// ---------- log ----------
r.get('/logs/:kind', A(async (req, res) => {
  const t = { dicom: 'ris_dicom_log', hl7: 'ris_hl7_log', satusehat: 'ris_satusehat_log' }[req.params.kind];
  if (!t) return res.status(404).json({ error: 'Log tidak dikenal' });
  res.json(await db.risQuery(`SELECT * FROM ${t} ORDER BY id DESC LIMIT ${Math.min(+req.query.limit || 200, 1000)}`));
}));

// ---------- error handler ----------
// eslint-disable-next-line no-unused-vars
r.use((err, req, res, next) => {
  const status = err.status && err.status < 500 ? err.status : 400;
  res.status(status).json({ ok: false, error: err.message, message: err.message });
});

module.exports = r;
