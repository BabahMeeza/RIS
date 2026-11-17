'use strict';
/** Klien REST SATUSEHAT (OAuth2 client credentials + FHIR R4) dengan cache token & log request. */
const config = require('../config');
const db = require('../lib/db');

const S = config.satusehat;
let token = null, tokenExp = 0;

async function getToken() {
  if (token && Date.now() < tokenExp - 60000) return token;
  if (!S.clientId || !S.clientSecret) throw new Error('SATUSEHAT_CLIENT_ID / SECRET belum diisi');
  const res = await fetch(`${S.authUrl}/accesstoken?grant_type=client_credentials`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: S.clientId, client_secret: S.clientSecret }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error(`Gagal token SATUSEHAT: HTTP ${res.status} ${JSON.stringify(j).slice(0, 300)}`);
  token = j.access_token;
  tokenExp = Date.now() + (parseInt(j.expires_in, 10) || 3599) * 1000;
  return token;
}

async function request(method, path, body, { orderId = null, resource = '' } = {}) {
  const url = `${S.baseUrl}${path}`;
  const t = await getToken();
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (method !== 'GET' || !res.ok) {
    await db.risQuery(
      'INSERT INTO ris_satusehat_log (order_id, resource, method, url, http_status, request, response) VALUES (?,?,?,?,?,?,?)',
      [orderId, resource || path.split(/[/?]/)[1], method, url.slice(0, 255), res.status, body ? JSON.stringify(body) : null, text.slice(0, 100000)]
    ).catch(() => {});
  }
  if (!res.ok) {
    const issue = json && json.issue && json.issue.map((i) => i.details?.text || i.diagnostics || i.code).join('; ');
    const err = new Error(`SATUSEHAT ${method} ${path.split('?')[0]} HTTP ${res.status}: ${issue || text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

const firstId = (bundle) => (bundle && bundle.entry && bundle.entry[0] && bundle.entry[0].resource ? bundle.entry[0].resource.id : null);

module.exports = { getToken, request, firstId, get: (p, o) => request('GET', p, null, o), post: (p, b, o) => request('POST', p, b, o) };
