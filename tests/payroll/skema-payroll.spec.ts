import { randomBytes } from 'node:crypto';
import { Pool, PoolClient } from 'pg';
import { COMPANY_SINTETIS } from '../helpers/data-sintetis';
import { ROLE_UJI, bukaPool, dalamScope, migrasiNaik, siapkanRoleUji } from '../helpers/db';
import { cekKebocoran, KonfigKebocoran } from '../helpers/kebocoran';

const ada = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const A = COMPANY_SINTETIS.A;
const B = COMPANY_SINTETIS.B;
const hash = () => randomBytes(32).toString('hex');

async function harusGagal(c: PoolClient, sql: string, params: unknown[], pola: RegExp) {
  await c.query('SAVEPOINT uji');
  try {
    await c.query(sql, params);
  } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT uji');
    expect((e as Error).message).toMatch(pola);
    return;
  }
  throw new Error(`Seharusnya gagal tetapi berhasil: ${sql}`);
}

ada('Payroll rekap: invarian skema, pelindung database, dan isolasi RLS', () => {
  let pool: Pool;
  let u: string[];
  let nomor = 0;
  const tx = (fn: (c: PoolClient) => Promise<void>) => dalamScope(pool, [A, B], async (c) => fn(c));
  const person = async () => (await pool.query(`INSERT INTO persons (display_name) VALUES ('SINTETIS Pekerja') RETURNING id`)).rows[0].id as string;

  /** Periode baru (jangkauan unik per pemanggilan agar tak tumpang tindih lintas uji/run). */
  const periode = async (c: PoolClient, company: string, kind = 'PARTNER') => {
    const hariKe = 20000 + ((Date.now() / 1000) | 0) % 100000 * 4 + nomor++ * 0; // basis acak besar
    const mulai = new Date(Date.UTC(2100, 0, 1) + (Math.floor(Math.random() * 1e6) % 60000) * 86400000 * 1 + nomor * 3 * 86400000);
    const s = mulai.toISOString().slice(0, 10);
    const e = new Date(mulai.getTime() + 2 * 86400000).toISOString().slice(0, 10);
    void hariKe;
    return (await c.query(`INSERT INTO payroll_periods (company_id, kind, label, start_date, end_date, created_by) VALUES ($1, $2, 'Periode uji', $3, $4, $5) RETURNING id`, [company, kind, s, e, u[0]])).rows[0].id as string;
  };
  const rekap = async (c: PoolClient, company: string, periodId: string, versi = 1) =>
    (await c.query(
      versi === 1
        ? `INSERT INTO payroll_recaps (company_id, period_id, version_no, created_by) VALUES ($1, $2, 1, $3) RETURNING id`
        : `INSERT INTO payroll_recaps (company_id, period_id, version_no, recap_number, correction_reason, created_by) VALUES ($1, $2, $4, $5, 'koreksi uji', $3) RETURNING id`,
      versi === 1 ? [company, periodId, u[0]] : [company, periodId, u[0], versi, `KRP/2100/${randomBytes(4).toString('hex')}`],
    )).rows[0].id as string;
  const baris = async (c: PoolClient, company: string, recapId: string) =>
    (await c.query(`INSERT INTO payroll_recap_lines (company_id, recap_id, person_id, worker_name, source) VALUES ($1, $2, $3, 'SINTETIS Pekerja', 'ATTENDANCE') RETURNING id`, [company, recapId, await person()])).rows[0].id as string;
  const komponen = async (c: PoolClient, company: string, lineId: string) =>
    (await c.query(`INSERT INTO payroll_components (company_id, line_id, kind, name, amount) VALUES ($1, $2, 'TUNJANGAN', 'Makan', 100.50) RETURNING id`, [company, lineId])).rows[0].id as string;
  const verifikasi = (c: PoolClient, id: string, oleh = u[1]) => c.query(`UPDATE payroll_recaps SET status = 'DIVERIFIKASI', reviewed_by = $2, reviewed_at = now() WHERE id = $1`, [id, oleh]);
  const setujui = (c: PoolClient, id: string, oleh = u[2]) => c.query(`UPDATE payroll_recaps SET status = 'DISETUJUI', approved_by = $2, approved_at = now(), snapshot_hash = $3 WHERE id = $1`, [id, oleh, hash()]);

  beforeAll(async () => {
    migrasiNaik();
    pool = bukaPool();
    await siapkanRoleUji(pool);
    await pool.query(`GRANT ALL ON ALL TABLES IN SCHEMA public TO ${ROLE_UJI}`);
    for (const [id, nama] of [[A, 'PT SINTETIS A'], [B, 'PT SINTETIS B']]) await pool.query(`INSERT INTO companies (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [id, nama]);
    u = [];
    for (let i = 0; i < 5; i++) {
      const p = await person();
      u.push((await pool.query(`INSERT INTO users (person_id, realm, email, status) VALUES ($1, 'staff', $2, 'AKTIF') RETURNING id`, [p, `pay-${randomBytes(4).toString('hex')}@contoh.invalid`])).rows[0].id);
    }
  });
  afterAll(async () => {
    await pool.end();
  });

  describe('periode', () => {
    it('rentang sah (maks 93 hari), tidak tumpang tindih per perusahaan+jenis; jenis/perusahaan lain boleh', () =>
      tx(async (c) => {
        const sisip = `INSERT INTO payroll_periods (company_id, kind, label, start_date, end_date, created_by) VALUES ($1, $2, 'P', $3, $4, $5)`;
        await c.query(sisip, [A, 'PARTNER', '2150-01-01', '2150-03-31', u[0]]); // 90 hari
        await harusGagal(c, sisip, [A, 'PARTNER', '2150-03-31', '2150-04-05', u[0]], /tanpa_tumpang_tindih/);
        await c.query(sisip, [A, 'INTERNAL', '2150-01-01', '2150-01-31', u[0]]);
        await c.query(sisip, [B, 'PARTNER', '2150-01-01', '2150-01-31', u[0]]);
        await harusGagal(c, sisip, [A, 'PARTNER', '2151-01-01', '2151-12-31', u[0]], /rentang/);
        await harusGagal(c, sisip, [A, 'PARTNER', '2152-02-01', '2152-01-01', u[0]], /rentang/);
        await harusGagal(c, sisip, [A, 'LAIN', '2153-01-01', '2153-01-02', u[0]], /kind/);
        await c.query(sisip, [A, 'PARTNER', '2154-01-01', '2154-04-02', u[0]]); // 92 hari selisih = batas
        await harusGagal(c, sisip, [A, 'PARTNER', '2155-01-01', '2155-04-04', u[0]], /rentang/); // 93 hari selisih
      }));
  });

  describe('rekap: versi, pemisahan tugas, status, dan kekekalan', () => {
    it('versi 1 tanpa nomor/alasan; versi koreksi wajib bernomor dan beralasan; satu versi terbuka per periode; nomor unik', () =>
      tx(async (c) => {
        const p = await periode(c, A);
        await harusGagal(c, `INSERT INTO payroll_recaps (company_id, period_id, version_no, recap_number, created_by) VALUES ($1, $2, 1, 'X/1', $3)`, [A, p, u[0]], /koreksi_lengkap/);
        await harusGagal(c, `INSERT INTO payroll_recaps (company_id, period_id, version_no, created_by) VALUES ($1, $2, 2, $3)`, [A, p, u[0]], /koreksi_lengkap/);
        const r1 = await rekap(c, A, p);
        await harusGagal(c, `INSERT INTO payroll_recaps (company_id, period_id, version_no, recap_number, correction_reason, created_by) VALUES ($1, $2, 2, 'KRP/1', 'alasan', $3)`, [A, p, u[0]], /satu_terbuka/);
        await verifikasi(c, r1);
        await harusGagal(c, `INSERT INTO payroll_recaps (company_id, period_id, version_no, recap_number, correction_reason, created_by) VALUES ($1, $2, 1, NULL, NULL, $3)`, [A, p, u[0]], /versi_unik/);
        await setujui(c, r1);
        const nomorKrp = `KRP/2100/${randomBytes(3).toString('hex')}`;
        await c.query(`INSERT INTO payroll_recaps (company_id, period_id, version_no, recap_number, correction_reason, created_by) VALUES ($1, $2, 2, $3, 'alasan', $4)`, [A, p, nomorKrp, u[0]]);
        const p2 = await periode(c, A);
        await harusGagal(c, `INSERT INTO payroll_recaps (company_id, period_id, version_no, recap_number, correction_reason, created_by) VALUES ($1, $2, 2, $3, 'alasan', $4)`, [A, p2, nomorKrp, u[0]], /nomor_unik/);
      }));

    it('pembuat, pemeriksa, penyetuju, finalisator berbeda (CHECK database); penyunting terakhir bukan pemeriksa', () =>
      tx(async (c) => {
        const r = await rekap(c, A, await periode(c, A));
        await harusGagal(c, `UPDATE payroll_recaps SET status = 'DIVERIFIKASI', reviewed_by = $2, reviewed_at = now() WHERE id = $1`, [r, u[0]], /payroll_recaps_sod/);
        await c.query(`UPDATE payroll_recaps SET last_edited_by = $2 WHERE id = $1`, [r, u[3]]);
        await harusGagal(c, `UPDATE payroll_recaps SET status = 'DIVERIFIKASI', reviewed_by = $2, reviewed_at = now() WHERE id = $1`, [r, u[3]], /payroll_recaps_sod/);
        await verifikasi(c, r, u[1]);
        await harusGagal(c, `UPDATE payroll_recaps SET status = 'DISETUJUI', approved_by = $2, approved_at = now(), snapshot_hash = $3 WHERE id = $1`, [r, u[0], hash()], /payroll_recaps_sod/);
        await harusGagal(c, `UPDATE payroll_recaps SET status = 'DISETUJUI', approved_by = $2, approved_at = now(), snapshot_hash = $3 WHERE id = $1`, [r, u[1], hash()], /payroll_recaps_sod/);
        await setujui(c, r, u[2]);
        for (const orang of [u[0], u[1], u[2]]) await harusGagal(c, `UPDATE payroll_recaps SET status = 'DIFINALISASI', finalized_by = $2, finalized_at = now() WHERE id = $1`, [r, orang], /payroll_recaps_sod/);
        await c.query(`UPDATE payroll_recaps SET status = 'DIFINALISASI', finalized_by = $2, finalized_at = now() WHERE id = $1`, [r, u[4]]);
      }));

    it('kelengkapan status: pemeriksa, penyetuju+hash, finalisator wajib sesuai status', () =>
      tx(async (c) => {
        const r = await rekap(c, A, await periode(c, A));
        await harusGagal(c, `UPDATE payroll_recaps SET status = 'DIVERIFIKASI' WHERE id = $1`, [r], /pemeriksa_wajib/);
        await verifikasi(c, r);
        await harusGagal(c, `UPDATE payroll_recaps SET status = 'DISETUJUI', approved_by = $2, approved_at = now() WHERE id = $1`, [r, u[2]], /penyetuju_wajib/);
        await harusGagal(c, `UPDATE payroll_recaps SET snapshot_hash = 'bukan-hash' WHERE id = $1`, [r], /snapshot_hash/);
        await setujui(c, r);
        await harusGagal(c, `UPDATE payroll_recaps SET status = 'DIFINALISASI' WHERE id = $1`, [r], /finalisator_wajib/);
      }));

    it('transisi sah saja; setelah disetujui identitas/pelaku/hash tidak berubah; rekap tidak pernah dihapus', () =>
      tx(async (c) => {
        const r = await rekap(c, A, await periode(c, A));
        await harusGagal(c, `UPDATE payroll_recaps SET status = 'DISETUJUI', reviewed_by = $2, reviewed_at = now(), approved_by = $3, approved_at = now(), snapshot_hash = $4 WHERE id = $1`, [r, u[1], u[2], hash()], /Transisi status/); // lompat tahap
        await verifikasi(c, r);
        await c.query(`UPDATE payroll_recaps SET status = 'DRAFT', reviewed_by = NULL, reviewed_at = NULL WHERE id = $1`, [r]); // dikembalikan
        await verifikasi(c, r);
        await setujui(c, r);
        await harusGagal(c, `UPDATE payroll_recaps SET status = 'DRAFT' WHERE id = $1`, [r], /Transisi status|pemeriksa_wajib/);
        await harusGagal(c, `UPDATE payroll_recaps SET snapshot_hash = $2 WHERE id = $1`, [r, hash()], /diubah diam-diam/);
        await harusGagal(c, `UPDATE payroll_recaps SET approved_by = $2 WHERE id = $1`, [r, u[3]], /diubah diam-diam/);
        await harusGagal(c, `UPDATE payroll_recaps SET created_by = $2 WHERE id = $1`, [r, u[3]], /diubah diam-diam/);
        await harusGagal(c, `DELETE FROM payroll_recaps WHERE id = $1`, [r], /tidak boleh dihapus/);
        await c.query(`UPDATE payroll_recaps SET status = 'DIGANTIKAN' WHERE id = $1`, [r]);
        await harusGagal(c, `UPDATE payroll_recaps SET status = 'DISETUJUI' WHERE id = $1`, [r], /Transisi status/);
      }));

    it('baris dan komponen hanya berubah saat DRAFT; setelah diverifikasi/disetujui semua INSERT/UPDATE/DELETE ditolak', () =>
      tx(async (c) => {
        const r = await rekap(c, A, await periode(c, A));
        const l = await baris(c, A, r);
        const k = await komponen(c, A, l);
        await c.query(`UPDATE payroll_components SET amount = 5 WHERE id = $1`, [k]);
        await c.query(`UPDATE payroll_recap_lines SET days_present = 20 WHERE id = $1`, [l]);
        await verifikasi(c, r);
        const tolak = /tidak boleh diubah; gunakan koreksi/;
        await harusGagal(c, `UPDATE payroll_components SET amount = 1 WHERE id = $1`, [k], tolak);
        await harusGagal(c, `DELETE FROM payroll_components WHERE id = $1`, [k], tolak);
        await harusGagal(c, `INSERT INTO payroll_components (company_id, line_id, kind, name, amount) VALUES ($1, $2, 'POTONGAN', 'X', 1)`, [A, l], tolak);
        await harusGagal(c, `UPDATE payroll_recap_lines SET days_present = 1 WHERE id = $1`, [l], tolak);
        await harusGagal(c, `DELETE FROM payroll_recap_lines WHERE id = $1`, [l], tolak);
        await harusGagal(c, `INSERT INTO payroll_recap_lines (company_id, recap_id, person_id, worker_name, source) VALUES ($1, $2, $3, 'X', 'MANUAL')`, [A, r, await person()], tolak);
        await setujui(c, r);
        await harusGagal(c, `UPDATE payroll_components SET amount = 1 WHERE id = $1`, [k], tolak); // tetap terkunci setelah disetujui
      }));

    it('nominal: NUMERIC eksak, tidak negatif, batas; baris: hari/jam dalam batas; orang unik per rekap; antar-perusahaan ditolak', () =>
      tx(async (c) => {
        const r = await rekap(c, A, await periode(c, A));
        const l = await baris(c, A, r);
        const sisip = `INSERT INTO payroll_components (company_id, line_id, kind, name, amount) VALUES ($1, $2, $3, 'N', $4)`;
        await c.query(sisip, [A, l, 'INSENTIF', '999999999999.99']);
        await harusGagal(c, sisip, [A, l, 'INSENTIF', '-0.01'], /amount/);
        await harusGagal(c, sisip, [A, l, 'INSENTIF', '1000000000000'], /amount|overflow/);
        await harusGagal(c, sisip, [A, l, 'GAJI_POKOK', '1'], /kind/);
        await harusGagal(c, sisip, [B, l, 'INSENTIF', '1'], /foreign key/);
        const hasil = (await c.query(`SELECT 0.10::numeric(14,2) + 0.20::numeric(14,2) = 0.30::numeric(14,2) AS eksak`)).rows[0];
        expect(hasil.eksak).toBe(true);
        await harusGagal(c, `UPDATE payroll_recap_lines SET days_present = 94 WHERE id = $1`, [l], /days_present/);
        await harusGagal(c, `UPDATE payroll_recap_lines SET overtime_hours = -1 WHERE id = $1`, [l], /overtime_hours/);
        const orang = (await c.query(`SELECT person_id FROM payroll_recap_lines WHERE id = $1`, [l])).rows[0].person_id;
        await harusGagal(c, `INSERT INTO payroll_recap_lines (company_id, recap_id, person_id, worker_name, source) VALUES ($1, $2, $3, 'X', 'MANUAL')`, [A, r, orang], /orang_unik/);
      }));

    it('riwayat status dan ekspor hanya-tambah', () =>
      tx(async (c) => {
        const r = await rekap(c, A, await periode(c, A));
        const h = (await c.query(`INSERT INTO payroll_recap_status_histories (company_id, recap_id, from_status, to_status, actor_user_id) VALUES ($1, $2, NULL, 'DRAFT', $3) RETURNING id`, [A, r, u[0]])).rows[0].id;
        const e = (await c.query(`INSERT INTO payroll_exports (company_id, recap_id, format, row_count, sha256, exported_by) VALUES ($1, $2, 'CSV', 3, $3, $4) RETURNING id`, [A, r, hash(), u[0]])).rows[0].id;
        await harusGagal(c, `UPDATE payroll_recap_status_histories SET to_status = 'X' WHERE id = $1`, [h], /tidak boleh/i);
        await harusGagal(c, `DELETE FROM payroll_recap_status_histories WHERE id = $1`, [h], /tidak boleh/i);
        await harusGagal(c, `UPDATE payroll_exports SET row_count = 9 WHERE id = $1`, [e], /tidak boleh/i);
        await harusGagal(c, `DELETE FROM payroll_exports WHERE id = $1`, [e], /tidak boleh/i);
        await harusGagal(c, `INSERT INTO payroll_exports (company_id, recap_id, format, row_count, sha256, exported_by) VALUES ($1, $2, 'DOCX', 1, $3, $4)`, [A, r, hash(), u[0]], /format/);
      }));
  });

  describe('isolasi RLS (dan bukti tes efektif bila RLS dimatikan)', () => {
    /** Cadangan per perusahaan: rekap DRAFT dengan baris, agar sisipan anak tidak bergantung pada induk ber-RLS yang sama. */
    const cad: Record<string, { rekap: string[]; baris: string[]; periode: string[] }> = { [A]: { rekap: [], baris: [], periode: [] }, [B]: { rekap: [], baris: [], periode: [] } };
    const ambil = (c: string, k: 'rekap' | 'baris' | 'periode') => cad[c][k].shift()!;
    const TABEL: [string, (c: string) => { text: string; values: unknown[] }, boolean][] = [
      ['payroll_periods', (c) => ({ text: `INSERT INTO payroll_periods (company_id, kind, label, start_date, end_date, created_by) VALUES ($1, 'INTERNAL', 'Iso', $2::date, $2::date + 1, $3)`, values: [c, new Date(Date.UTC(2200, 0, 1) + Math.floor(Math.random() * 1e6) * 86400000 * 3 % (86400000 * 900000)).toISOString().slice(0, 10), u[0]] }), false],
      ['payroll_recaps', (c) => ({ text: `INSERT INTO payroll_recaps (company_id, period_id, version_no, created_by) VALUES ($1, $2, 1, $3)`, values: [c, ambil(c, 'periode'), u[0]] }), false],
      ['payroll_recap_lines', (c) => ({ text: `INSERT INTO payroll_recap_lines (company_id, recap_id, person_id, worker_name, source) VALUES ($1, $2, $3, 'Iso', 'MANUAL')`, values: [c, cad[c].rekap[0], ''] }), false], // person disisipkan asinkron pada sisipan()
      ['payroll_components', (c) => ({ text: `INSERT INTO payroll_components (company_id, line_id, kind, name, amount) VALUES ($1, $2, 'POTONGAN', 'Iso', 1)`, values: [c, cad[c].baris[0]] }), false],
      ['payroll_recap_status_histories', (c) => ({ text: `INSERT INTO payroll_recap_status_histories (company_id, recap_id, from_status, to_status, actor_user_id) VALUES ($1, $2, NULL, 'DRAFT', $3)`, values: [c, cad[c].rekap[0], u[0]] }), true],
      ['payroll_exports', (c) => ({ text: `INSERT INTO payroll_exports (company_id, recap_id, format, row_count, sha256, exported_by) VALUES ($1, $2, 'CSV', 1, $3, $4)`, values: [c, cad[c].rekap[0], hash(), u[0]] }), true],
    ];
    beforeAll(async () => {
      for (const id of [A, B]) {
        for (let i = 0; i < 12; i++) cad[id].periode.push(await dalamScope(pool, [id], (c) => periode(c, id, 'PARTNER'), { commit: true }));
        const r = await dalamScope(pool, [id], async (c) => rekap(c, id, await periode(c, id, 'INTERNAL')), { commit: true });
        cad[id].rekap.push(r);
        cad[id].baris.push(await dalamScope(pool, [id], (c) => baris(c, id, r), { commit: true }));
      }
    });
    it.each(TABEL.map(([t]) => t))('%s: scope A tidak menyentuh baris B; RLS dimatikan => kebocoran terdeteksi', async (tabel) => {
      const [, sisip, hanyaTambah] = TABEL.find(([t]) => t === tabel)!;
      const sisipan = async (c: string) => {
        const s = sisip(c);
        if (tabel === 'payroll_recap_lines') return { text: s.text, values: [c, cad[c].rekap[0], await person()] };
        return s;
      };
      const buat = (id: string) => dalamScope(pool, [id], async (c) => {
        const s = await sisipan(id);
        return (await c.query(`${s.text} RETURNING id`, s.values)).rows[0].id as string;
      }, { commit: true });
      const idA = await buat(A);
      const idB = await buat(B);
      // Sisipan lintas perusahaan dibuat DI MUKA (async) agar sisipUntuk sinkron.
      const lintas = async () => {
        const s = await sisipan(B);
        return s;
      };
      let siap = await lintas();
      const k: KonfigKebocoran = { tabel, companyA: A, companyB: B, idBarisA: idA, idBarisB: idB, sisipUntuk: () => siap };
      // Tabel hanya-tambah/terkunci: UPDATE/DELETE ditolak trigger (bukan RLS); baris/komponen DRAFT tetap dapat diubah sehingga diuji penuh.
      const saring = (l: string[]) => l.filter((x) => !(hanyaTambah && /UPDATE|DELETE/.test(x)));
      const jalankan = async () => {
        siap = await lintas();
        return saring(await cekKebocoran(pool, k));
      };
      expect(await jalankan()).toEqual([]);
      // Trigger kekekalan membaca induk (payroll_recaps) lewat RLS-nya sendiri: induk ikut dimatikan agar kebocoran TABEL ANAK terukur.
      const dimatikan = tabel === 'payroll_recap_lines' ? [tabel, 'payroll_recaps'] : tabel === 'payroll_components' ? [tabel, 'payroll_recap_lines', 'payroll_recaps'] : [tabel];
      for (const t of dimatikan) await pool.query(`ALTER TABLE ${t} DISABLE ROW LEVEL SECURITY`);
      try {
        expect(await jalankan()).toEqual(expect.arrayContaining(['SELECT massal melihat baris perusahaan lain', 'SELECT per ID melihat baris perusahaan lain', 'INSERT menulis baris untuk perusahaan lain', 'Tanpa scope tetap melihat baris']));
      } finally {
        for (const t of dimatikan) await pool.query(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
      }
      expect(await jalankan()).toEqual([]);
    });
  });
});
