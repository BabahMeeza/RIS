/* RIS RSUD Hanau — antarmuka web (vanilla JS, tanpa build step) */
'use strict';

// ---------------------------------------------------------------- utilities
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const fmtDt = (s) => (s ? String(s).slice(0, 16).replace('T', ' ') : '-');
const fmtTime = (s) => (s ? String(s).slice(11, 16) : '');
const age = (b) => {
  if (!b) return '';
  const d = new Date(b), n = new Date();
  let y = n.getFullYear() - d.getFullYear();
  if (n < new Date(n.getFullYear(), d.getMonth(), d.getDate())) y--;
  return y >= 1 ? `${y} th` : `${Math.max(0, Math.floor((n - d) / 2.6e9))} bln`;
};
const STATUS = {
  SCHEDULED: 'Terjadwal', IN_PROGRESS: 'Diperiksa', COMPLETED: 'Selesai periksa', REPORTED: 'Draft expertise',
  VERIFIED: 'Terverifikasi', CANCELLED: 'Batal', DISCONTINUED: 'Dihentikan',
};
const pill = (st) => `<span class="pill st-${esc(st)}">${esc(STATUS[st] || st)}</span>`;
const dot = (ok, err) => `<span class="${err ? 'err-dot' : ok ? 'ok-dot' : 'no-dot'}"></span>`;

const state = { token: localStorage.getItem('ris_token'), user: null, hospital: {}, modCodes: {}, filters: { from: today(), to: today(), status: '', modality: '', q: '' } };

function toast(msg, err = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (err ? ' err' : '');
  t.textContent = msg;
  $('#toast').appendChild(t);
  setTimeout(() => t.remove(), err ? 7000 : 3500);
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && path !== '/auth/login') { logout(); throw new Error('Sesi berakhir'); }
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
}
const act = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };
const can = (...roles) => state.user && (state.user.role === 'admin' || roles.includes(state.user.role));

