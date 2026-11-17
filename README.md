# RIS RSUD Hanau — Radiology Information System

RIS yang menghubungkan **SIMRS Khanza ⇄ alat radiologi ⇄ PACS Orthanc ⇄ SATUSEHAT** dengan standar
DICOM, HL7 v2 dan FHIR, mengikuti alur kerja **IHE Radiology Scheduled Workflow (SWF)**.

```
 SIMRS Khanza (sik)                     RIS RSUD HANAU                          Alat radiologi
 ───────────────────        ┌──────────────────────────────────┐      ───────────────────────────
 permintaan_radiologi ──►   │ Sinkron order (tiap 15 dtk)      │      CR / DX / CT / MR / US / MG
 + item pemeriksaan         │  · Accession Number (≤16 kar.)   │◄──── C-FIND  Modality Worklist
                            │  · Study Instance UID (2.25.x)   │◄──── N-CREATE/N-SET  MPPS
 tgl_sampel/jam_sampel ◄─── │ DICOM SCP  MWL + MPPS + C-ECHO   │
 hasil_radiologi       ◄─── │ Expertise radiolog (draft→final) │      ───────────────────────────
 gambar_radiologi      ◄─── │ Pemetaan standar                 │ ───► C-STORE gambar ke PACS
 periksa_radiologi*    ◄─── │  Khanza → DICOM/LOINC/SNOMED CT  │
                            │ HL7 v2 MLLP  ORM▶  ◀ORU          │◄───► PACS / broker HL7
                            │ Monitor Orthanc (/changes)       │◄──── PACS Orthanc (REST)
                            │ SATUSEHAT FHIR R4                │ ───► ServiceRequest, Observation,
                            └──────────────────────────────────┘      DiagnosticReport (+ DICOM Router)
 * opsional (billing)
```

## Fitur

| Area | Isi |
|---|---|
| Order | Dikirim dari Khanza lewat tombol **Kirim ke RIS** (default, `SYNC_MODE=manual`) atau sinkron otomatis (`SYNC_MODE=auto`) dari `permintaan_radiologi` + `permintaan_pemeriksaan_radiologi`. Satu item pemeriksaan = satu Requested Procedure dengan Accession & Study UID sendiri. Deteksi CITO/IGD, pembatalan otomatis bila order dihapus di Khanza. |
| DICOM | **Modality Worklist SCP** (C-FIND, PS3.4 Annex K) dengan proyeksi atribut sesuai kunci yang diminta alat, pencocokan wildcard/rentang tanggal, filter per AE/modalitas (CR≈DX). **MPPS SCP** (N-CREATE/N-SET): status otomatis, jumlah gambar, kV/mAs/dosis. Penolakan AE yang tidak terdaftar. |
| PACS | Memantau Orthanc `StableStudy`; cocokkan via Accession → Study UID → No.RM+tanggal. Study tak cocok masuk **Rekonsiliasi** (tautkan + koreksi tag di PACS). Link viewer (OHIF/Stone/Explorer). Preview JPG ke `gambar_radiologi`. |
| Expertise | Editor radiolog dengan template, draft → verifikasi → revisi berversi (riwayat lengkap), cetak hasil berkop RS. Hanya akun radiolog yang tertaut `kd_dokter` yang dapat memverifikasi. |
| Khanza | Tulis `tgl_sampel/jam_sampel` saat mulai periksa, `hasil_radiologi` + `tgl_hasil` saat verifikasi (otomatis memakai kunci `tgl_periksa/jam` dari `periksa_radiologi` yang diinput petugas). Opsional membuat baris `periksa_radiologi` (tarif dari master). |
| HL7 v2 | Kirim **ORM^O01** (NW/CA/XO) ke PACS/broker/alat (OBR-18 Accession, OBR-19 RP ID, OBR-20 SPS ID, OBR-24 modality, ZDS Study UID). Terima **ORU^R01** (hasil dari PACS) & ORM status. ACK otomatis, log lengkap. |
| Pemetaan standar | Per `kd_jenis_prw`: DICOM Modality (CID 29), Body Part Examined, **LOINC**, **SNOMED CT** body site, RadLex Playbook, kode protokol alat, kode pemeriksaan nasional. |
| SATUSEHAT | ServiceRequest (identifier lokal + **ACSN**, orderDetail modality & AE Title) → forward study ke **DICOM Router** → cari **ImagingStudy** by ACSN → **Observation** + **DiagnosticReport** (RAD). Otomatis dengan retry, atau tombol manual per langkah. |
| Operasional | Peran admin/radiografer/radiolog/viewer, log DICOM/HL7/SATUSEHAT, halaman status layanan, simulator alat untuk uji. |

