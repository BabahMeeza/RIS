'use strict';
/**
 * Semua akses SQL ke database SIMRS Khanza (sik) dikumpulkan di file ini,
 * sehingga mudah disesuaikan bila versi Khanza di RS berbeda.
 *
 * Tabel yang DIBACA : permintaan_radiologi, permintaan_pemeriksaan_radiologi,
 *                     jns_perawatan_radiologi, reg_periksa, pasien, dokter,
 *                     poliklinik, penjab, kamar_inap/kamar/bangsal, pegawai,
 *                     periksa_radiologi, satu_sehat_encounter, user
 * Tabel yang DITULIS: permintaan_radiologi (tgl_sampel/jam_sampel, tgl_hasil/jam_hasil),
 *                     hasil_radiologi, gambar_radiologi,
 *                     periksa_radiologi (HANYA jika KHANZA_WRITE_PERIKSA=true)
 */
const db = require('../lib/db');

const ORDER_SQL = `
SELECT pr.noorder, pr.no_rawat, pr.tgl_permintaan, pr.jam_permintaan, pr.dokter_perujuk,
       pr.status AS status_rawat, pr.informasi_tambahan, pr.diagnosa_klinis,
       ppr.kd_jenis_prw, j.nm_perawatan,
       rp.no_rkm_medis, rp.kd_poli, rp.kd_pj,
       p.nm_pasien, p.jk, p.tgl_lahir, p.no_ktp, p.alamat,
       d.nm_dokter AS nm_perujuk, pl.nm_poli, pj.png_jawab,
       (SELECT b.nm_bangsal FROM kamar_inap ki
          JOIN kamar k ON k.kd_kamar = ki.kd_kamar
          JOIN bangsal b ON b.kd_bangsal = k.kd_bangsal
         WHERE ki.no_rawat = pr.no_rawat
         ORDER BY ki.tgl_masuk DESC, ki.jam_masuk DESC LIMIT 1) AS nm_bangsal
  FROM permintaan_radiologi pr
  JOIN permintaan_pemeriksaan_radiologi ppr ON ppr.noorder = pr.noorder
  JOIN jns_perawatan_radiologi j ON j.kd_jenis_prw = ppr.kd_jenis_prw
  JOIN reg_periksa rp ON rp.no_rawat = pr.no_rawat
  JOIN pasien p ON p.no_rkm_medis = rp.no_rkm_medis
  LEFT JOIN dokter d ON d.kd_dokter = pr.dokter_perujuk
  LEFT JOIN poliklinik pl ON pl.kd_poli = rp.kd_poli
  LEFT JOIN penjab pj ON pj.kd_pj = rp.kd_pj
 WHERE %WHERE%
 ORDER BY pr.tgl_permintaan, pr.jam_permintaan, pr.noorder, ppr.kd_jenis_prw`;

