'use strict';
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const config = require('./config');
const db = require('./lib/db');
const khanza = require('./khanza/khanzaRepo');

const publicUser = (u) => ({ id: u.id, username: u.username, full_name: u.full_name, role: u.role, kd_dokter: u.kd_dokter, nip: u.nip });

async function login(username, password) {
  const u = await db.risOne('SELECT * FROM ris_users WHERE username=? AND active=1', [username]);
  let ok = false;
  if (u && u.password_hash) ok = await bcrypt.compare(password, u.password_hash);
  else if (u && config.auth.mode === 'khanza') ok = await khanza.checkKhanzaLogin(username, password);
  if (!ok) throw Object.assign(new Error('Username atau password salah'), { status: 401 });
  await db.risQuery('UPDATE ris_users SET last_login_at=NOW() WHERE id=?', [u.id]);
  const token = jwt.sign({ uid: u.id }, config.auth.jwtSecret, { expiresIn: `${config.auth.tokenHours}h` });
  return { token, user: publicUser(u) };
}

function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : req.query.token;
  if (!t) return res.status(401).json({ error: 'Belum login' });
  let payload;
  try { payload = jwt.verify(t, config.auth.jwtSecret); } catch { return res.status(401).json({ error: 'Sesi berakhir, silakan login ulang' }); }
  db.risOne('SELECT * FROM ris_users WHERE id=? AND active=1', [payload.uid])
    .then((u) => {
      if (!u) return res.status(401).json({ error: 'Akun tidak aktif' });
      req.user = publicUser(u);
      next();
    })
    .catch(next);
}

const requireRole = (...roles) => (req, res, next) =>
  req.user && (roles.includes(req.user.role) || req.user.role === 'admin')
    ? next()
    : res.status(403).json({ error: `Akses khusus: ${roles.join(', ')}` });

const hashPassword = (p) => bcrypt.hash(p, 10);

module.exports = { login, requireAuth, requireRole, hashPassword, publicUser };
