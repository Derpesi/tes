import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Pool } from 'pg';

const URL = process.env.TEST_DATABASE_URL;
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

  it('menghasilkan dokumen OpenAPI yang memuat /health', async () => {
    const res = await request(app.getHttpServer()).get('/openapi.json').expect(200);
    expect(res.body.openapi).toMatch(/^3\./);
    expect(res.body.paths['/health']).toBeDefined();
  });

  it('error 404 berbahasa Indonesia dengan bentuk seragam', async () => {
    const res = await request(app.getHttpServer()).get('/tidak-ada').expect(404);
    expect(res.body).toMatchObject({ statusCode: 404, kode: 'HTTP_404' });
    expect(res.body.pesan).toBeTruthy();
  });

  it('audit_logs menerima INSERT tetapi menolak UPDATE, DELETE, dan TRUNCATE', async () => {
    const { rows } = await pool.query(
      `INSERT INTO audit_logs (action, detail) VALUES ('uji.sintetis', '{"label":"SINTETIS"}') RETURNING id`,
    );
    const id = rows[0].id;
    await expect(pool.query(`UPDATE audit_logs SET action='x' WHERE id=$1`, [id])).rejects.toThrow(/append-only/);
    await expect(pool.query(`DELETE FROM audit_logs WHERE id=$1`, [id])).rejects.toThrow(/append-only/);
    await expect(pool.query(`TRUNCATE audit_logs`)).rejects.toThrow(/append-only/);
  });

  it('migrasi dapat turun dan naik kembali', () => {
    const env = { ...process.env, DATABASE_URL: URL };
    execFileSync('node', ['scripts/migrate.js', 'down'], { env });
    execFileSync('node', ['scripts/migrate.js', 'up'], { env });
  });
});
