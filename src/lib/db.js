'use strict';
const mysql = require('mysql2/promise');
const config = require('../config');

const common = { waitForConnections: true, connectionLimit: 10, dateStrings: true, charset: 'utf8mb4' };

const ris = mysql.createPool({ ...config.risDb, ...common });
// Tabel Khanza umumnya latin1; koneksi utf8mb4 membuat server mengonversi otomatis.
// dateStrings: tanggal dibaca apa adanya (tanpa konversi zona waktu).
const khanza = mysql.createPool({ ...config.khanzaDb, ...common, connectionLimit: 5 });

async function q(pool, sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

module.exports = {
  ris, khanza,
  risQuery: (sql, p) => q(ris, sql, p),
  khanzaQuery: (sql, p) => q(khanza, sql, p),
  risOne: async (sql, p) => (await q(ris, sql, p))[0] || null,
  khanzaOne: async (sql, p) => (await q(khanza, sql, p))[0] || null,
  async getSetting(k, d = null) {
    const r = await q(ris, 'SELECT v FROM ris_settings WHERE k=?', [k]);
    return r.length ? r[0].v : d;
  },
  async setSetting(k, v) {
    await q(ris, 'INSERT INTO ris_settings (k,v) VALUES (?,?) ON DUPLICATE KEY UPDATE v=VALUES(v)', [k, String(v)]);
  },
};
