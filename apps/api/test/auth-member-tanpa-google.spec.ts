import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

const URL = process.env.TEST_DATABASE_URL;
const jalan = URL ? describe : describe.skip;

const ORIGIN = 'https://hris.contoh.invalid';
process.env.APP_BASE_URL = ORIGIN;
process.env.AUTH_HMAC_KEY = randomBytes(32).toString('base64');
process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString('base64');
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;

jalan('login member bila Google belum dikonfigurasi', () => {
  let app: INestApplication;
  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    execFileSync('node', ['scripts/migrate.js', 'up'], { env: { ...process.env, DATABASE_URL: URL } });
    const { AppModule } = await import('../src/app.module');
    const { konfigurasiApp } = await import('../src/app.factory');
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
    konfigurasiApp(app);
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
  });

  it('start mengembalikan 503 berbahasa Indonesia dengan kode stabil, tanpa cookie', async () => {
    const r = await request(app.getHttpServer()).get('/auth/member/google/start').expect(503);
    expect(r.body).toEqual({ statusCode: 503, kode: 'GOOGLE_BELUM_DIKONFIGURASI', pesan: 'Masuk dengan Google belum tersedia' });
    expect(r.headers['set-cookie']).toBeUndefined();
  });

  it('callback tanpa transaksi mengalihkan ke halaman masuk dengan galat, bukan membuat sesi', async () => {
    const r = await request(app.getHttpServer()).get('/auth/member/google/callback?code=x&state=y').expect(302);
    expect(r.headers.location).toBe(`${ORIGIN}/masuk?galat=sesi_kedaluwarsa`);
    expect((r.headers['set-cookie'] as unknown as string[] | undefined)?.some((c) => c.startsWith('__Host-sid='))).toBeFalsy();
  });
});
