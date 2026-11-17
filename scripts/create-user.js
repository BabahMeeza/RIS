#!/usr/bin/env node
'use strict';
// Pemakaian: node scripts/create-user.js <username> <password> <role> "<nama lengkap>" [kd_dokter] [nip]
// role: admin | radiografer | radiolog | viewer
const db = require('../src/lib/db');
const { hashPassword } = require('../src/auth');

(async () => {
  const [username, password, role = 'admin', fullName = username, kdDokter = null, nip = null] = process.argv.slice(2);
  if (!username || !password) {
    console.log('Pemakaian: node scripts/create-user.js <username> <password> <role> "<nama>" [kd_dokter] [nip]');
    process.exit(1);
  }
  await db.risQuery(
    `INSERT INTO ris_users (username, password_hash, full_name, role, kd_dokter, nip) VALUES (?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE password_hash=VALUES(password_hash), full_name=VALUES(full_name), role=VALUES(role), kd_dokter=VALUES(kd_dokter), nip=VALUES(nip), active=1`,
    [username, await hashPassword(password), fullName, role, kdDokter || null, nip || null]
  );
  console.log(`User ${username} (${role}) tersimpan`);
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