module.exports = {
  /** Permintaan radiologi (per item pemeriksaan) sejak tanggal tertentu. */
  listOrdersSince: (sinceDate) => db.khanzaQuery(ORDER_SQL.replace('%WHERE%', 'pr.tgl_permintaan >= ?'), [sinceDate]),

  /** Semua item pemeriksaan untuk satu noorder (dipakai tombol "Kirim ke RIS" di Khanza). */
  listOrdersByNoorder: (noorder) => db.khanzaQuery(ORDER_SQL.replace('%WHERE%', 'pr.noorder = ?'), [noorder]),

  listProcedures: () =>
    db.khanzaQuery(
      `SELECT kd_jenis_prw, nm_perawatan, total_byr, status FROM jns_perawatan_radiologi ORDER BY nm_perawatan`
    ),

  getProcedure: (kd) => db.khanzaOne(`SELECT * FROM jns_perawatan_radiologi WHERE kd_jenis_prw=?`, [kd]),

  listDoctors: () => db.khanzaQuery(`SELECT kd_dokter, nm_dokter FROM dokter ORDER BY nm_dokter`),

  getDoctor: (kd) => db.khanzaOne(`SELECT kd_dokter, nm_dokter FROM dokter WHERE kd_dokter=?`, [kd]),

  /** NIK dokter: di Khanza dokter.kd_dokter = pegawai.nik */
  async getDoctorNik(kdDokter) {
    const r = await db.khanzaOne(`SELECT no_ktp FROM pegawai WHERE nik=?`, [kdDokter]);
    return r ? r.no_ktp : null;
  },

  /** ID Encounter Satu Sehat yang sudah dikirim oleh modul Satu Sehat Khanza. */
  async getEncounterId(noRawat) {
    try {
      const r = await db.khanzaOne(`SELECT id_encounter FROM satu_sehat_encounter WHERE no_rawat=?`, [noRawat]);
      return r ? r.id_encounter : null;
    } catch (e) {
      if (e.code === 'ER_NO_SUCH_TABLE') return null;
      throw e;
    }
  },

  /** Tandai pemeriksaan dimulai (Khanza memakai tgl_sampel sebagai "sudah dilayani"). */
  markSampel: (noorder, date, time) =>
    db.khanzaQuery(
      `UPDATE permintaan_radiologi SET tgl_sampel=?, jam_sampel=?
        WHERE noorder=? AND (tgl_sampel IS NULL OR tgl_sampel < '1900-01-01')`,
      [date, time, noorder]
    ),

  markHasil: (noorder, date, time) =>
    db.khanzaQuery(`UPDATE permintaan_radiologi SET tgl_hasil=?, jam_hasil=? WHERE noorder=?`, [date, time, noorder]),

  /** Baris periksa_radiologi terbaru untuk no_rawat + jenis pemeriksaan (diinput petugas di Khanza). */
  findPeriksa: (noRawat, kdJenisPrw, sinceDate) =>
    db.khanzaOne(
      `SELECT tgl_periksa, jam FROM periksa_radiologi
        WHERE no_rawat=? AND kd_jenis_prw=? AND tgl_periksa>=?
        ORDER BY tgl_periksa DESC, jam DESC LIMIT 1`,
      [noRawat, kdJenisPrw, sinceDate]
    ),

  /** Membuat baris periksa_radiologi (billing) dengan tarif dari master. */
  async insertPeriksa({ noRawat, nip, kdJenisPrw, tgl, jam, dokterPerujuk, kdDokter, statusRawat, kv, mas, dosis }) {
    const t = await module.exports.getProcedure(kdJenisPrw);
    if (!t) throw new Error(`Tarif ${kdJenisPrw} tidak ditemukan di jns_perawatan_radiologi`);
    await db.khanzaQuery(
      `INSERT INTO periksa_radiologi
        (no_rawat, nip, kd_jenis_prw, tgl_periksa, jam, dokter_perujuk, bagian_rs, bhp, tarif_perujuk,
         tarif_tindakan_dokter, tarif_tindakan_petugas, kso, menejemen, biaya, kd_dokter, status,
         proyeksi, kV, mAS, FFD, BSF, inak, jml_penyinaran, dosis)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'',?,?,'','','','',?)`,
      [noRawat, nip, kdJenisPrw, tgl, jam, dokterPerujuk || '-', t.bagian_rs, t.bhp, t.tarif_perujuk,
        t.tarif_tindakan_dokter, t.tarif_tindakan_petugas, t.kso, t.menejemen, t.total_byr, kdDokter,
        statusRawat === 'ranap' ? 'Ranap' : 'Ralan', kv || '', mas || '', dosis || '']
    );
  },

  upsertHasil: (noRawat, tgl, jam, hasil) =>
    db.khanzaQuery(
      `INSERT INTO hasil_radiologi (no_rawat, tgl_periksa, jam, hasil) VALUES (?,?,?,?)
       ON DUPLICATE KEY UPDATE hasil=VALUES(hasil)`,
      [noRawat, tgl, jam, hasil]
    ),

  insertGambar: (noRawat, tgl, jam, lokasi) =>
    db.khanzaQuery(
      `INSERT IGNORE INTO gambar_radiologi (no_rawat, tgl_periksa, jam, lokasi_gambar) VALUES (?,?,?,?)`,
      [noRawat, tgl, jam, lokasi]
    ),

  /** Login dengan akun SIMRS Khanza (tabel `user`, enkripsi AES bawaan Khanza). */
  async checkKhanzaLogin(username, password) {
    const r = await db.khanzaOne(
      `SELECT AES_DECRYPT(id_user,'nur') AS u FROM user
        WHERE id_user=AES_ENCRYPT(?,'nur') AND password=AES_ENCRYPT(?,'windi')`,
      [username, password]
    );
    return !!r;
  },
};
