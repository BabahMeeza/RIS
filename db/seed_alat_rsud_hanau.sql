-- =====================================================================
--  Master alat radiologi RSUD Hanau (sumber: KTUN BAPETEN 07777.384.3.080825)
--  Jalankan: mysql -u root -p ris_hanau < db/seed_alat_rsud_hanau.sql
--  Aman dijalankan ulang (memperbarui baris dengan AE Title yang sama).
--
--  IP ALAT MASIH DEFAULT (192.168.10.201-205) -> ganti sesuai IP sebenarnya
--  lewat menu Alat / Modalitas di RIS. RIS hanya memeriksa AE Title saat alat
--  meminta worklist; kolom IP dipakai sebagai catatan.
--
--  ISIAN DI SETIAP ALAT (menu DICOM / Network / Worklist / RIS):
--    Worklist (MWL) server : AE Title RISHANAU, IP server RIS, port 11113
--    MPPS server           : AE Title RISHANAU, IP server RIS, port 11113
--    Storage / PACS        : AE Title ORTHANC,  IP server PACS, port 4242
--    AE Title alat sendiri : sesuai kolom ae_title di bawah (harus sama persis)
-- =====================================================================
INSERT INTO ris_modalities
  (ae_title, name, modality, room, ip_address, port, manufacturer, model, station_name, active)
VALUES
  ('CR_GE_TMX',       'X-Ray Mobile GE TMX+ (via CR reader)', 'CR', 'Ruang Pemeriksaan 1', '192.168.10.201', 104, 'GE',         'TMX+ (2393199) SN 393-16-009-2059',   'GETMX',     1),
  ('DX_DRGEM_R2',     'X-Ray DR-GEM GXR-U40S',               'DX', 'Ruang Pemeriksaan 2', '192.168.10.202', 104, 'DR-GEM',     'GXR-U40S SN DXK2030004A',             'DRGEMR2',   1),
  ('PX_CS8100',       'Panoramic Carestream CS 8100SC',      'PX', 'Ruang Pemeriksaan 1', '192.168.10.203', 104, 'Carestream', 'CS 8100SC SN HKIG374',                'CS8100',    1),
  ('CT_IQON',         'CT Scan Philips IQon Spectral',       'CT', 'Ruang CT Scan',       '192.168.10.204', 104, 'Philips',    'IQon Spectral CT SN 395008',          'IQON',      1),
  ('DX_WDR_MOBILE',   'X-Ray Mobile Philips MobileDiagnost wDR', 'DX', 'Ruang Pemeriksaan 2', '192.168.10.205', 104, 'Philips', 'MobileDiagnost wDR SN 24410050', 'WDRMOBILE', 1)
ON DUPLICATE KEY UPDATE
  name=VALUES(name), modality=VALUES(modality), room=VALUES(room), manufacturer=VALUES(manufacturer),
  model=VALUES(model), station_name=VALUES(station_name), active=VALUES(active);
