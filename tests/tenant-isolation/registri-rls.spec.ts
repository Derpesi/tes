import { Pool } from 'pg';
import { bukaPool, migrasiNaik } from '../helpers/db';

const ada = process.env.TEST_DATABASE_URL ? describe : describe.skip;

/** Tabel ber-company_id yang BOLEH tanpa RLS. Setiap entri wajib beralasan dan berstatus. */
export const PENGECUALIAN: { tabel: string; alasan: string; status: string }[] = [
  // Kosong: pengecualian audit_logs (A-13) ditutup di Fase 3A dengan kebijakan RLS khusus.
];

export async function cariTabelTanpaRls(pool: Pool, pengecualian: string[]): Promise<string[]> {
  const r = await pool.query(
    `SELECT c.relname FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'company_id' AND NOT a.attisdropped
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
        AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
      ORDER BY c.relname`,
  );
  return r.rows.map((x) => x.relname as string).filter((t) => !pengecualian.includes(t));
}

ada('registri RLS: setiap tabel ber-company_id wajib RLS terpaksa', () => {
  let pool: Pool;
  beforeAll(() => {
    migrasiNaik();
    pool = bukaPool();
  });
  afterAll(async () => {
    await pool.end();
  });

  it('semua pengecualian beralasan dan berstatus tertulis', () => {
    for (const p of PENGECUALIAN) {
      expect(p.alasan.trim().length).toBeGreaterThan(10);
      expect(p.status.trim().length).toBeGreaterThan(3);
    }
  });

  it('tidak ada tabel tenant tanpa RLS di luar daftar pengecualian', async () => {
    expect(await cariTabelTanpaRls(pool, PENGECUALIAN.map((p) => p.tabel))).toEqual([]);
  });

  it('pengecualian tidak usang: setiap tabel pengecualian masih ada', async () => {
    const r = await pool.query(`SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r','p')`);
    const ada = r.rows.map((x) => x.relname);
    for (const p of PENGECUALIAN) expect(ada).toContain(p.tabel);
  });

  it('meta: tabel baru ber-company_id tanpa RLS terdeteksi', async () => {
    await pool.query(`CREATE TABLE uji_registri_tanpa_rls (id int, company_id uuid)`);
    try {
      const temuan = await cariTabelTanpaRls(pool, PENGECUALIAN.map((p) => p.tabel));
      expect(temuan).toContain('uji_registri_tanpa_rls');
    } finally {
      await pool.query(`DROP TABLE uji_registri_tanpa_rls`);
    }
  });
});
