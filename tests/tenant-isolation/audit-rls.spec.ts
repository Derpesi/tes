import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { COMPANY_SINTETIS } from '../helpers/data-sintetis';
import { ROLE_UJI, bukaPool, dalamScope, migrasiNaik, siapkanRoleUji } from '../helpers/db';

const ada = process.env.TEST_DATABASE_URL ? describe : describe.skip;

// audit_logs bersifat hanya-tambah, jadi baris uji tidak dapat dihapus; tiap proses memakai action unik.
ada('audit_logs: RLS khusus (A-13 ditutup)', () => {
  let pool: Pool;
  const aksi = `uji.rls.${randomBytes(6).toString('hex')}`;
  const A = COMPANY_SINTETIS.A;
  const B = COMPANY_SINTETIS.B;

  const tulis = (scope: string[], companyId: string | null) =>
    dalamScope(pool, scope, (c) => c.query(`INSERT INTO audit_logs (action, company_id, detail) VALUES ($1, $2, '{"label":"SINTETIS"}')`, [aksi, companyId]), { commit: true });
  const baca = (scope: string[], auditGlobal = false) =>
    dalamScope(pool, scope, async (c) => (await c.query(`SELECT company_id FROM audit_logs WHERE action = $1`, [aksi])).rows.map((r) => r.company_id as string | null), { auditGlobal });

  beforeAll(async () => {
    migrasiNaik();
    pool = bukaPool();
    await siapkanRoleUji(pool);
    await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON audit_logs TO ${ROLE_UJI}`);
    // Penulisan boleh dari scope mana pun (pencatatan audit tidak boleh gagal karena scope).
    await tulis([A], A);
    await tulis([B], B);
    await tulis([], null);
  });
  afterAll(async () => {
    await pool.end();
  });

  it('penulisan diizinkan tanpa scope', async () => {
    await expect(tulis([], null)).resolves.toBeDefined();
  });
  it('scope A hanya membaca baris A (bukan B, bukan global)', async () => {
    expect(await baca([A])).toEqual([A]);
  });
  it('scope A + izin audit global membaca baris A dan global, tidak B', async () => {
    const r = await baca([A], true);
    expect(r.filter((x) => x === A)).toHaveLength(1);
    expect(r.filter((x) => x === null).length).toBeGreaterThan(0);
    expect(r).not.toContain(B);
  });
  it('tanpa scope dan tanpa izin global tidak membaca apa pun', async () => {
    expect(await baca([])).toEqual([]);
  });
  it('izin audit global saja hanya membaca baris global', async () => {
    const r = await baca([], true);
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((x) => x === null)).toBe(true);
  });
  it('UPDATE dan DELETE oleh role aplikasi tidak mengubah baris apa pun', async () => {
    const [u, d] = await dalamScope(pool, [A], async (c) => [
      (await c.query(`UPDATE audit_logs SET action = 'x' WHERE action = $1`, [aksi])).rowCount,
      (await c.query(`DELETE FROM audit_logs WHERE action = $1`, [aksi])).rowCount,
    ]);
    expect(u).toBe(0);
    expect(d).toBe(0);
  });
});