## Kebutuhan

- Node.js ≥ 18 (diuji di Node 22)
- MySQL 5.7+/MariaDB 10.3+ untuk database RIS (boleh server yang sama dengan Khanza, database terpisah)
- Akses jaringan ke MySQL Khanza, Orthanc (REST 8042) dan alat (port DICOM RIS)
- Orthanc ≥ 1.9 (diuji 1.12) — opsional plugin OHIF/Stone untuk viewer

## Instalasi

```bash
# 1. kode
sudo mkdir -p /opt/ris-hanau && sudo cp -r . /opt/ris-hanau && cd /opt/ris-hanau
npm install --omit=dev

# 2. database RIS
mysql -u root -p < db/ris_schema.sql
mysql -u root -p -e "CREATE USER 'ris'@'localhost' IDENTIFIED BY 'xxx'; GRANT ALL ON ris_hanau.* TO 'ris'@'localhost';"

# 3. user khusus di database Khanza (hak akses minimal) — edit IP & password dulu
mysql -h <server-khanza> -u root -p < db/khanza_grants.sql

# 4. konfigurasi
cp .env.example .env && nano .env

# 5. akun pertama
node scripts/create-user.js admin 'PasswordKuat' admin "Administrator"
node scripts/create-user.js drrina 'xxx' radiolog "dr. Rina W, Sp.Rad" D002     # D002 = kd_dokter di Khanza
node scripts/create-user.js rudi 'xxx' radiografer "Rudi" "" P001               # P001 = nip petugas

# 6. jalankan (systemd)
sudo cp deploy/ris-hanau.service /etc/systemd/system/ && sudo systemctl enable --now ris-hanau
# web: http://<ip-server>:8090
```

## Langkah setelah instalasi

1. **Alat / Modalitas** — daftarkan setiap alat dengan AE Title yang sama persis seperti di alat.
2. **Pemetaan Prosedur** — petakan seluruh `jns_perawatan_radiologi` (filter "belum dipetakan"). LOINC wajib untuk SATUSEHAT; ambil kode berkategori *Permintaan* dari file Terminologi Radiologi SATUSEHAT. Tiga baris contoh (`RAD001–003`) di skema hanyalah contoh — sesuaikan kodenya.
3. **Konfigurasi di alat** (menu DICOM/Network/Worklist di konsol alat):

| Setelan di alat | Nilai |
|---|---|
| Worklist (MWL) SCP — AE / IP / Port | `DICOM_AE_TITLE` / IP server RIS / `DICOM_PORT` (default `RISHANAU` / … / `11113`) |
| MPPS SCP — AE / IP / Port | sama dengan worklist |
| Storage SCP (kirim gambar) | Orthanc: AE `ORTHANC`, port `4242` |
| AE Title alat | sesuai yang didaftarkan di menu Alat |

   Uji dari alat: tombol *Verify/Echo* ke RIS harus sukses; lalu *Query Worklist*. Bila ditolak, cek **Log Integrasi → DICOM** (AE belum terdaftar akan tercatat `ASSOC-REJECT`).
4. **Orthanc** — lihat `deploy/orthanc.json.example` (user REST, `StableAge`, entri `SATUSEHAT` untuk DICOM Router). Isi `ORTHANC_URL/USER/PASS` dan `VIEWER_URL_TEMPLATE` (placeholder `{studyUid}`, `{accession}`, `{orthancId}`).
5. **SATUSEHAT** — isi client id/secret & Organization ID, set `SATUSEHAT_ROUTER_MODALITY` ke nama modality DICOM Router di Orthanc. Prasyarat: Encounter kunjungan sudah dikirim modul Satu Sehat Khanza (tabel `satu_sehat_encounter`), NIK pasien & NIK dokter (`pegawai.no_ktp`) terisi.

## Alur kerja harian

