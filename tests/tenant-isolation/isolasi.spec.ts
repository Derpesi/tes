import { Pool } from 'pg';
import { COMPANY_SINTETIS } from '../helpers/data-sintetis';
import { ROLE_UJI, bukaPool, dalamScope, migrasiNaik, siapkanRoleUji } from '../helpers/db';
import { cekKebocoran, KonfigKebocoran } from '../helpers/kebocoran';
import { TABEL_UJI, buatTabelUji, hapusTabelUji } from '../helpers/tabel-uji';

const ada = process.env.TEST_DATABASE_URL ? describe : describe.skip;

ada('isolasi perusahaan di lapisan database (RLS)', () => {
  let pool: Pool;
  let k: KonfigKebocoran;

  beforeAll(async () => {
    migrasiNaik();
    pool = bukaPool();
    await siapkanRoleUji(pool);
    k = await buatTabelUji(pool, ROLE_UJI);
  });
  afterAll(async () => {
    await hapusTabelUji(pool);
    await pool.end();
  });

  it('role uji benar-benar non-superuser tanpa BYPASSRLS', async () => {
    const r = await pool.query(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1`, [ROLE_UJI]);
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('scope A hanya melihat baris A', async () => {
    const rows = await dalamScope(pool, [COMPANY_SINTETIS.A], async (c) => (await c.query(`SELECT company_id FROM ${TABEL_UJI}`)).rows);
    expect(rows).toHaveLength(1);
    expect(rows[0].company_id).toBe(COMPANY_SINTETIS.A);
  });

  it('akses langsung per ID baris perusahaan lain mengembalikan 0 baris', async () => {
    const n = await dalamScope(pool, [COMPANY_SINTETIS.A], async (c) => (await c.query(`SELECT 1 FROM ${TABEL_UJI} WHERE id = $1`, [k.idBarisB])).rowCount);
    expect(n).toBe(0);
  });

  it('UPDATE dan DELETE lintas perusahaan mengubah 0 baris', async () => {
    const [u, d] = await dalamScope(pool, [COMPANY_SINTETIS.A], async (c) => [
      (await c.query(`UPDATE ${TABEL_UJI} SET label = 'x' WHERE id = $1`, [k.idBarisB])).rowCount,
      (await c.query(`DELETE FROM ${TABEL_UJI} WHERE id = $1`, [k.idBarisB])).rowCount,
    ]);
    expect(u).toBe(0);
    expect(d).toBe(0);
  });

  it('INSERT dengan company_id perusahaan lain ditolak (WITH CHECK)', async () => {
    await expect(
      dalamScope(pool, [COMPANY_SINTETIS.A], (c) => c.query(`INSERT INTO ${TABEL_UJI} (company_id, label) VALUES ($1, 'SINTETIS')`, [COMPANY_SINTETIS.B])),
    ).rejects.toThrow(/row-level security/i);
  });

  it('tanpa scope tidak melihat apa pun (deny-by-default)', async () => {
    const n = await dalamScope(pool, [], async (c) => (await c.query(`SELECT 1 FROM ${TABEL_UJI}`)).rowCount);
    expect(n).toBe(0);
  });

  it('scope multi-perusahaan melihat gabungan yang tepat dan tidak melihat C', async () => {
    const rows = await dalamScope(pool, [COMPANY_SINTETIS.A, COMPANY_SINTETIS.B], async (c) => (await c.query(`SELECT company_id FROM ${TABEL_UJI}`)).rows);
    expect(rows.map((r) => r.company_id).sort()).toEqual([COMPANY_SINTETIS.A, COMPANY_SINTETIS.B].sort());
  });

  it('scope tidak dapat bocor antar transaksi (set_config hanya berlaku lokal)', async () => {
    await dalamScope(pool, [COMPANY_SINTETIS.A], async () => undefined);
    const n = await dalamScope(pool, [], async (c) => (await c.query(`SELECT 1 FROM ${TABEL_UJI}`)).rowCount);
    expect(n).toBe(0);
  });

  it('cekKebocoran melaporkan terisolasi (daftar kosong)', async () => {
    expect(await cekKebocoran(pool, k)).toEqual([]);
  });
});
