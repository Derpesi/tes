import { Pool } from 'pg';
import { ROLE_UJI, bukaPool, migrasiNaik, siapkanRoleUji } from '../helpers/db';
import { cekKebocoran, KonfigKebocoran } from '../helpers/kebocoran';
import { TABEL_UJI, buatTabelUji, hapusTabelUji } from '../helpers/tabel-uji';

const ada = process.env.TEST_DATABASE_URL ? describe : describe.skip;

// Bukti bahwa tes isolasi EFEKTIF: bila RLS dimatikan, kebocoran harus terdeteksi.
ada('meta-tes: tes isolasi harus gagal bila RLS dimatikan', () => {
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

  it('RLS aktif: tidak ada kebocoran', async () => {
    expect(await cekKebocoran(pool, k)).toEqual([]);
  });

  it('RLS dimatikan: kebocoran terdeteksi di semua jalur', async () => {
    await pool.query(`ALTER TABLE ${TABEL_UJI} DISABLE ROW LEVEL SECURITY`);
    const bocor = await cekKebocoran(pool, k);
    expect(bocor).toEqual(
      expect.arrayContaining([
        'SELECT massal melihat baris perusahaan lain',
        'SELECT per ID melihat baris perusahaan lain',
        'UPDATE mengubah baris perusahaan lain',
        'DELETE menghapus baris perusahaan lain',
        'INSERT menulis baris untuk perusahaan lain',
        'Tanpa scope tetap melihat baris',
      ]),
    );
  });

  it('kebijakan dihapus tetapi RLS aktif: menolak semua (fail closed), tanpa kebocoran', async () => {
    await pool.query(`ALTER TABLE ${TABEL_UJI} ENABLE ROW LEVEL SECURITY`);
    await pool.query(`DROP POLICY tenant_isolation ON ${TABEL_UJI}`);
    expect(await cekKebocoran(pool, k)).toEqual([]);
  });
});