1. Dokter membuat permintaan radiologi di Khanza → petugas menekan **Kirim ke RIS** → langsung muncul di **Worklist** RIS dan di worklist alat (mode `auto`: ≤15 detik tanpa tombol).
2. Radiografer memilih pasien di alat (data terisi otomatis dari MWL) → MPPS *IN PROGRESS* → status **Diperiksa**, Khanza `tgl_sampel` terisi.
3. Gambar dikirim ke PACS → RIS menandai **Selesai periksa** (untuk alat tanpa MPPS, gambar masuk = selesai; atau tombol manual).
4. Radiolog membuka order → **Buka Viewer** → isi expertise / pilih template → **Verifikasi** → hasil masuk `hasil_radiologi` Khanza dan (bila aktif) SATUSEHAT.
5. Study yang tidak cocok muncul di **Rekonsiliasi PACS** (badge merah di menu).

## Kirim order dari Khanza (tombol "Kirim ke RIS")

Default `SYNC_MODE=manual`: RIS **tidak** menarik order sendiri. Order baru masuk saat petugas menekan tombol di Khanza:

```
Khanza [Kirim ke RIS] --POST /api/khanza/order--> RIS --> ris_orders (SCHEDULED)
                                                       |--> Worklist MWL: alat query -> pasien langsung tampil
                                                       '--> HL7 ORM^O01 NW (bila HL7_OUT_* diisi)
```

1. Isi `.env`: `KHANZA_API_KEY=<kunci acak panjang>` (opsional `KHANZA_API_ALLOW=ip-pc-khanza,...`), restart RIS.
2. Pasang `khanza-addon/RisBridge.java` + `setting/ris.properties` di Khanza dan tambahkan tombolnya — lihat `khanza-addon/README.md`.
3. Item berkode awalan `BHP` (billing cetak film/BHP) **tidak** dikirim ke alat dan tidak dipetakan — atur lewat `SYNC_EXCLUDE_KD=BHP,...`.
4. Kirim ulang aman (idempoten): item baru ditambahkan, item yang dihapus di Khanza dibatalkan, item yang sudah diperiksa tidak diubah.
5. Tanpa ubah Khanza: menu **Worklist → + Ambil dari Khanza** di RIS, ketik No. Order.

Alat tetap mengambil data lewat **Query Worklist** (C-FIND) — begitulah standar DICOM MWL; begitu tombol ditekan, query berikutnya dari alat sudah memuat pasien tersebut.
Uji cepat: `curl -X POST http://<ris>:8090/api/khanza/order -H "X-RIS-Key: <kunci>" -H "Content-Type: application/json" -d '{"noorder":"PR20261104004"}'`

## Catatan kunci hasil di Khanza

Khanza menyimpan hasil per `(no_rawat, tgl_periksa, jam)` — harus sama dengan baris `periksa_radiologi` agar tampil di form Khanza. RIS menentukannya berurutan:
1. baris `periksa_radiologi` yang sudah diinput petugas (no_rawat + kd_jenis_prw) — **disarankan**;
2. bila `KHANZA_WRITE_PERIKSA=true`, RIS membuat baris itu sendiri (tarif dari master, kV/mAs dari MPPS) — pastikan tidak terjadi double input billing;
3. selain itu memakai waktu pemeriksaan + peringatan di jejak order.

Beberapa pemeriksaan pada kunci yang sama digabung dalam satu `hasil_radiologi`.

## Format Accession Number

Default `ACCESSION_FORMAT=khanza` mengikuti modul Orthanc SIMRS Khanza (`orthanc.UbahAccession`):

```
noorder tanpa "PR" + kd_jenis_prw      PR20261104004 + J000081  ->  20261104004J000081
                                       PR20261102001 + BHP.02   ->  20261102001BHP02   (titik, strip, spasi dibuang)
```

Accession ini unik per item pemeriksaan dan dipakai di RIS, Khanza dan hasil.

**Accession untuk alat (maks 16 karakter).** Standar DICOM membatasi AccessionNumber 16 karakter (VR SH).
Bila format Khanza lebih panjang, RIS memberi alat accession pendek di kolom `dicom_accession`:

```
noorder tanpa "PR" + nomor urut item     PR202611044020 item 1  ->  20261104402001  (14 karakter)
```

Nilai yang sama dipakai untuk Requested Procedure ID, SPS ID, HL7 ORM (OBR-18) dan ACSN SATUSEHAT, karena itulah
yang tertulis di gambar DICOM. MPPS, gambar dan HL7 dicocokkan ke order lewat Study UID / SPS ID / kedua accession.
Accession yang sudah <= 16 karakter dipakai apa adanya.

