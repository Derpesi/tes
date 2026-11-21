// Seed perusahaan awal grup (idempoten). Dijalankan operator: pnpm seed:perusahaan
// Hanya nama dan kode singkat; data hukum (NPWP, alamat, dokumen) diisi lewat aplikasi. Tidak memuat rahasia.
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { PERUSAHAAN_AWAL, SeedPerusahaanService } from '../src/master/seed-perusahaan.service';

async function utama(): Promise<number> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  try {
    const h = await app.get(SeedPerusahaanService).jalankan();
    console.log(`Seed perusahaan awal: ${h.dibuat} dibuat, ${h.sudahAda} sudah ada (dari ${PERUSAHAAN_AWAL.length}).`);
    return 0;
  } catch (e) {
    console.error(`Gagal: ${(e as Error).message}`);
    return 1;
  } finally {
    await app.close();
  }
}
utama().then((k) => process.exit(k));
