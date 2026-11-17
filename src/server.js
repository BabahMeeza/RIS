'use strict';
const path = require('path');
const express = require('express');
const config = require('./config');
const log = require('./lib/logger')('ris');
const db = require('./lib/db');

const sync = require('./services/orderSync');
const reportService = require('./services/reportService');
const scp = require('./dicom/scp');
const hl7 = require('./hl7/hl7Service');
const orthanc = require('./pacs/orthanc');
const satusehat = require('./satusehat/satusehatService');

async function main() {
  await db.risQuery('SELECT 1').catch((e) => {
    log.error(`Tidak dapat terhubung ke database RIS ${config.risDb.host}/${config.risDb.database}`, e);
    process.exit(1);
  });
  await require('./lib/schema').ensureSchema();
  if (config.sync.accessionFormat === 'khanza') await require('./services/accessionMigration').autoMigrate();
  const nAcc = await require('./services/orderService').backfillDicomAccession().catch((e) => { log.error('Accession alat gagal dibuat', e); return 0; });
  if (nAcc) log.info(`${nAcc} order Terjadwal diberi accession alat <= 16 karakter`);

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', require('./routes/api'));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.listen(config.http.port, () => {
    // 0.0.0.0 = menerima di semua IP komputer ini; tampilkan alamat yang benar-benar bisa dibuka
    const ips = Object.values(require('os').networkInterfaces()).flat()
      .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
    log.info(`Web RIS ${config.hospital.name} siap. Buka di komputer ini: http://localhost:${config.http.port}`);
    for (const ip of ips) log.info(`  dari PC lain / Khanza (RIS_URL) : http://${ip}:${config.http.port}   | alat DICOM: IP ${ip} port ${config.dicom.port} AE ${config.dicom.aeTitle}`);
  });

  hl7.injectReportService(reportService);
  await sync.cancelExcluded().catch((e) => log.error('Pembersihan order BHP gagal', e));
  sync.start();
  if (config.dicom.enabled) await scp.start();
  if (config.hl7.enabled) hl7.start({ reportService });
  if (config.orthanc.enabled) orthanc.start();
  if (config.satusehat.enabled) satusehat.start();
}

process.on('unhandledRejection', (e) => log.error('Unhandled rejection', e));
main();
