import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { Pool } from 'pg';
import { ScopedDb } from '../src/database/scoped-db';

const URL = process.env.TEST_DATABASE_URL;
const jalan = URL ? describe : describe.skip;

const ROLE = 'hris_app_uji';
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const TABEL = 'uji_scoped_db_sintetis';

jalan('ScopedDb memberlakukan scope perusahaan di database', () => {
  let admin: Pool; // koneksi pemilik (menyiapkan skema uji)
  let app: Pool; // koneksi sebagai role non-superuser tanpa BYPASSRLS, seperti produksi
  let sdb: ScopedDb;

  beforeAll(async () => {
    execFileSync('node', ['scripts/migrate.js', 'up'], { env: { ...process.env, DATABASE_URL: URL } });
    admin = new Pool({ connectionString: URL, max: 2 });
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN CREATE ROLE ${ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$`);
    await admin.query(`GRANT ${ROLE} TO CURRENT_USER`);
    await admin.query(`DROP TABLE IF EXISTS ${TABEL}`);
    await admin.query(`CREATE TABLE ${TABEL} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, label text NOT NULL)`);
    await admin.query(`SELECT enable_tenant_rls('${TABEL}')`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${TABEL} TO ${ROLE}`);
    // max:1 memaksa semua transaksi memakai KONEKSI YANG SAMA, sehingga kebocoran setelan antar-request akan terlihat.
    app = new Pool({ connectionString: URL, max: 1, options: `-c role=${ROLE}` });
    sdb = new ScopedDb(app);
    for (const [c, l] of [[A, 'SINTETIS A'], [B, 'SINTETIS B']]) {
      await sdb.tx({ companyIds: [c] }, (cl) => cl.query(`INSERT INTO ${TABEL} (company_id, label) VALUES ($1, $2)`, [c, l]));
    }
  });
  afterAll(async () => {
    await admin.query(`DROP TABLE IF EXISTS ${TABEL}`);
    await app.end();
    await admin.end();
  });

  const baca = (companyIds: string[], auditGlobal = false) =>
    sdb.tx({ companyIds, auditGlobal }, async (c) => (await c.query(`SELECT company_id FROM ${TABEL}`)).rows.map((r) => r.company_id));

  it('menjalankan sebagai role non-superuser tanpa BYPASSRLS', async () => {
    const r = await app.query(`SELECT current_user AS u, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS s`);
    expect(r.rows[0]).toEqual({ u: ROLE, s: false });
  });
  it('scope A hanya melihat baris A; scope B hanya B', async () => {
    expect(await baca([A])).toEqual([A]);
    expect(await baca([B])).toEqual([B]);
  });
  it('tanpa scope tidak melihat apa pun', async () => {
    expect(await baca([])).toEqual([]);
  });
  it('scope tidak bocor ke transaksi berikutnya pada koneksi yang sama', async () => {
    await baca([A]);
    expect(await baca([])).toEqual([]);
    const sisa = await app.query(`SELECT current_setting('app.company_ids', true) AS v`);
    expect([null, '']).toContain(sisa.rows[0].v);
  });
  it('INSERT untuk perusahaan di luar scope ditolak', async () => {
    await expect(sdb.tx({ companyIds: [A] }, (c) => c.query(`INSERT INTO ${TABEL} (company_id, label) VALUES ($1, 'SINTETIS')`, [B]))).rejects.toThrow(/row-level security/i);
  });
  it('scope tidak valid (bukan UUID) ditolak sebelum menyentuh database', async () => {
    await expect(baca(["x'); DROP TABLE users; --"])).rejects.toThrow(/Scope perusahaan tidak valid/);
  });
  it('error di dalam transaksi melakukan ROLLBACK dan koneksi tetap sehat', async () => {
    await expect(sdb.tx({ companyIds: [A] }, async (c) => {
      await c.query(`UPDATE ${TABEL} SET label = 'RUSAK' WHERE company_id = $1`, [A]);
      throw new Error('gagal sengaja');
    })).rejects.toThrow(/gagal sengaja/);
    const r = await sdb.tx({ companyIds: [A] }, async (c) => (await c.query(`SELECT label FROM ${TABEL}`)).rows[0].label);
    expect(r).toBe('SINTETIS A');
  });
  it('auditGlobal hanya berlaku bila diminta dan tidak bocor', async () => {
    const baca2 = (g: boolean) => sdb.tx({ companyIds: [], auditGlobal: g }, async (c) => (await c.query(`SELECT current_setting('app.audit_global', true) AS v`)).rows[0].v);
    expect(await baca2(true)).toBe('on');
    expect(await baca2(false)).toBe('off');
  });
});
