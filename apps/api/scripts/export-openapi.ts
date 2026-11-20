// Menulis dokumen OpenAPI ke docs/openapi/openapi.json (dipakai CI untuk mendeteksi perubahan kontrak).
// Tidak memerlukan database: koneksi pool dibuat lazy dan tidak dipakai.
import 'reflect-metadata';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { buatDokumenOpenApi } from '../src/app.factory';

async function utama() {
  process.env.DATABASE_URL ??= 'postgres://placeholder:placeholder@127.0.0.1:1/placeholder';
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
