'use strict';
/** Transport MLLP (Minimal Lower Layer Protocol) untuk HL7 v2: <VT> pesan <FS><CR> */
const net = require('net');

const VT = 0x0b, FS = 0x1c, CR = 0x0d;
const frame = (msg) => Buffer.concat([Buffer.from([VT]), Buffer.from(msg, 'latin1'), Buffer.from([FS, CR])]);

/** Server MLLP. handler(message:string, socket) -> Promise<string ack> */
function createServer(handler, onError = () => {}) {
  return net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    socket.on('data', async (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      let start, end;
      while ((start = buf.indexOf(VT)) !== -1 && (end = buf.indexOf(FS, start)) !== -1) {
        const msg = buf.slice(start + 1, end).toString('latin1');
        buf = buf.slice(end + (buf[end + 1] === CR ? 2 : 1));
        try {
          const reply = await handler(msg, socket);
          if (reply) socket.write(frame(reply));
        } catch (e) { onError(e); }
      }
      if (buf.length > 10 * 1024 * 1024) buf = Buffer.alloc(0); // proteksi
    });
    socket.on('error', onError);
  });
}

/** Kirim satu pesan dan tunggu ACK. */
function send(host, port, message, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port });
    let buf = Buffer.alloc(0);
    const done = (err, val) => { clearTimeout(t); sock.destroy(); err ? reject(err) : resolve(val); };
    const t = setTimeout(() => done(new Error(`Timeout menunggu ACK dari ${host}:${port}`)), timeoutMs);
    sock.on('connect', () => sock.write(frame(message)));
    sock.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      const s = buf.indexOf(VT), e = buf.indexOf(FS, s + 1);
      if (s !== -1 && e !== -1) done(null, buf.slice(s + 1, e).toString('latin1'));
    });
    sock.on('error', (e) => done(e));
  });
}

module.exports = { createServer, send, frame };
