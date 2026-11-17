#!/usr/bin/env node
'use strict';
// Kirim pesan HL7 dari file ke listener MLLP (uji ORU^R01 dari PACS, dsb.)
// Pemakaian: node scripts/hl7-send.js <file.hl7> [host] [port]
const fs = require('fs');
const mllp = require('../src/hl7/mllp');

const [file, host = '127.0.0.1', port = '2575'] = process.argv.slice(2);
if (!file) { console.log('Pemakaian: node scripts/hl7-send.js <file.hl7> [host] [port]'); process.exit(1); }
const msg = fs.readFileSync(file, 'latin1').replace(/\r?\n/g, '\r').trim();
mllp.send(host, +port, msg)
  .then((ack) => console.log('ACK:\n' + ack.replace(/\r/g, '\n')))
  .catch((e) => { console.error('Gagal:', e.message); process.exit(1); });
