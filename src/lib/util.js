'use strict';
const crypto = require('crypto');

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** Waktu lokal (mengikuti process.env.TZ) dalam format DB dan DICOM. */
function nowLocal(d = new Date()) {
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return { date, time, dt: `${date} ${time}`, dicomDate: date.replace(/-/g, ''), dicomTime: time.replace(/:/g, '') };
}

function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d + days);
  return nowLocal(dt).date;
}

/** 'YYYY-MM-DD' atau 'YYYY-MM-DD HH:MM:SS' -> 'YYYYMMDD' */
const toDicomDate = (s) => (s ? String(s).slice(0, 10).replace(/-/g, '') : '');
/** 'YYYY-MM-DD HH:MM:SS' -> 'HHMMSS' */
const toDicomTime = (s) => (s && String(s).length >= 19 ? String(s).slice(11, 19).replace(/:/g, '') : '');
/** 'YYYYMMDD' -> 'YYYY-MM-DD' */
const fromDicomDate = (s) => (s && /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null);
/** 'HHMMSS(.ffff)' -> 'HH:MM:SS' */
const fromDicomTime = (s) => {
  if (!s) return null;
  const t = String(s).replace(/[^0-9]/g, '').padEnd(6, '0');
  return `${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}`;
};
const isZeroDate = (s) => !s || String(s).startsWith('0000') || String(s) < '1900-01-01';

/** UID DICOM berbasis UUID (PS3.5 B.2, root 2.25) - tidak memerlukan OID terdaftar. */
function generateUid() {
  const hex = crypto.randomUUID().replace(/-/g, '');
  return '2.25.' + BigInt('0x' + hex).toString(10);
}

const TITLE_SUFFIX = /,\s*(TN|NY|NN|AN|BY|SDR|SDRI|NONA|TUAN|NYONYA)\.?\s*$/i;

/**
 * Pembersih nilai untuk dataset yang dikirim ke ALAT (PS3.5 6.2 VR).
 * Hanya ASCII cetak (aman untuk semua alat, termasuk yang lama), tanpa '\\' (pemisah multi-nilai DICOM)
 * dan tanpa karakter kontrol; dipotong sesuai panjang maksimal VR.
 */
function dcmText(v, max = 64) {
  return String(v ?? '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')      // é -> e
    .replace(/[\\\x00-\x1F\x7F]/g, ' ')                     // backslash & kontrol -> spasi
    .replace(/[^\x20-\x7E]/g, '')                             // selain ASCII cetak dibuang
    .replace(/\s+/g, ' ').trim().slice(0, max).trim();
}
/** CS: huruf besar, angka, spasi, underscore (maks 16). */
const dcmCs = (v, max = 16) => dcmText(v, max).toUpperCase().replace(/[^A-Z0-9 _]/g, '').trim();
/** AE Title: maks 16, tanpa backslash/kontrol. */
const dcmAe = (v) => dcmText(v, 16); // AE peka huruf: kirim persis (mis. "Eleva")
/** DA: 'YYYY-MM-DD...' -> 'YYYYMMDD' hanya bila tanggal valid (1900-2100), selain itu kosong. */
function dcmDate(s) {
  const m = String(s || '').match(/^(\d{4})-?(\d{2})-?(\d{2})/);
  if (!m) return '';
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (y < 1900 || y > 2100 || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return '';
  return `${m[1]}${m[2]}${m[3]}`;
}
/** TM: 'YYYY-MM-DD HH:MM:SS' -> 'HHMMSS' bila valid, selain itu kosong. */
function dcmTime(s) {
  const m = String(s || '').match(/(\d{2}):?(\d{2}):?(\d{2})\s*$/);
  if (!m || +m[1] > 23 || +m[2] > 59 || +m[3] > 59) return '';
  return `${m[1]}${m[2]}${m[3]}`;
}
/** UI valid: angka & titik, maks 64, komponen tanpa nol di depan. */
const isDicomUid = (u) => typeof u === 'string' && u.length <= 64 && /^(0|[1-9]\d*)(\.(0|[1-9]\d*))+$/.test(u);

/** Nama pasien Khanza -> DICOM PN. Gelar sapaan Khanza (", TN") dibuang, hanya ASCII, maks 64. */
function toDicomName(name, upper = true) {
  let n = dcmText(String(name || '').replace(TITLE_SUFFIX, '').replace(/[\^=]/g, ' '), 64);
  if (upper) n = n.toUpperCase();
  return n;
}
/** Nama dokter -> PN (tanpa gelar dipisah, cukup komponen family). */
const toDicomPhysician = (name) => toDicomName(name, false).slice(0, 64);

/** Format ISO 8601 dengan offset zona waktu lokal, untuk FHIR. */
function toFhirDateTime(dt) {
  if (!dt) return undefined;
  const s = String(dt).replace(' ', 'T');
  const d = new Date(s);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${s.slice(0, 19)}${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = {
  pad, nowLocal, addDays, toDicomDate, toDicomTime, fromDicomDate, fromDicomTime, isZeroDate,
  generateUid, toDicomName, toDicomPhysician, toFhirDateTime, sleep,
  dcmText, dcmCs, dcmAe, dcmDate, dcmTime, isDicomUid,
};
