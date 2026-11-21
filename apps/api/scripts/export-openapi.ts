// Menulis dokumen OpenAPI ke docs/openapi/openapi.json (dipakai CI untuk mendeteksi perubahan kontrak).
// Tidak memerlukan database: koneksi pool dibuat lazy dan tidak dipakai.
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { buatDokumenOpenApi } from '../src/app.factory';

async function utama() {
  // Nilai sementara acak hanya agar konfigurasi lolos validasi; tidak ada yang disimpan atau dipakai.
  process.env.DATABASE_URL ??= 'postgres://placeholder:placeholder@127.0.0.1:1/placeholder';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.AUTH_HMAC_KEY ??= randomBytes(32).toString('base64');
  process.env.APP_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
  const app = await NestFactory.create(AppModule, { logger: false });
  const dokumen = buatDokumenOpenApi(app);
  const tujuan = join(__dirname, '..', '..', '..', 'docs', 'openapi', 'openapi.json');
  mkdirSync(dirname(tujuan), { recursive: true });
  writeFileSync(tujuan, JSON.stringify(dokumen, null, 2) + '\n');
  await app.close();
}
utama().catch((e) => {
  console.error(e);
  process.exit(1);
});