function modal(title, bodyHtml, { onSave, saveText = 'Simpan', wide = false } = {}) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal" style="${wide ? 'width:min(980px,100%)' : ''}">
    <div class="card-h"><span>${esc(title)}</span><button class="btn sm" data-x>✕</button></div>
    <div class="card-b">${bodyHtml}</div>
    ${onSave ? `<div class="foot"><button class="btn" data-x>Batal</button><button class="btn primary" data-save>${esc(saveText)}</button></div>` : ''}
  </div>`;
  const close = () => bg.remove();
  bg.addEventListener('click', (e) => { if (e.target === bg || e.target.hasAttribute('data-x')) close(); });
  if (onSave) $('[data-save]', bg).onclick = act(async () => { if ((await onSave(bg)) !== false) close(); });
  document.body.appendChild(bg);
  return bg;
}
const formData = (el) => Object.fromEntries($$('[name]', el).map((i) => [i.name, i.type === 'checkbox' ? i.checked : i.value]));

// ---------------------------------------------------------------- shell
function logout() { localStorage.removeItem('ris_token'); state.token = null; state.user = null; renderLogin(); }

function renderLogin() {
  $('#root').innerHTML = `<div class="login-wrap"><form class="login" id="lf">
    <h2>RIS ${esc(state.hospital.name || 'RSUD Hanau')}</h2><p>Radiology Information System</p>
    <label class="f">Username<input type="text" name="username" autofocus required></label>
    <label class="f">Password<input type="password" name="password" required></label>
    <button class="btn primary">Masuk</button></form></div>`;
  $('#lf').onsubmit = act(async (e) => {
    e.preventDefault();
    const r = await api('/auth/login', { method: 'POST', body: formData(e.target) });
    state.token = r.token; state.user = r.user; localStorage.setItem('ris_token', r.token);
    await startApp();
  });
}

const NAV = [
  ['worklist', 'Worklist Radiologi', null],
  ['reconcile', 'Rekonsiliasi PACS', null],
  ['__', 'Master & Pemetaan'],
  ['mapping', 'Pemetaan Prosedur', null],
  ['modalities', 'Alat / Modalitas', null],
  ['templates', 'Template Expertise', null],
  ['users', 'Pengguna', 'admin'],
  ['__', 'Integrasi'],
  ['logs', 'Log Integrasi', null],
  ['health', 'Status Layanan', null],
];

function renderShell() {
  $('#root').innerHTML = `<div class="app">
    <nav class="side"><div class="logo">RIS ${esc(state.hospital.name || '')}</div><div class="sub">Terhubung SIMRS Khanza</div>
      ${NAV.map(([k, label, role]) => (k === '__' ? `<div class="sect">${label}</div>` : role && !can(role) ? '' : `<a href="#/${k}" data-nav="${k}">${label}${k === 'reconcile' ? '<span class="badge hidden" id="unm"></span>' : ''}</a>`)).join('')}
    </nav>
    <main class="main"><div class="topbar"><h1 id="title"></h1><div class="spacer"></div>
      <span class="user-chip">${esc(state.user.full_name)} · ${esc(state.user.role)}</span>
      <button class="btn sm" id="logout">Keluar</button></div>
      <div id="view"></div></main></div>`;
  $('#logout').onclick = logout;
  refreshBadge();
}
async function refreshBadge() {
  try {
    const d = await api('/dashboard');
    const b = $('#unm');
    if (b) { b.textContent = d.unmatched; b.classList.toggle('hidden', !d.unmatched); }
  } catch { /* abaikan */ }
}

let refreshTimer = null;
function route() {
  clearInterval(refreshTimer);
  const [, page = 'worklist', id] = location.hash.split('/');
  $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === page || (page === 'order' && a.dataset.nav === 'worklist')));
  const views = { worklist: viewWorklist, order: () => viewOrder(id), reconcile: viewReconcile, mapping: viewMapping, modalities: viewModalities, templates: viewTemplates, users: viewUsers, logs: viewLogs, health: viewHealth };
  (views[page] || viewWorklist)().catch((e) => { $('#view').innerHTML = `<div class="alert err">${esc(e.message)}</div>`; });
}
const setTitle = (t) => { $('#title').textContent = t; document.title = `${t} — RIS`; };

// ---------------------------------------------------------------- worklist
async function viewWorklist() {
  setTitle('Worklist Radiologi');
  const f = state.filters;
  $('#view').innerHTML = `
    <div class="stats" id="stats"></div>
    <div class="card"><div class="card-h"><div class="row" style="flex:1">
      <input type="date" id="f-from" value="${f.from}"> s/d <input type="date" id="f-to" value="${f.to}">
      <select id="f-mod"><option value="">Semua modalitas</option>${Object.keys(state.modCodes).map((m) => `<option ${f.modality === m ? 'selected' : ''}>${m}</option>`).join('')}</select>
      <input type="text" id="f-q" placeholder="Cari nama / No.RM / accession / no rawat" value="${esc(f.q)}" style="flex:1;min-width:220px">
      <button class="btn" id="f-go">Tampilkan</button>
      <button class="btn" id="f-sync" title="${state.syncMode === 'auto' ? 'Tarik permintaan baru dari SIMRS Khanza sekarang' : 'Ambil satu permintaan dari Khanza berdasarkan No. Order'}">${state.syncMode === 'auto' ? '↻ Sinkron Khanza' : '+ Ambil dari Khanza'}</button>
    </div></div><div class="table-wrap" id="tbl"></div></div>`;
  const load = act(async () => {
    Object.assign(f, { from: $('#f-from').value, to: $('#f-to').value, modality: $('#f-mod').value, q: $('#f-q').value.trim() });
    const qs = new URLSearchParams({ from: f.from, to: f.to, modality: f.modality, q: f.q }).toString();
    const rows = await api('/orders?' + qs);
    const counts = rows.reduce((a, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {});
    $('#stats').innerHTML = [['', 'Semua', rows.length], ...Object.keys(STATUS).map((k) => [k, STATUS[k], counts[k] || 0])]
      .map(([k, l, n]) => `<div class="stat-box ${f.status === k ? 'sel' : ''}" data-st="${k}"><b>${n}</b><span>${l}</span></div>`).join('');
    $$('[data-st]').forEach((b) => (b.onclick = () => { f.status = b.dataset.st; render(rows); $$('[data-st]').forEach((x) => x.classList.toggle('sel', x === b)); }));
    render(rows);
  });
  const render = (rows) => {
    const list = f.status ? rows.filter((r) => r.status === f.status) : rows;
    $('#tbl').innerHTML = list.length ? `<table class="t"><thead><tr>
      <th>Jam</th><th>Accession</th><th>Pasien</th><th>Pemeriksaan</th><th>Alat</th><th>Asal / Perujuk</th><th>Status</th><th title="Gambar di PACS">Gbr</th><th title="SATUSEHAT">SS</th></tr></thead><tbody>
      ${list.map((o) => `<tr class="click" data-id="${o.id}">
        <td class="nowrap">${fmtTime(o.scheduled_at)}<div class="muted">${String(o.scheduled_at).slice(5, 10)}</div></td>
        <td class="mono">${esc(o.accession_number)}${o.dicom_accession ? `<div class="muted" title="Accession yang diterima alat">alat: ${esc(o.dicom_accession)}</div>` : ''}</td>
        <td>${o.priority === 'STAT' ? '<span class="pill stat">CITO</span> ' : ''}<b>${esc(o.patient_name)}</b>
          <div class="muted">RM ${esc(o.no_rkm_medis)} · ${o.patient_sex === 'F' ? 'P' : 'L'} · ${age(o.patient_birthdate)} · ${esc(o.penjamin || '')}</div></td>
        <td>${esc(o.procedure_name)}<div class="muted">${esc(o.diagnosis || '')}</div></td>
        <td><span class="pill mod">${esc(o.modality || '?')}</span><div class="muted">${esc(o.station_ae || 'semua alat')}</div></td>
        <td>${esc(o.location || '')}<div class="muted">${esc(o.referring_name || '')}</div></td>
        <td>${pill(o.status)}${o.radiologist_name && o.status === 'VERIFIED' ? `<div class="muted">${esc(o.radiologist_name)}</div>` : ''}</td>
        <td class="nowrap">${o.images_count ? `${dot(true)}${o.images_count}` : dot(false)}</td>
        <td>${dot(o.ss_diagnosticreport_id || o.ss_servicerequest_id, o.ss_error)}</td></tr>`).join('')}
      </tbody></table>` : '<div class="empty">Tidak ada order pada rentang ini.</div>';
    $$('tr[data-id]').forEach((tr) => (tr.onclick = () => (location.hash = '#/order/' + tr.dataset.id)));
  };
  $('#f-go').onclick = load;
  $('#f-q').onkeydown = (e) => e.key === 'Enter' && load();
  $('#f-sync').onclick = act(async () => {
    if (state.syncMode === 'auto') {
      const r = await api('/sync/now', { method: 'POST' });
      toast(r.skipped ? 'Sinkron sedang berjalan' : `${r.created} order baru dari Khanza`); load(); return;
    }
    modal('Ambil permintaan dari SIMRS Khanza', `<div class="hint" style="margin-bottom:10px">Biasanya order dikirim dari Khanza lewat tombol <b>Kirim ke RIS</b>. Pakai ini bila perlu mengambil manual.</div>
      <label class="f">No. Order (noorder Khanza)<input type="text" name="noorder" placeholder="PR20261104004" autofocus></label>`,
    { saveText: 'Ambil & kirim ke worklist', onSave: async (m) => {
      const noorder = $('[name=noorder]', m).value.trim();
      if (!noorder) { toast('Isi No. Order', true); return false; }
      const r = await api('/sync/now', { method: 'POST', body: { noorder } });
      toast(r.message); load();
    } });
  });
  await load();
  refreshTimer = setInterval(() => { if (!document.hidden && !$('.modal-bg')) load(); }, 20000);
}

// ---------------------------------------------------------------- order detail
async function viewOrder(id) {
  const d = await api('/orders/' + id);
  const o = d.order;
  setTitle(`${o.patient_name} — ${o.procedure_name}`);
  const tab = sessionStorage.getItem('order_tab') || 'report';
  $('#view').innerHTML = `
    <div class="card" style="margin-bottom:14px"><div class="card-b patient-head">
      <div style="flex:1;min-width:260px"><div class="name">${o.priority === 'STAT' ? '<span class="pill stat">CITO</span> ' : ''}${esc(o.patient_name)}</div>
        <div class="muted">RM ${esc(o.no_rkm_medis)} · ${o.patient_sex === 'F' ? 'Perempuan' : 'Laki-laki'} · ${esc(o.patient_birthdate || '-')} (${age(o.patient_birthdate)}) · NIK ${esc(o.patient_nik || '-')}</div>
        <div class="muted">No. rawat ${esc(o.no_rawat)} · ${esc(o.location || '')} · ${esc(o.penjamin || '')}</div></div>
      <div><div class="muted">Pemeriksaan</div><b>${esc(o.procedure_name)}</b> <span class="pill mod">${esc(o.modality)}</span>
        <div class="mono muted">ACC ${esc(o.accession_number)}${o.noorder !== o.accession_number ? ` · ${esc(o.noorder)}` : ''}</div></div>
      <div><div class="muted">Status</div>${pill(o.status)}<div class="muted">${o.images_count} gambar di PACS</div></div>
      <div class="row">${d.viewerUrl ? `<a class="btn primary" href="${esc(d.viewerUrl)}" target="_blank" rel="noopener">Buka Viewer</a>` : '<button class="btn" disabled title="Gambar belum ada di PACS">Viewer</button>'}
        <button class="btn" onclick="location.hash='#/worklist'">← Worklist</button></div>
    </div></div>
    ${o.ss_error ? `<div class="alert warn"><b>SATUSEHAT:</b> ${esc(o.ss_error)}</div>` : ''}
    <div class="tabs">${[['report', 'Expertise'], ['info', 'Order & Integrasi'], ['history', 'Riwayat']].map(([k, l]) => `<button data-tab="${k}" class="${tab === k ? 'active' : ''}">${l}</button>`).join('')}</div>
    <div id="tab"></div>`;
  $$('[data-tab]').forEach((b) => (b.onclick = () => { sessionStorage.setItem('order_tab', b.dataset.tab); viewOrder(id); }));
  ({ report: tabReport, info: tabInfo, history: tabHistory }[tab] || tabReport)(d);
}

async function tabReport(d) {
  const o = d.order, r = d.report;
  const final = r && r.status !== 'DRAFT';
  const isRad = state.user.role === 'radiolog';
  const templates = (await api('/templates')).filter((t) => !t.modality || t.modality === o.modality || (['CR', 'DX'].includes(t.modality) && ['CR', 'DX'].includes(o.modality)));
  $('#tab').innerHTML = `<div class="grid2" style="grid-template-columns:2fr 1fr"><div class="card"><div class="card-h">Expertise ${r ? `<span class="pill st-${r.status === 'DRAFT' ? 'REPORTED' : 'VERIFIED'}">${r.status}${r.version > 1 ? ' v' + r.version : ''}</span>` : ''}
      ${r && r.source === 'HL7' ? '<span class="muted">dari PACS (HL7)</span>' : ''}<span style="flex:1"></span>
      ${isRad && !final ? `<select id="tpl"><option value="">— Template —</option>${templates.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select>` : ''}</div>
    <div class="card-b report-area">
      ${!isRad && !r ? '<div class="alert info">Expertise diisi oleh radiolog.</div>' : ''}
      <label class="f">Uraian / Temuan<textarea id="findings" rows="12" ${!isRad || final ? 'readonly' : ''}>${esc(r ? r.findings : '')}</textarea></label>
      <label class="f" style="margin-top:10px">Kesan<textarea id="impression" rows="4" ${!isRad || final ? 'readonly' : ''}>${esc(r ? r.impression : '')}</textarea></label>
      <div class="sticky-actions row">
        ${isRad && !final ? '<button class="btn" id="save">Simpan Draft</button><button class="btn ok" id="verify">Verifikasi &amp; Kirim ke Khanza</button>' : ''}
        ${isRad && final ? '<button class="btn" id="amend">Revisi Expertise</button>' : ''}
        ${final ? '<button class="btn" id="print">Cetak Hasil</button>' : ''}
        <span class="muted" style="margin-left:auto">${r && r.verified_at ? `Diverifikasi ${esc(r.radiologist_name)} · ${fmtDt(r.verified_at)}` : ''}</span>
      </div></div></div>
    <div class="card"><div class="card-h">Informasi Klinis</div><div class="card-b"><dl class="kv" style="grid-template-columns:110px 1fr">
      <dt>Perujuk</dt><dd>${esc(o.referring_name || '-')}</dd><dt>Diagnosa</dt><dd>${esc(o.diagnosis || '-')}</dd>
      <dt>Info tambahan</dt><dd>${esc(o.clinical_info || '-')}</dd><dt>Diminta</dt><dd>${fmtDt(o.requested_at)}</dd>
      <dt>Diperiksa</dt><dd>${fmtDt(o.exam_started_at)}${o.radiographer ? ' · ' + esc(o.radiographer) : ''}</dd>
      <dt>Khanza</dt><dd>${o.khanza_written_at ? `${dot(true)}hasil tersimpan ${fmtDt(o.khanza_written_at)}` : `${dot(false)}belum ditulis`}</dd>
      ${d.mpps[0] && (d.mpps[0].kvp || d.mpps[0].dose) ? `<dt>Eksposi</dt><dd>${esc(d.mpps[0].kvp || '-')} kV · ${esc(d.mpps[0].mas || '-')} mAs ${d.mpps[0].dose ? '· dosis ' + esc(d.mpps[0].dose) : ''}</dd>` : ''}
    </dl></div></div></div>`;
  const body = () => ({ findings: $('#findings').value, impression: $('#impression').value });
  if ($('#tpl')) $('#tpl').onchange = (e) => {
    const t = templates.find((x) => String(x.id) === e.target.value);
    if (!t) return;
    if (($('#findings').value.trim() || $('#impression').value.trim()) && !confirm('Ganti isi expertise dengan template?')) return;
    $('#findings').value = t.findings || ''; $('#impression').value = t.impression || '';
  };
  if ($('#save')) $('#save').onclick = act(async () => { await api(`/orders/${o.id}/report`, { method: 'PUT', body: body() }); toast('Draft tersimpan'); viewOrder(o.id); });
  if ($('#verify')) $('#verify').onclick = act(async () => {
    if (!confirm('Verifikasi expertise? Hasil akan ditulis ke SIMRS Khanza dan dikirim ke SATUSEHAT (jika aktif).')) return;
    await api(`/orders/${o.id}/report`, { method: 'PUT', body: body() });
    await api(`/orders/${o.id}/report/verify`, { method: 'POST' });
    toast('Expertise terverifikasi'); viewOrder(o.id);
  });
  if ($('#amend')) $('#amend').onclick = () => modal('Revisi Expertise', `
      <div class="alert warn">Revisi akan menimpa hasil di Khanza & SATUSEHAT. Versi sebelumnya tetap tersimpan di riwayat.</div>
      <label class="f">Uraian / Temuan<textarea name="findings" rows="10">${esc(r.findings)}</textarea></label>
      <label class="f" style="margin-top:8px">Kesan<textarea name="impression" rows="3">${esc(r.impression)}</textarea></label>
      <label class="f" style="margin-top:8px">Alasan revisi<input type="text" name="reason" required></label>`,
  { saveText: 'Simpan Revisi', wide: true, onSave: async (m) => { await api(`/orders/${o.id}/report/amend`, { method: 'POST', body: formData(m) }); toast('Revisi tersimpan'); viewOrder(o.id); } });
  if ($('#print')) $('#print').onclick = () => printReport(o, r);
}

function printReport(o, r) {
  const w = window.open('', '_blank');
  const h = state.hospital;
  w.document.write(`<!DOCTYPE html><html><head><title>Hasil ${esc(o.accession_number)}</title><style>
    body{font-family:Arial,sans-serif;font-size:13px;margin:28px 40px;color:#000} h1{font-size:18px;margin:0} .hd{border-bottom:2px solid #000;padding-bottom:8px;margin-bottom:14px;text-align:center}
    table{width:100%;border-collapse:collapse;margin-bottom:14px} td{padding:3px 6px;vertical-align:top} .b{font-weight:bold} .rep{white-space:pre-wrap;line-height:1.55}
    .sign{margin-top:50px;width:260px;margin-left:auto;text-align:center} @media print{button{display:none}}</style></head><body>
    <div class="hd"><h1>${esc(h.name)}</h1><div>${esc(h.address || '')}</div><div class="b" style="margin-top:6px">HASIL PEMERIKSAAN RADIOLOGI</div></div>
    <table><tr><td width="18%">Nama</td><td width="32%">: ${esc(o.patient_name)}</td><td width="18%">No. RM</td><td>: ${esc(o.no_rkm_medis)}</td></tr>
    <tr><td>Tgl lahir / JK</td><td>: ${esc(o.patient_birthdate || '-')} / ${o.patient_sex === 'F' ? 'P' : 'L'}</td><td>No. Rawat</td><td>: ${esc(o.no_rawat)}</td></tr>
    <tr><td>Dokter perujuk</td><td>: ${esc(o.referring_name || '-')}</td><td>Asal</td><td>: ${esc(o.location || '-')}</td></tr>
    <tr><td>Pemeriksaan</td><td>: ${esc(o.procedure_name)}</td><td>Accession</td><td>: ${esc(o.accession_number)}</td></tr>
    <tr><td>Tgl periksa</td><td>: ${esc(fmtDt(o.exam_started_at || o.scheduled_at))}</td><td>Diagnosa klinis</td><td>: ${esc(o.diagnosis || '-')}</td></tr></table>
    <div class="rep">${esc(r.findings)}</div>${r.impression ? `<p class="b" style="margin-bottom:2px">KESAN:</p><div class="rep">${esc(r.impression)}</div>` : ''}
    <div class="sign">${esc(fmtDt(r.verified_at).slice(0, 10))}<br>Radiolog,<br><br><br><br><b>${esc(r.radiologist_name || '')}</b></div>
    <button onclick="print()">Cetak</button></body></html>`);
  w.document.close();
}

async function tabInfo(d) {
  const o = d.order, m = d.map;
  const mods = await api('/modalities');
  const rg = can('radiografer');
  const ssStep = (label, id, action, enabled = true) => `<tr><td>${dot(id)}${label}</td><td class="mono">${esc(id || '-')}</td>
    <td>${rg || can('radiolog') ? `<button class="btn sm" data-ss="${action}" ${enabled ? '' : 'disabled'}>${id ? 'Ulangi' : 'Kirim'}</button>` : ''}</td></tr>`;
  $('#tab').innerHTML = `<div class="grid2">
    <div class="card"><div class="card-h">Penjadwalan</div><div class="card-b">
      <div class="form-grid" id="sched">
        <label class="f">Modalitas<select name="modality" ${rg ? '' : 'disabled'}>${Object.keys(state.modCodes).map((k) => `<option ${o.modality === k ? 'selected' : ''}>${k}</option>`).join('')}</select></label>
        <label class="f">Alat (AE Title)<select name="station_ae" ${rg ? '' : 'disabled'}><option value="">— semua alat bermodalitas sama —</option>
          ${mods.filter((x) => x.active).map((x) => `<option value="${esc(x.ae_title)}" ${o.station_ae === x.ae_title ? 'selected' : ''}>${esc(x.ae_title)} · ${esc(x.name)} (${x.modality})</option>`).join('')}</select></label>
        <label class="f">Jadwal<input type="datetime-local" name="scheduled_at" value="${esc(String(o.scheduled_at).replace(' ', 'T').slice(0, 16))}" ${rg ? '' : 'disabled'}></label>
        <label class="f">Prioritas<select name="priority" ${rg ? '' : 'disabled'}><option value="ROUTINE">Rutin</option><option value="STAT" ${o.priority === 'STAT' ? 'selected' : ''}>CITO</option></select></label>
      </div>
      ${rg ? `<div class="row" style="margin-top:12px"><button class="btn primary" id="saveSched">Simpan Jadwal</button>
        <span style="flex:1"></span>
        <button class="btn sm" data-st="IN_PROGRESS">Mulai Periksa</button><button class="btn sm" data-st="COMPLETED">Selesai</button>
        <button class="btn sm" data-st="SCHEDULED">Jadwal Ulang</button><button class="btn sm danger" data-st="CANCELLED">Batalkan</button></div>
        <p class="muted">Tombol status untuk alat yang belum mendukung MPPS. Alat dengan MPPS memperbarui status otomatis.</p>` : ''}
    </div></div>
    <div class="card"><div class="card-h">Pemetaan Standar</div><div class="card-b">
      ${m ? `<dl class="kv"><dt>Kode Khanza</dt><dd class="mono">${esc(o.kd_jenis_prw)}</dd>
        <dt>DICOM Modality</dt><dd>${esc(m.modality)} — ${esc(state.modCodes[m.modality] || '')}</dd>
        <dt>Body Part (DICOM)</dt><dd>${esc(m.body_part || '-')}</dd>
        <dt>LOINC</dt><dd>${m.loinc_code ? `<span class="mono">${esc(m.loinc_code)}</span> ${esc(m.loinc_display || '')}` : '<span class="pill stat">belum diisi</span>'}</dd>
        <dt>SNOMED CT (lokasi)</dt><dd>${m.snomed_bodysite_code ? `<span class="mono">${esc(m.snomed_bodysite_code)}</span> ${esc(m.snomed_bodysite_display || '')}` : '-'}</dd>
        <dt>RadLex</dt><dd>${esc(m.radlex_code || '-')} ${esc(m.radlex_display || '')}</dd>
        <dt>Protokol alat</dt><dd>${esc(m.protocol_code || '-')} ${esc(m.protocol_meaning || '')}</dd></dl>`
      : `<div class="alert warn">Jenis pemeriksaan <b>${esc(o.kd_jenis_prw)}</b> belum dipetakan. Modalitas ditebak dari nama. <a href="#/mapping">Atur pemetaan</a>.</div>`}
    </div></div>
    <div class="card"><div class="card-h">Identitas DICOM</div><div class="card-b"><dl class="kv">
      <dt>Accession Number</dt><dd class="mono">${esc(o.accession_number)}</dd>
      ${o.dicom_accession ? `<dt>Accession di alat</dt><dd class="mono">${esc(o.dicom_accession)} <span class="muted">(maks 16 karakter DICOM)</span></dd>` : ''}<dt>Requested Proc. ID</dt><dd class="mono">${esc(o.requested_procedure_id)}</dd>
      <dt>SPS ID</dt><dd class="mono">${esc(o.sps_id)}</dd><dt>Study Instance UID</dt><dd class="mono">${esc(o.study_instance_uid)}</dd>
      <dt>Study di PACS</dt><dd class="mono">${esc(o.pacs_study_id || '-')}</dd><dt>MPPS</dt><dd class="mono">${esc(o.mpps_uid || '-')}</dd></dl>
      <div class="row" style="margin-top:10px"><button class="btn sm" id="mwl">Lihat dataset Worklist</button><button class="btn sm" id="hl7">Lihat HL7 ORM</button>
      ${rg ? '<button class="btn sm" id="hl7send">Kirim ulang HL7</button>' : ''}</div></div></div>
    <div class="card"><div class="card-h">SIMRS Khanza & SATUSEHAT</div><div class="card-b">
      <dl class="kv"><dt>hasil_radiologi</dt><dd>${o.khanza_written_at ? `${dot(true)}${fmtDt(o.khanza_written_at)} (kunci ${esc(o.khanza_tgl_periksa)} ${esc(o.khanza_jam)})` : `${dot(false)}belum`}</dd></dl>
      ${d.report && d.report.status !== 'DRAFT' && rg ? '<div class="row" style="margin:8px 0 14px"><button class="btn sm" id="wb">Tulis ulang ke Khanza</button><button class="btn sm" id="wbimg">Kirim gambar preview ke Khanza</button></div>' : ''}
      <table class="t"><thead><tr><th>Langkah SATUSEHAT</th><th>ID</th><th></th></tr></thead><tbody>
        ${ssStep('1. ServiceRequest', o.ss_servicerequest_id, 'servicerequest')}
        ${ssStep('2. Kirim DICOM ke Router', o.ss_dicom_forwarded_at, 'forward', !!(o.pacs_study_id && o.ss_servicerequest_id))}
        ${ssStep('3. ImagingStudy', o.ss_imagingstudy_id, 'imagingstudy', !!o.ss_servicerequest_id)}
        ${ssStep('4. Observation + DiagnosticReport', o.ss_diagnosticreport_id, 'report', !!(d.report && d.report.status !== 'DRAFT'))}
      </tbody></table></div></div></div>`;
  if ($('#saveSched')) $('#saveSched').onclick = act(async () => {
    const f = formData($('#sched'));
    f.scheduled_at = f.scheduled_at.replace('T', ' ') + ':00';
    await api('/orders/' + o.id, { method: 'PATCH', body: f }); toast('Jadwal tersimpan'); viewOrder(o.id);
  });
  $$('[data-st]').forEach((b) => (b.onclick = act(async () => {
    if (b.dataset.st === 'CANCELLED' && !confirm('Batalkan order ini? Order akan hilang dari worklist alat.')) return;
    await api(`/orders/${o.id}/status`, { method: 'POST', body: { status: b.dataset.st } }); toast('Status diperbarui'); viewOrder(o.id);
  })));
  $('#mwl').onclick = act(async () => modal('Dataset Modality Worklist (C-FIND response)', `<pre class="code">${esc(JSON.stringify(await api(`/orders/${o.id}/mwl-preview`), null, 2))}</pre>`, { wide: true }));
  $('#hl7').onclick = act(async () => modal('HL7 ORM^O01', `<pre class="code">${esc(await api(`/orders/${o.id}/hl7-preview`))}</pre>`, { wide: true }));
  if ($('#hl7send')) $('#hl7send').onclick = act(async () => { const r = await api(`/orders/${o.id}/hl7/send`, { method: 'POST', body: { control: 'NW' } }); toast(r.targets ? `Terkirim ke ${r.sent}/${r.targets} tujuan` : 'Tidak ada tujuan HL7 yang dikonfigurasi'); });
  if ($('#wb')) $('#wb').onclick = act(async () => { await api(`/orders/${o.id}/khanza/writeback`, { method: 'POST' }); toast('Hasil ditulis ke Khanza'); viewOrder(o.id); });
  if ($('#wbimg')) $('#wbimg').onclick = act(async () => { const r = await api(`/orders/${o.id}/khanza/gambar`, { method: 'POST' }); toast(`${r.files} gambar ditulis`); });
  $$('[data-ss]').forEach((b) => (b.onclick = act(async () => { b.disabled = true; try { await api(`/orders/${o.id}/satusehat/${b.dataset.ss}`, { method: 'POST' }); toast('SATUSEHAT: berhasil'); } finally { viewOrder(o.id); } })));
}

function tabHistory(d) {
  $('#tab').innerHTML = `<div class="grid2"><div class="card"><div class="card-h">Jejak Order</div><div class="card-b"><ul class="timeline">
    ${d.events.map((e) => {
      let det = e.detail || '';
      try { const j = JSON.parse(det); det = j.from ? `${STATUS[j.from] || j.from} → ${STATUS[j.to] || j.to}${j.info ? ' · ' + j.info : ''}` : Object.entries(j).map(([k, v]) => `${k}: ${v}`).join(', '); } catch { /* teks biasa */ }
      return `<li class="${/ERROR|WARNING/.test(e.event) ? 'warn' : ''}"><b>${esc(e.event)}</b> <span class="muted">${fmtDt(e.created_at)} · ${esc(e.actor || '')}</span><div>${esc(det)}</div></li>`;
    }).join('')}</ul></div></div>
    <div><div class="card" style="margin-bottom:14px"><div class="card-h">MPPS dari alat</div><div class="card-b">
      ${d.mpps.length ? `<table class="t"><thead><tr><th>Status</th><th>Alat</th><th>Mulai</th><th>Selesai</th><th>Series/Gbr</th></tr></thead><tbody>
      ${d.mpps.map((m) => `<tr><td>${esc(m.status)}</td><td>${esc(m.station_ae)}</td><td>${fmtDt(m.started_at)}</td><td>${fmtDt(m.ended_at)}</td><td>${m.series_count}/${m.image_count}</td></tr>`).join('')}</tbody></table>` : '<div class="muted">Tidak ada MPPS (alat tidak mengirim, atau status diubah manual).</div>'}
    </div></div>
    <div class="card"><div class="card-h">Riwayat Versi Expertise</div><div class="card-b">
      ${d.reportHistory.length ? d.reportHistory.map((h) => `<details style="margin-bottom:8px"><summary>v${h.version} · ${esc(h.status)} · ${esc(h.radiologist_name || '')} · ${fmtDt(h.created_at)} <span class="muted">${esc(h.reason || '')}</span></summary>
        <pre class="code" style="background:#f6f8f9;color:#222">${esc(h.findings)}\n\nKESAN:\n${esc(h.impression)}</pre></details>`).join('') : '<div class="muted">Belum ada versi final.</div>'}
    </div></div></div></div>`;
}

// ---------------------------------------------------------------- reconcile
async function viewReconcile() {
  setTitle('Rekonsiliasi PACS');
  const rows = await api('/unmatched');
  $('#view').innerHTML = `<div class="hint" style="margin-bottom:12px">Study yang masuk ke PACS tetapi tidak cocok dengan order (alat tidak memakai worklist, Accession diketik manual, atau salah pasien).
    Tautkan ke order yang benar. Centang <b>koreksi tag</b> agar Accession/No.RM di PACS ikut diperbaiki — wajib untuk pengiriman ke SATUSEHAT.</div>
    <div class="card">${rows.length ? `<table class="t"><thead><tr><th>Tgl study</th><th>Pasien (DICOM)</th><th>Accession</th><th>Modalitas</th><th>Deskripsi</th><th>Gbr</th><th></th></tr></thead><tbody>
    ${rows.map((u) => `<tr><td>${esc(u.study_date)}</td><td><b>${esc(String(u.patient_name || '').replace(/\^/g, ' '))}</b><div class="muted">ID ${esc(u.patient_id)}</div></td>
      <td class="mono">${esc(u.accession_number || '-')}</td><td>${esc(u.modalities)}</td><td>${esc(u.description)}</td><td>${u.images_count}</td>
      <td class="nowrap"><button class="btn sm primary" data-link="${u.id}">Tautkan</button> <button class="btn sm" data-ign="${u.id}">Abaikan</button></td></tr>`).join('')}
    </tbody></table>` : '<div class="empty">Semua study di PACS sudah cocok dengan order. 👍</div>'}</div>`;
  $$('[data-ign]').forEach((b) => (b.onclick = act(async () => { await api(`/unmatched/${b.dataset.ign}/ignore`, { method: 'POST' }); viewReconcile(); refreshBadge(); })));
  $$('[data-link]').forEach((b) => (b.onclick = act(async () => {
    const cands = await api(`/unmatched/${b.dataset.link}/candidates`);
    modal('Tautkan study ke order', `${cands.length ? `<table class="t"><tbody>${cands.map((c) => `<tr><td><input type="radio" name="order_id" value="${c.id}"></td>
      <td><b>${esc(c.patient_name)}</b><div class="muted">RM ${esc(c.no_rkm_medis)} · ${fmtDt(c.scheduled_at)}</div></td><td>${esc(c.procedure_name)}<div class="mono muted">${esc(c.accession_number)}</div></td><td>${pill(c.status)}</td></tr>`).join('')}</tbody></table>`
      : '<div class="alert warn">Tidak ada kandidat berdasarkan No.RM / nama. Masukkan ID order RIS manual:</div><label class="f">ID order<input type="text" name="order_id"></label>'}
      <label class="check" style="margin-top:12px"><input type="checkbox" name="fix_tags" checked> Koreksi tag DICOM di PACS (Accession, Patient ID, nama)</label>`,
    { saveText: 'Tautkan', onSave: async (m) => {
      const sel = $('input[name=order_id]:checked', m) || $('input[type=text][name=order_id]', m);
      if (!sel || !sel.value) { toast('Pilih order', true); return false; }
      await api(`/unmatched/${b.dataset.link}/link`, { method: 'POST', body: { order_id: sel.value, fix_tags: $('[name=fix_tags]', m).checked } });
      toast('Study ditautkan'); viewReconcile(); refreshBadge();
    } });
  })));
}

// ---------------------------------------------------------------- mapping
async function viewMapping() {
  setTitle('Pemetaan Prosedur Radiologi');
  const rows = await api('/mapping');
  const unmapped = rows.filter((r) => !r.mapped).length;
  $('#view').innerHTML = `<div class="hint" style="margin-bottom:12px">Setiap jenis pemeriksaan di <span class="mono">jns_perawatan_radiologi</span> Khanza dipetakan ke
    <b>Modality DICOM</b> (worklist alat), <b>LOINC</b> (wajib untuk ServiceRequest/DiagnosticReport SATUSEHAT — pakai kode kategori "Permintaan" dari file Terminologi Radiologi SATUSEHAT),
    <b>SNOMED CT</b> lokasi tubuh, opsional <b>RadLex</b> dan kode protokol alat.</div>
    <div class="card"><div class="card-h"><input type="text" id="mq" placeholder="Cari kode / nama" style="flex:1">
      <label class="check"><input type="checkbox" id="monly"> Hanya yang belum dipetakan (${unmapped})</label>
      ${can('admin') ? '<button class="btn primary" id="automap" title="Isi otomatis modalitas, bagian tubuh, SNOMED CT, sisi & kode protokol dari nama pemeriksaan">⚡ Auto Petakan</button>' : ''}</div>
    <div class="table-wrap" id="mt"></div></div>`;
  const render = () => {
    const q = $('#mq').value.toLowerCase(), only = $('#monly').checked;
    const list = rows.filter((r) => (!only || !r.mapped) && (!q || `${r.kd_jenis_prw} ${r.nm_perawatan}`.toLowerCase().includes(q)));
    $('#mt').innerHTML = `<table class="t"><thead><tr><th>Kode</th><th>Nama (Khanza)</th><th>Modality</th><th>LOINC</th><th>SNOMED CT lokasi</th><th>Body part</th><th>Alat default</th><th></th></tr></thead><tbody>
      ${list.map((r) => { const m = r.map || {}; return `<tr><td class="mono">${esc(r.kd_jenis_prw)}</td><td>${esc(r.nm_perawatan)}${r.orphan ? ' <span class="pill stat">tidak ada di Khanza</span>' : ''}</td>
        <td>${m.modality ? `<span class="pill mod">${esc(m.modality)}</span>` : '<span class="pill stat">belum</span>'}</td>
        <td>${m.loinc_code ? `<span class="mono">${esc(m.loinc_code)}</span><div class="muted">${esc(m.loinc_display || '')}</div>` : '-'}</td>
        <td>${m.snomed_bodysite_code ? `<span class="mono">${esc(m.snomed_bodysite_code)}</span><div class="muted">${esc(m.snomed_bodysite_display || '')}</div>` : '-'}</td>
        <td>${esc(m.body_part || '-')}</td><td>${esc(m.default_ae_title || '-')}</td>
        <td>${can('admin') ? `<button class="btn sm" data-kd="${esc(r.kd_jenis_prw)}">Atur</button>` : ''}</td></tr>`; }).join('')}</tbody></table>`;
    $$('[data-kd]').forEach((b) => (b.onclick = () => editMap(rows.find((r) => r.kd_jenis_prw === b.dataset.kd))));
  };
  $('#mq').oninput = render; $('#monly').onchange = render;
  if ($('#automap')) $('#automap').onclick = () => modal('Auto Petakan', `
      <p>RIS mengisi otomatis dari nama pemeriksaan Khanza: <b>modalitas DICOM</b>, <b>bagian tubuh</b>, <b>SNOMED CT lokasi</b>, <b>sisi kanan/kiri</b>, kontras,
      dan <b>kode protokol alat</b> (= kode Khanza, untuk dipetakan di alat). Item BHP dilewati.</p>
      <div class="alert warn">LOINC <b>tidak</b> diisi otomatis. Untuk SATUSEHAT, isi manual dari Terminologi Radiologi SATUSEHAT.</div>
      <label class="check" style="margin-top:10px"><input type="checkbox" name="overwrite"> Timpa juga yang sudah dipetakan (LOINC, RadLex & alat default yang sudah diisi tetap dipertahankan)</label>`,
  { saveText: 'Petakan sekarang', onSave: async (m) => {
    const r = await api('/mapping/auto', { method: 'POST', body: { overwrite: $('[name=overwrite]', m).checked } });
    toast(`${r.mapped} pemeriksaan dipetakan${r.noBodyPart.length ? `, ${r.noBodyPart.length} bagian tubuh perlu dicek manual` : ''}`);
    if (r.noBodyPart.length) setTimeout(() => modal('Perlu dicek manual', `<p>Bagian tubuh tidak dikenali dari nama berikut (modalitas & kode protokol tetap terisi):</p><ul>${r.noBodyPart.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`), 300);
    viewMapping();
  } });
  render();
}

async function editMap(r) {
  const m = r.map || { modality: '', nm_perawatan: r.nm_perawatan };
  const mods = await api('/modalities');
  const BODY = ['CHEST', 'HEAD', 'ABDOMEN', 'PELVIS', 'SKULL', 'CSPINE', 'TSPINE', 'LSPINE', 'SSPINE', 'EXTREMITY', 'SHOULDER', 'ELBOW', 'HAND', 'WRIST', 'HIP', 'KNEE', 'ANKLE', 'FOOT', 'BREAST', 'NECK', 'HEART', 'KIDNEY', 'WHOLEBODY'];
  const v = (k) => esc(m[k] ?? '');
  modal(`Pemetaan ${r.kd_jenis_prw} — ${r.nm_perawatan}`, `<div class="form-grid">
    <input type="hidden" name="nm_perawatan" value="${esc(r.nm_perawatan)}">
    <label class="f">DICOM Modality *<select name="modality">${Object.entries(state.modCodes).map(([k, l]) => `<option value="${k}" ${m.modality === k ? 'selected' : ''}>${k} — ${esc(l)}</option>`).join('')}</select></label>
    <label class="f">Alat default (opsional)<select name="default_ae_title"><option value="">— semua alat bermodalitas sama —</option>${mods.map((x) => `<option ${m.default_ae_title === x.ae_title ? 'selected' : ''}>${esc(x.ae_title)}</option>`).join('')}</select></label>
    <label class="f">LOINC code<input type="text" name="loinc_code" value="${v('loinc_code')}" placeholder="24648-8"></label>
    <label class="f">LOINC display<input type="text" name="loinc_display" value="${v('loinc_display')}" placeholder="XR Chest PA upright"></label>
    <label class="f">SNOMED CT lokasi (SCTID)<input type="text" name="snomed_bodysite_code" value="${v('snomed_bodysite_code')}" placeholder="51185008"></label>
    <label class="f">SNOMED CT display<input type="text" name="snomed_bodysite_display" value="${v('snomed_bodysite_display')}" placeholder="Thoracic structure"></label>
    <label class="f">DICOM Body Part Examined<input type="text" name="body_part" list="bp" value="${v('body_part')}"><datalist id="bp">${BODY.map((b) => `<option>${b}</option>`).join('')}</datalist></label>
    <label class="f">Lateralitas<select name="laterality"><option value="">-</option>${['R', 'L', 'B'].map((x) => `<option ${m.laterality === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
    <label class="f">Kode protokol alat<input type="text" name="protocol_code" value="${v('protocol_code')}" maxlength="16"></label>
    <label class="f">Nama protokol<input type="text" name="protocol_meaning" value="${v('protocol_meaning')}" maxlength="64"></label>
    <label class="f">RadLex Playbook RPID<input type="text" name="radlex_code" value="${v('radlex_code')}"></label>
    <label class="f">RadLex display<input type="text" name="radlex_display" value="${v('radlex_display')}"></label>
    <label class="f">Kode Pemeriksaan Nasional (opsional)<input type="text" name="kode_nasional" value="${v('kode_nasional')}"></label>
    <div class="row"><label class="check"><input type="checkbox" name="contrast" ${m.contrast ? 'checked' : ''}> Dengan kontras</label>
    <label class="check"><input type="checkbox" name="active" ${m.active === 0 ? '' : 'checked'}> Aktif</label></div>
    <div class="full row"><button type="button" class="btn sm" id="sugg">⚡ Isi otomatis dari nama</button><span class="muted">mengisi kolom kosong saja</span></div>
    <div class="full hint">Cek kode LOINC di <a href="https://loinc.org/search/" target="_blank" rel="noopener">loinc.org</a> dan pastikan tercantum di Terminologi Radiologi SATUSEHAT. SNOMED CT gunakan konsep <i>body structure</i>.</div></div>`,
  { wide: true, onSave: async (el) => { await api('/mapping/' + encodeURIComponent(r.kd_jenis_prw), { method: 'PUT', body: formData(el) }); toast('Pemetaan tersimpan'); viewMapping(); } });
  $('#sugg').onclick = act(async () => {
    const s = await api(`/mapping/suggest/${encodeURIComponent(r.kd_jenis_prw)}?name=${encodeURIComponent(r.nm_perawatan || '')}`);
    for (const [k, v] of Object.entries(s)) {
      const el = $(`.modal [name="${k}"]`);
      if (!el || v === null || v === undefined) continue;
      if (el.type === 'checkbox') { if (k === 'contrast' && v) el.checked = true; }
      else if (!el.value || (el.tagName === 'SELECT' && !r.mapped)) el.value = v;
    }
    toast('Kolom terisi otomatis, periksa lalu Simpan');
  });
}

// ---------------------------------------------------------------- modalities
async function viewModalities() {
  setTitle('Alat / Modalitas Radiologi');
  const [rows, h] = await Promise.all([api('/modalities'), api('/health')]);
  $('#view').innerHTML = `<div class="hint" style="margin-bottom:12px"><b>Konfigurasi di setiap alat (menu DICOM / Network):</b><br>
    Worklist SCP dan MPPS SCP → AE Title <span class="mono">${esc(h.dicom.ae)}</span>, IP <span class="mono">${esc(location.hostname)}</span>, Port <span class="mono">${h.dicom.port}</span>.
    Storage SCP (kirim gambar) → PACS Orthanc. AE Title alat harus sama persis dengan yang terdaftar di sini.</div>
    <div class="card"><div class="card-h"><span style="flex:1">Daftar alat</span>${can('admin') ? '<button class="btn primary" id="add">+ Tambah alat</button>' : ''}</div>
    ${rows.length ? `<table class="t"><thead><tr><th>AE Title</th><th>Nama</th><th>Modality</th><th>Ruang</th><th>IP</th><th>Merk / model</th><th>HL7</th><th>Aktif</th><th></th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td class="mono"><b>${esc(r.ae_title)}</b></td><td>${esc(r.name)}</td><td><span class="pill mod">${esc(r.modality)}</span></td><td>${esc(r.room || '')}</td>
      <td class="mono">${esc(r.ip_address || '')}</td><td>${esc(r.manufacturer || '')} ${esc(r.model || '')}</td><td>${r.hl7_enabled ? esc(`${r.hl7_host}:${r.hl7_port}`) : '-'}</td><td>${dot(r.active)}</td>
      <td>${can('admin') ? `<button class="btn sm" data-e="${r.id}">Ubah</button>` : ''}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Belum ada alat terdaftar. Alat yang tidak terdaftar akan ditolak saat meminta worklist.</div>'}</div>`;
  const form = (r = { active: 1 }) => modal(r.id ? 'Ubah alat' : 'Tambah alat', `<div class="form-grid">
    <label class="f">AE Title * (sesuai di alat)<input type="text" name="ae_title" value="${esc(r.ae_title || '')}" maxlength="16"></label>
    <label class="f">Nama alat *<input type="text" name="name" value="${esc(r.name || '')}"></label>
    <label class="f">Modality *<select name="modality">${Object.entries(state.modCodes).map(([k, l]) => `<option value="${k}" ${r.modality === k ? 'selected' : ''}>${k} — ${esc(l)}</option>`).join('')}</select></label>
    <label class="f">Ruang<input type="text" name="room" value="${esc(r.room || '')}"></label>
    <label class="f">IP alat<input type="text" name="ip_address" value="${esc(r.ip_address || '')}"></label>
    <label class="f">Port DICOM alat<input type="number" name="port" value="${esc(r.port || '')}"></label>
    <label class="f">Merk<input type="text" name="manufacturer" value="${esc(r.manufacturer || '')}"></label>
    <label class="f">Model<input type="text" name="model" value="${esc(r.model || '')}"></label>
    <label class="f">Scheduled Station Name<input type="text" name="station_name" value="${esc(r.station_name || '')}" maxlength="16"></label>
    <div></div>
    <label class="check"><input type="checkbox" name="hl7_enabled" ${r.hl7_enabled ? 'checked' : ''}> Kirim order HL7 ORM ke alat/gateway ini</label><div></div>
    <label class="f">HL7 host<input type="text" name="hl7_host" value="${esc(r.hl7_host || '')}"></label>
    <label class="f">HL7 port<input type="number" name="hl7_port" value="${esc(r.hl7_port || '')}"></label>
    <label class="check"><input type="checkbox" name="active" ${r.active ? 'checked' : ''}> Aktif</label></div>`,
  { onSave: async (el) => {
    await api(r.id ? '/modalities/' + r.id : '/modalities', { method: r.id ? 'PUT' : 'POST', body: formData(el) });
    toast('Alat tersimpan'); viewModalities();
  } });
  if ($('#add')) $('#add').onclick = () => form();
  $$('[data-e]').forEach((b) => (b.onclick = () => form(rows.find((r) => String(r.id) === b.dataset.e))));
}

// ---------------------------------------------------------------- templates
async function viewTemplates() {
  setTitle('Template Expertise');
  const rows = await api('/templates');
  $('#view').innerHTML = `<div class="card"><div class="card-h"><span style="flex:1">Template</span>${can('radiolog') ? '<button class="btn primary" id="add">+ Template baru</button>' : ''}</div>
    ${rows.length ? `<table class="t"><thead><tr><th>Nama</th><th>Modality</th><th>Kesan</th><th></th></tr></thead><tbody>${rows.map((t) => `<tr><td><b>${esc(t.name)}</b></td><td>${esc(t.modality || 'semua')}</td><td>${esc(t.impression)}</td>
      <td class="nowrap">${can('radiolog') ? `<button class="btn sm" data-e="${t.id}">Ubah</button> <button class="btn sm danger" data-d="${t.id}">Hapus</button>` : ''}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Belum ada template.</div>'}</div>`;
  const form = (t = {}) => modal(t.id ? 'Ubah template' : 'Template baru', `<div class="form-grid">
    <label class="f">Nama<input type="text" name="name" value="${esc(t.name || '')}"></label>
    <label class="f">Modality<select name="modality"><option value="">Semua</option>${Object.keys(state.modCodes).map((k) => `<option ${t.modality === k ? 'selected' : ''}>${k}</option>`).join('')}</select></label>
    <label class="f full">Uraian / temuan<textarea name="findings" rows="10">${esc(t.findings || '')}</textarea></label>
    <label class="f full">Kesan<textarea name="impression" rows="3">${esc(t.impression || '')}</textarea></label></div>`,
  { wide: true, onSave: async (el) => { await api(t.id ? '/templates/' + t.id : '/templates', { method: t.id ? 'PUT' : 'POST', body: formData(el) }); viewTemplates(); } });
  if ($('#add')) $('#add').onclick = () => form();
  $$('[data-e]').forEach((b) => (b.onclick = () => form(rows.find((t) => String(t.id) === b.dataset.e))));
  $$('[data-d]').forEach((b) => (b.onclick = act(async () => { if (confirm('Hapus template?')) { await api('/templates/' + b.dataset.d, { method: 'DELETE' }); viewTemplates(); } })));
}

// ---------------------------------------------------------------- users
async function viewUsers() {
  setTitle('Pengguna');
  const [rows, docs] = await Promise.all([api('/users'), api('/khanza/doctors').catch(() => [])]);
  $('#view').innerHTML = `<div class="card"><div class="card-h"><span style="flex:1">Pengguna RIS</span><button class="btn primary" id="add">+ Pengguna</button></div>
    <table class="t"><thead><tr><th>Username</th><th>Nama</th><th>Role</th><th>kd_dokter</th><th>NIP</th><th>Aktif</th><th>Login terakhir</th><th></th></tr></thead><tbody>
    ${rows.map((u) => `<tr><td class="mono">${esc(u.username)}</td><td>${esc(u.full_name)}</td><td>${esc(u.role)}</td><td>${esc(u.kd_dokter || '')}</td><td>${esc(u.nip || '')}</td><td>${dot(u.active)}</td><td>${fmtDt(u.last_login_at)}</td>
      <td><button class="btn sm" data-e="${u.id}">Ubah</button></td></tr>`).join('')}</tbody></table></div>`;
  const form = (u = { role: 'radiografer', active: 1 }) => modal(u.id ? 'Ubah pengguna' : 'Pengguna baru', `<div class="form-grid">
    <label class="f">Username<input type="text" name="username" value="${esc(u.username || '')}" ${u.id ? 'disabled' : ''}></label>
    <label class="f">Nama lengkap (tampil di hasil)<input type="text" name="full_name" value="${esc(u.full_name || '')}"></label>
    <label class="f">Role<select name="role">${['radiografer', 'radiolog', 'admin', 'viewer'].map((r) => `<option ${u.role === r ? 'selected' : ''}>${r}</option>`).join('')}</select></label>
    <label class="f">Password ${u.id ? '(kosongkan bila tidak diganti)' : ''}<input type="password" name="password"></label>
    <label class="f">Dokter Khanza (wajib untuk radiolog)<select name="kd_dokter"><option value="">-</option>${docs.map((d) => `<option value="${esc(d.kd_dokter)}" ${u.kd_dokter === d.kd_dokter ? 'selected' : ''}>${esc(d.kd_dokter)} · ${esc(d.nm_dokter)}</option>`).join('')}</select></label>
    <label class="f">NIP petugas Khanza<input type="text" name="nip" value="${esc(u.nip || '')}"></label>
    <label class="check"><input type="checkbox" name="active" ${u.active ? 'checked' : ''}> Aktif</label></div>`,
  { onSave: async (el) => { await api(u.id ? '/users/' + u.id : '/users', { method: u.id ? 'PUT' : 'POST', body: formData(el) }); toast('Pengguna tersimpan'); viewUsers(); } });
  $('#add').onclick = () => form();
  $$('[data-e]').forEach((b) => (b.onclick = () => form(rows.find((u) => String(u.id) === b.dataset.e))));
}

// ---------------------------------------------------------------- logs
async function viewLogs() {
  setTitle('Log Integrasi');
  const kind = sessionStorage.getItem('log_kind') || 'dicom';
  const rows = await api('/logs/' + kind);
  const cols = {
    dicom: [['created_at', 'Waktu'], ['op', 'Operasi'], ['calling_ae', 'AE'], ['peer_ip', 'IP'], ['results', 'Hasil'], ['status', 'Status'], ['detail', 'Detail']],
    hl7: [['created_at', 'Waktu'], ['direction', 'Arah'], ['msg_type', 'Tipe'], ['peer', 'Peer'], ['order_id', 'Order'], ['status', 'Status'], ['error', 'Error']],
    satusehat: [['created_at', 'Waktu'], ['resource', 'Resource'], ['method', 'Method'], ['http_status', 'HTTP'], ['order_id', 'Order'], ['url', 'URL']],
  }[kind];
  $('#view').innerHTML = `<div class="tabs">${['dicom', 'hl7', 'satusehat'].map((k) => `<button data-k="${k}" class="${k === kind ? 'active' : ''}">${{ dicom: 'DICOM', hl7: 'HL7', satusehat: 'SATUSEHAT' }[k]}</button>`).join('')}</div>
    <div class="card table-wrap"><table class="t"><thead><tr>${cols.map((c) => `<th>${c[1]}</th>`).join('')}</tr></thead><tbody>
    ${rows.map((r, i) => `<tr class="click" data-i="${i}">${cols.map(([k]) => `<td class="${k === 'detail' || k === 'url' ? 'mono' : ''}">${esc(k === 'created_at' ? fmtDt(r[k]) : String(r[k] ?? '').slice(0, 160))}</td>`).join('')}</tr>`).join('')}
    </tbody></table></div>`;
  $$('[data-k]').forEach((b) => (b.onclick = () => { sessionStorage.setItem('log_kind', b.dataset.k); viewLogs(); }));
  $$('[data-i]').forEach((tr) => (tr.onclick = () => {
    const r = rows[tr.dataset.i];
    const pretty = (s) => { try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return String(s ?? '').replace(/\r/g, '\n'); } };
    modal('Detail log', Object.entries(r).filter(([, v]) => v !== null && String(v).length > 40).map(([k, v]) => `<div class="muted">${esc(k)}</div><pre class="code">${esc(pretty(v))}</pre>`).join('') || `<pre class="code">${esc(JSON.stringify(r, null, 2))}</pre>`, { wide: true });
  }));
}

// ---------------------------------------------------------------- health
async function viewHealth() {
  setTitle('Status Layanan');
  const h = await api('/health');
  const box = (title, ok, lines) => `<div class="card"><div class="card-h">${dot(ok, ok === false)}${esc(title)}</div><div class="card-b"><dl class="kv">${lines.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v ?? '-')}</dd>`).join('')}</dl></div></div>`;
  $('#view').innerHTML = `<div class="grid3">
    ${box('Database RIS', h.ris_db, [['Status', h.ris_db ? 'Terhubung' : h.ris_db_error]])}
    ${box('Database SIMRS Khanza', h.khanza_db, [['Status', h.khanza_db ? 'Terhubung' : h.khanza_db_error], ['Sinkron terakhir', h.sync.lastRun], ['Order baru (terakhir)', h.sync.lastCount], ['Error', h.sync.lastError]])}
    ${box('DICOM MWL / MPPS', h.dicom.enabled, [['AE Title', h.dicom.ae], ['Port', h.dicom.port], ['Asosiasi', h.dicom.associations], ['C-FIND', h.dicom.finds], ['MPPS create/set', `${h.dicom.mppsCreate}/${h.dicom.mppsSet}`], ['Ditolak', h.dicom.rejected], ['Peer terakhir', h.dicom.lastPeer]])}
    ${box('HL7 v2 (MLLP)', h.hl7.enabled, [['Listener', h.hl7.listen], ['Kirim ORM ke', h.hl7.out || 'tidak dikonfigurasi']])}
    ${box('PACS Orthanc', h.orthanc ? h.orthanc.ok : null, h.orthanc ? [['URL', h.orthanc.url], ['Versi', h.orthanc.version], ['Polling terakhir', h.orthanc.lastOk], ['Error', h.orthanc.error || h.orthanc.lastError]] : [['Status', 'nonaktif']])}
    ${box('SATUSEHAT', h.satusehat.enabled, [['Organization ID', h.satusehat.org], ['Otomatis', h.satusehat.auto ? 'ya' : 'tidak']])}
  </div><p class="muted">Waktu server: ${esc(h.time)}</p>`;
}

// ---------------------------------------------------------------- boot
(async function boot() {
  try { const info = await api('/public/info'); state.hospital = info.hospital; state.syncMode = info.syncMode; } catch { /* abaikan */ }
  if (!state.token) return renderLogin();
  try { await startApp(); } catch { renderLogin(); }
})();

let routed = false;
async function startApp() {
  state.user = await api('/me');
  state.modCodes = await api('/modality-codes');
  renderShell();
  if (!routed) { window.addEventListener('hashchange', route); routed = true; }
  route();
}