**Keamanan data ke alat.** Semua nilai worklist dibersihkan sesuai VR DICOM: hanya ASCII, tanpa `\\` dan karakter kontrol,
dipotong sesuai panjang maksimal (SH 16, LO/PN 64), tanggal/jam divalidasi. Order dengan data wajib rusak
(Study UID tidak valid, No. RM kosong) dilewati dan dicatat di Log Integrasi → DICOM tanpa menggagalkan worklist lain.
`ACCESSION_FORMAT=ris` memakai format lama `HNyymmddNNNN`.

Memperbarui instalasi lama ke format ini:

```bash
mysql --force -u root -p ris_hanau < db/migrations/2026-11-04_accession_khanza.sql
node scripts/migrate-accession-khanza.js           # lihat rencana
node scripts/migrate-accession-khanza.js --apply   # ganti accession order yang masih Terjadwal
```

Order yang sudah diperiksa / punya gambar tetap memakai accession lama (gambarnya sudah membawa nilai itu).

## Uji tanpa alat fisik

```bash
# simulator alat: C-FIND worklist -> MPPS IN PROGRESS -> C-STORE gambar sintetis ke PACS -> MPPS COMPLETED
node scripts/simulate-modality.js --ris 127.0.0.1:11113 --aec RISHANAU --aet CR_FUJI --pacs 127.0.0.1:4242
node scripts/simulate-modality.js --aet CR_FUJI --list                  # hanya lihat worklist

# dcmtk
echoscu -aet CR_FUJI -aec RISHANAU <ip-ris> 11113
findscu -W -aet CR_FUJI -aec RISHANAU <ip-ris> 11113 -k "ScheduledProcedureStepSequence[0].Modality=" -k PatientName= -k AccessionNumber=

# HL7 ORU (hasil dari PACS)
node scripts/hl7-send.js scripts/sample-oru.hl7 127.0.0.1 2575
```

`db/khanza_mock_dev.sql` berisi subset tabel Khanza + data contoh untuk lingkungan uji (**jangan** dijalankan di server produksi).

## Struktur kode

```
src/
  server.js                 start semua layanan
  config.js                 konfigurasi (.env)
  khanza/khanzaRepo.js      SEMUA SQL ke database Khanza (sesuaikan di sini bila versi berbeda)
  services/orderSync.js     Khanza -> ris_orders (pushOrder manual / polling auto)
  services/orderService.js  status, event bus, accession
  services/mppsService.js   logika MPPS
  services/reportService.js expertise draft/final/revisi
  services/khanzaWriteback.js  tulis hasil/gambar/periksa ke Khanza
  services/mappingService.js   pemetaan standar
  dicom/scp.js, worklist.js MWL + MPPS SCP (dcmjs-dimse)
  hl7/                      parser/builder HL7, MLLP, ORM/ORU
  pacs/orthanc.js           REST Orthanc, rekonsiliasi, forward
  satusehat/                OAuth2, mapper FHIR, orkestrasi
  routes/api.js             REST API web
public/                     UI web (tanpa build step)
scripts/                    create-user, simulator alat, kirim HL7
db/                         skema RIS, grants Khanza, mock dev
deploy/                     systemd, contoh konfigurasi Orthanc
```

## Keamanan

- Gunakan user MySQL Khanza dengan hak minimal (`db/khanza_grants.sql`); kolom `permintaan_radiologi` yang bisa di-update hanya kolom waktu.
- Ganti `JWT_SECRET`, jalankan web di belakang reverse proxy HTTPS bila diakses lintas jaringan.
- Batasi port DICOM/HL7 ke VLAN radiologi lewat firewall; `DICOM_ACCEPT_UNKNOWN_AE=false` menolak AE tak dikenal.

## Yang perlu diverifikasi di RS

- Versi skema Khanza RS (kolom `periksa_radiologi` / `hasil_radiologi` / `gambar_radiologi` bisa sedikit berbeda antar versi) — semua query ada di `src/khanza/khanzaRepo.js`.
- Kode LOINC & SNOMED CT per pemeriksaan terhadap Terminologi Radiologi SATUSEHAT terbaru.
- URL endpoint SATUSEHAT (staging/production) di `.env`.
- Uji MWL/MPPS dengan setiap merk alat (DICOM Conformance Statement alat) — beberapa alat lama hanya mendukung MWL tanpa MPPS; gunakan tombol status manual atau biarkan status otomatis dari kedatangan gambar.
# RIS
