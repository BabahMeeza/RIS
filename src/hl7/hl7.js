'use strict';
/** Parser & builder HL7 v2.x (ER7 / pipe-delimited) minimal tanpa dependensi. */

const ESC = [['\\', '\\E\\'], ['|', '\\F\\'], ['^', '\\S\\'], ['&', '\\T\\'], ['~', '\\R\\']];

function escape(v) {
  if (v === undefined || v === null) return '';
  let s = String(v);
  for (const [c, e] of ESC) s = s.split(c).join(e);
  return s.replace(/\r?\n/g, '\\.br\\');
}
function unescape(v) {
  if (!v) return '';
  return String(v)
    .replace(/\\\.br\\/gi, '\n').replace(/\\F\\/g, '|').replace(/\\S\\/g, '^')
    .replace(/\\T\\/g, '&').replace(/\\R\\/g, '~').replace(/\\E\\/g, '\\');
}

/** Hasil parse: { segments: [{ name, fields: [...] }], get(seg, field, comp, idx) } */
function parse(raw) {
  const text = String(raw).replace(/^\x0b/, '').replace(/\x1c\r?$/, '').replace(/\r\n|\n/g, '\r');
  const lines = text.split('\r').filter((l) => l.trim());
  if (!lines.length || !lines[0].startsWith('MSH')) throw new Error('Pesan HL7 tidak diawali MSH');
  const fs = lines[0][3];
  const cs = lines[0][4] || '^';
  const segments = lines.map((line) => {
    const parts = line.split(fs);
    const name = parts[0];
    // Untuk MSH, field 1 adalah separator itu sendiri -> sisipkan agar penomoran sesuai standar
    const fields = name === 'MSH' ? ['MSH', fs, ...parts.slice(1)] : parts;
    return { name, fields };
  });
  const msg = {
    segments,
    all: (name) => segments.filter((s) => s.name === name),
    seg: (name, i = 0) => segments.filter((s) => s.name === name)[i],
    get(name, field, comp = 1, i = 0) {
      const s = msg.seg(name, i);
      if (!s) return '';
      const f = s.fields[field] || '';
      if (comp === 0) return f;
      return unescape((f.split('~')[0].split(cs)[comp - 1]) || '');
    },
  };
  msg.type = `${msg.get('MSH', 9, 1)}^${msg.get('MSH', 9, 2)}`;
  msg.controlId = msg.get('MSH', 10);
  return msg;
}

const comp = (...c) => c.map(escape).join('^').replace(/\^+$/, '');
const seg = (...fields) => fields.map((f) => (f === undefined || f === null ? '' : f)).join('|').replace(/\|+$/, '');

function ts(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
/** 'YYYY-MM-DD HH:MM:SS' -> HL7 TS */
const dbToTs = (s) => (s ? String(s).replace(/[-: ]/g, '').slice(0, 14) : '');

let ctr = 0;
const newControlId = () => `${ts()}${String(++ctr % 10000).padStart(4, '0')}`;

function msh({ sendingApp, sendingFac, receivingApp, receivingFac, type, controlId, version }) {
  return seg('MSH', '^~\\&', sendingApp, sendingFac, receivingApp, receivingFac, ts(), '', type, controlId, 'P', version);
}

function ack(inMsg, code = 'AA', text = '', opts = {}) {
  const controlId = newControlId();
  return [
    msh({
      sendingApp: inMsg.get('MSH', 5) || opts.sendingApp, sendingFac: inMsg.get('MSH', 6),
      receivingApp: inMsg.get('MSH', 3), receivingFac: inMsg.get('MSH', 4),
      type: `ACK^${inMsg.get('MSH', 9, 2)}`, controlId, version: inMsg.get('MSH', 12) || '2.3.1',
    }),
    seg('MSA', code, inMsg.controlId, escape(text)),
  ].join('\r');
}

module.exports = { parse, escape, unescape, comp, seg, ts, dbToTs, msh, ack, newControlId };
