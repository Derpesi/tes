import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Pool } from 'pg';

const URL = process.env.TEST_DATABASE_URL;
// Konfigurasi sintetis acak per proses tes; tidak ada rahasia nyata.
process.env.APP_BASE_URL ??= 'http://localhost:3000';
process.env.AUTH_HMAC_KEY ??= randomBytes(32).toString('base64');
process.env.APP_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
const jalan = URL ? describe : describe.skip;

jalan('integrasi (PostgreSQL asli)', () => {
  let app: INestApplication;
  let pool: Pool;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    const migrasi = (arah: string) =>
      execFileSync('node', ['scripts/migrate.js', arah], { env: { ...process.env, DATABASE_URL: URL } });
    migrasi('up');
    const { AppModule } = await import('../src/app.module');
    const { konfigurasiApp } = await import('../src/app.factory');
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    konfigurasiApp(app);
    await app.init();
    pool = new Pool({ connectionString: URL });
  });

  afterAll(async () => {
    await pool?.end();
    await app?.close();
  });

  it('GET /health mengembalikan 200 dan memeriksa database', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body).toEqual({ status: 'ok', database: 'ok' });
  });

  it('GET /ready: siap bila database dan migrasi tersedia; 503 setelah proses ditandai berhenti', async () => {
    const res = await request(app.getHttpServer()).get('/ready').expect(200);
    expect(res.body).toEqual({ status: 'siap' });
    const { StatusProses } = await import('../src/health/health.controller');
    const status = app.get(StatusProses);
    status.berhenti = true;
    try {
      const r = await request(app.getHttpServer()).get('/ready').expect(503);
      expect(r.body.pesan).toMatch(/berhenti/);
      await request(app.getHttpServer()).get('/health').expect(200); // liveness tidak terpengaruh
    } finally {
      status.berhenti = false;
    }
  });

  it('menghasilkan dokumen OpenAPI yang memuat /health', async () => {
    const res = await request(app.getHttpServer()).get('/openapi.json').expect(200);
    expect(res.body.openapi).toMatch(/^3\./);
    expect(res.body.paths['/health']).toBeDefined();
  });

  it('error 404 berbahasa Indonesia dengan bentuk seragam', async () => {
    const res = await request(app.getHttpServer()).get('/tidak-ada').expect(404);
    expect(res.body).toMatchObject({ statusCode: 404, kode: 'HTTP_404' });
    expect(res.body.pesan).toBe('Data tidak ditemukan');
  });

  it('audit_logs: INSERT boleh; UPDATE/DELETE tidak mengubah apa pun; TRUNCATE ditolak; trigger menolak bila kebijakan dilonggarkan', async () => {
    const c = await pool.connect();
    const tidakBerubah = async (sql: string, params: unknown[]) => {
      await c.query('SAVEPOINT s');
      try {
        const r = await c.query(sql, params);
        expect(r.rowCount).toBe(0); // RLS menolak diam-diam (0 baris)
      } catch (e) {
        expect((e as Error).message).toMatch(/append-only/); // atau trigger menolak (mis. koneksi superuser)
        await c.query('ROLLBACK TO SAVEPOINT s');
      }
    };
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.audit_global', 'on', true)`);
      const { rows } = await c.query(`INSERT INTO audit_logs (action, detail) VALUES ('uji.sintetis', '{"label":"SINTETIS"}') RETURNING id`);
      const id = rows[0].id;
      await tidakBerubah(`UPDATE audit_logs SET action='x' WHERE id=$1`, [id]);
      await tidakBerubah(`DELETE FROM audit_logs WHERE id=$1`, [id]);
      const masih = await c.query(`SELECT action FROM audit_logs WHERE id=$1`, [id]);
      expect(masih.rows[0].action).toBe('uji.sintetis');
      await c.query('SAVEPOINT t');
      await expect(c.query(`TRUNCATE audit_logs`)).rejects.toThrow(/append-only/);
      await c.query('ROLLBACK TO SAVEPOINT t');
      // Bila kebijakan dilonggarkan, trigger append-only tetap menolak.
      await c.query(`CREATE POLICY uji_longgar_u ON audit_logs FOR UPDATE USING (true)`);
      await c.query(`CREATE POLICY uji_longgar_d ON audit_logs FOR DELETE USING (true)`);
      await c.query('SAVEPOINT u');
      await expect(c.query(`UPDATE audit_logs SET action='x' WHERE id=$1`, [id])).rejects.toThrow(/append-only/);
      await c.query('ROLLBACK TO SAVEPOINT u');
      await expect(c.query(`DELETE FROM audit_logs WHERE id=$1`, [id])).rejects.toThrow(/append-only/);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  });

  it('migrasi dapat turun dan naik kembali', () => {
    const env = { ...process.env, DATABASE_URL: URL };
    execFileSync('node', ['scripts/migrate.js', 'down'], { env });
    execFileSync('node', ['scripts/migrate.js', 'up'], { env });
  });
});
