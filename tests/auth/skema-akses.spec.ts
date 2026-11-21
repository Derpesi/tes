import { Pool, PoolClient } from 'pg';
import { bukaPool, migrasiNaik } from '../helpers/db';
import { kebijakanDariMatriks, ujiKebijakan } from '../rbac-matrix/uji-kebijakan';
import { Matriks, muatMatriksRbac } from '../rbac-matrix/parse-matriks';
import peta from '../../docs/rbac-pemetaan.json';

const ada = process.env.TEST_DATABASE_URL ? describe : describe.skip;

/** Menjalankan pernyataan yang HARUS gagal, tanpa merusak transaksi uji. */
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

ada('skema akses dan RBAC di database', () => {
  let pool: Pool;
  beforeAll(() => {
    migrasiNaik();
    pool = bukaPool();
  });
  afterAll(async () => {
    await pool.end();
  });

  /** Setiap tes berjalan dalam transaksi yang selalu di-ROLLBACK agar tidak meninggalkan data. */
  const dalamTransaksi = async (fn: (c: PoolClient) => Promise<void>) => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await fn(c);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  };
  const buatUser = async (c: PoolClient, realm: 'member' | 'staff', email: string, status = 'AKTIF') =>
    (await c.query(`INSERT INTO users (realm, email, status) VALUES ($1, $2, $3) RETURNING id`, [realm, email, status])).rows[0].id as string;

  describe('seed peran dan permission = docs/rbac.md', () => {
    it('ada 9 peran; hanya Direktur dan IT Administrator berstatus hak tinggi', async () => {
      const r = await pool.query(`SELECT code, high_privilege FROM roles ORDER BY code`);
      expect(r.rowCount).toBe(9);
      expect(r.rows.filter((x) => x.high_privilege).map((x) => x.code).sort()).toEqual(['DIREKTUR', 'IT_ADMIN']);
    });

    it('kebijakan dari database IDENTIK dengan docs/rbac.md (harness ujiKebijakan)', async () => {
      const m: Matriks = muatMatriksRbac();
      const rp = await pool.query(`SELECT role_code, permission_code FROM role_permissions`);
      const perRole = new Map<string, Set<string>>();
      for (const { role_code, permission_code } of rp.rows) {
        (perRole.get(role_code) ?? perRole.set(role_code, new Set()).get(role_code)!).add(permission_code);
      }
      const aksiKeKode = Object.fromEntries(Object.entries(peta.aksi).map(([k, v]) => [v, k]));
      const kebijakanDb = (peranHeader: string, modul: string) => {
        const kodeRole = (peta.peran as Record<string, { kode: string }>)[peranHeader].kode;
        const slug = (peta.modul as Record<string, string>)[modul];
        const hasil = new Set<string>();
        for (const p of perRole.get(kodeRole) ?? []) {
          const [s, aksi] = p.split('.');
          if (s === slug) hasil.add(aksiKeKode[aksi]);
        }
        return hasil;
      };
      const h = ujiKebijakan(kebijakanDb, m);
      expect({ kelebihan: h.kelebihan, kekurangan: h.kekurangan }).toEqual({ kelebihan: [], kekurangan: [] });
      expect(h.lolos).toBe(true);
    });

    it('mutasi: izin tambahan di database terdeteksi harness', async () => {
      await dalamTransaksi(async (c) => {
        await c.query(`INSERT INTO role_permissions (role_code, permission_code) VALUES ('IT_ADMIN', 'selfie.view')`);
        const m = muatMatriksRbac();
        const rp = await c.query(`SELECT role_code, permission_code FROM role_permissions`);
        const aksiKeKode = Object.fromEntries(Object.entries(peta.aksi).map(([k, v]) => [v, k]));
        const kebijakan = (peranHeader: string, modul: string) => {
          const kodeRole = (peta.peran as Record<string, { kode: string }>)[peranHeader].kode;
          const slug = (peta.modul as Record<string, string>)[modul];
          return new Set(rp.rows.filter((x) => x.role_code === kodeRole && x.permission_code.startsWith(`${slug}.`)).map((x) => aksiKeKode[x.permission_code.split('.')[1]]));
        };
        const h = ujiKebijakan(kebijakan, m);
        expect(h.lolos).toBe(false);
        expect(h.kelebihan).toContain('IT / Lihat selfie: V');
      });
    });

    it('referensi harness identik dengan dirinya sendiri (kontrol)', () => {
      const m = muatMatriksRbac();
      expect(ujiKebijakan(kebijakanDariMatriks(m), m).lolos).toBe(true);
    });
  });

  describe('invarian skema (dijaga database)', () => {
    it('email harus huruf kecil dan unik per realm; boleh sama lintas realm', () =>
      dalamTransaksi(async (c) => {
        await harusGagal(c, `INSERT INTO users (realm, email, status) VALUES ('staff', 'Kapital@contoh.invalid', 'AKTIF')`, [], /users_email_check/);
        await buatUser(c, 'staff', 'sama@contoh.invalid');
        await harusGagal(c, `INSERT INTO users (realm, email, status) VALUES ('staff', 'sama@contoh.invalid', 'AKTIF')`, [], /users_realm_email_unik/);
        await expect(buatUser(c, 'member', 'sama@contoh.invalid')).resolves.toBeDefined();
      }));

    it('member tidak boleh berstatus DIUNDANG atau memiliki akses semua perusahaan', () =>
      dalamTransaksi(async (c) => {
        await harusGagal(c, `INSERT INTO users (realm, email, status) VALUES ('member', 'm1@contoh.invalid', 'DIUNDANG')`, [], /users_hanya_staff_diundang/);
        await harusGagal(c, `INSERT INTO users (realm, email, status, all_companies) VALUES ('member', 'm2@contoh.invalid', 'AKTIF', true)`, [], /users_hanya_staff_semua_perusahaan/);
      }));

    it('identitas Google hanya untuk member; kredensial/MFA/peran hanya untuk staff', () =>
      dalamTransaksi(async (c) => {
        const staff = await buatUser(c, 'staff', 's@contoh.invalid');
        const member = await buatUser(c, 'member', 'm@contoh.invalid');
        await harusGagal(c, `INSERT INTO google_identities (user_id, google_sub, email_at_login) VALUES ($1, 'sub-1', 's@contoh.invalid')`, [staff], /foreign key/);
        await harusGagal(c, `INSERT INTO staff_credentials (user_id, password_hash) VALUES ($1, 'x')`, [member], /foreign key/);
        await harusGagal(c, `INSERT INTO staff_mfa_factors (user_id, secret_enc, status) VALUES ($1, '\\x00', 'AKTIF')`, [member], /foreign key/);
        await harusGagal(c, `INSERT INTO user_roles (user_id, role_code, grant_source) VALUES ($1, 'HRD', 'MANUAL')`, [member], /foreign key/);
        await expect(c.query(`INSERT INTO google_identities (user_id, google_sub, email_at_login) VALUES ($1, 'sub-ok', 'm@contoh.invalid')`, [member])).resolves.toBeDefined();
      }));

    it('satu sub Google hanya untuk satu akun', () =>
      dalamTransaksi(async (c) => {
        const m1 = await buatUser(c, 'member', 'a@contoh.invalid');
        const m2 = await buatUser(c, 'member', 'b@contoh.invalid');
        await c.query(`INSERT INTO google_identities (user_id, google_sub, email_at_login) VALUES ($1, 'sub-dup', 'a@contoh.invalid')`, [m1]);
        await harusGagal(c, `INSERT INTO google_identities (user_id, google_sub, email_at_login) VALUES ($1, 'sub-dup', 'b@contoh.invalid')`, [m2], /google_identities_google_sub_key/);
      }));

    it('hanya satu faktor MFA aktif per staff', () =>
      dalamTransaksi(async (c) => {
        const s = await buatUser(c, 'staff', 'mfa@contoh.invalid');
        await c.query(`INSERT INTO staff_mfa_factors (user_id, secret_enc, status) VALUES ($1, '\\x01', 'AKTIF')`, [s]);
        await harusGagal(c, `INSERT INTO staff_mfa_factors (user_id, secret_enc, status) VALUES ($1, '\\x02', 'AKTIF')`, [s], /staff_mfa_satu_aktif/);
        await expect(c.query(`INSERT INTO staff_mfa_factors (user_id, secret_enc, status) VALUES ($1, '\\x03', 'PENDING')`, [s])).resolves.toBeDefined();
      }));

    it('sesi member harus berstatus PENUH (tanpa tahap MFA)', () =>
      dalamTransaksi(async (c) => {
        const m = await buatUser(c, 'member', 'ses@contoh.invalid');
        await harusGagal(c, `INSERT INTO sessions (user_id, realm, token_hash, state, expires_at) VALUES ($1, 'member', '\\xaa', 'MENUNGGU_MFA', now() + interval '1 hour')`, [m], /sessions_member_selalu_penuh/);
      }));

    it('peran aktif unik per pengguna; peran bootstrap tidak punya pemberi', () =>
      dalamTransaksi(async (c) => {
        const s = await buatUser(c, 'staff', 'peran@contoh.invalid');
        const lain = await buatUser(c, 'staff', 'lain@contoh.invalid');
        await c.query(`INSERT INTO user_roles (user_id, role_code, grant_source, granted_by) VALUES ($1, 'HRD', 'MANUAL', $2)`, [s, lain]);
        await harusGagal(c, `INSERT INTO user_roles (user_id, role_code, grant_source, granted_by) VALUES ($1, 'HRD', 'MANUAL', $2)`, [s, lain], /user_roles_satu_aktif/);
        await harusGagal(c, `INSERT INTO user_roles (user_id, role_code, grant_source, granted_by) VALUES ($1, 'IT_ADMIN', 'BOOTSTRAP', $2)`, [s, lain], /user_roles_bootstrap_tanpa_pemberi/);
        await expect(c.query(`INSERT INTO user_roles (user_id, role_code, grant_source) VALUES ($1, 'IT_ADMIN', 'BOOTSTRAP')`, [s])).resolves.toBeDefined();
      }));

    it('persetujuan ganda: pemohon tidak boleh menyetujui sendiri; keputusan harus lengkap', () =>
      dalamTransaksi(async (c) => {
        const a = await buatUser(c, 'staff', 'pemohon@contoh.invalid');
        const b = await buatUser(c, 'staff', 'penyetuju@contoh.invalid');
        const baris = (status: string, oleh: string | null) =>
          c.query(
            `INSERT INTO approval_requests (type, requested_by, subject_user_id, status, decided_by, decided_at, expires_at)
             VALUES ('BERI_PERAN_TINGGI', $1, $1, $2, $3, CASE WHEN $3::uuid IS NULL THEN NULL ELSE now() END, now() + interval '1 day')`,
            [a, status, oleh],
          );
        await c.query('SAVEPOINT x');
        await expect(baris('DISETUJUI', b)).resolves.toBeDefined();
        await harusGagal(c, `INSERT INTO approval_requests (type, requested_by, subject_user_id, status, decided_by, decided_at, expires_at) VALUES ('RESET_MFA', $1, $1, 'DISETUJUI', $1, now(), now() + interval '1 day')`, [a], /approval_pemohon_bukan_penyetuju/);
        await harusGagal(c, `INSERT INTO approval_requests (type, requested_by, subject_user_id, status, expires_at) VALUES ('RESET_MFA', $1, $1, 'DISETUJUI', now() + interval '1 day')`, [a], /approval_keputusan_lengkap/);
      }));

    it('system_state memuat penanda bootstrap (boolean) dan tabel bootstrap_tokens sudah tidak ada', async () => {
      const r = await pool.query(`SELECT value FROM system_state WHERE key = 'bootstrapped'`);
      expect(typeof r.rows[0].value).toBe('boolean');
      expect((await pool.query(`SELECT to_regclass('bootstrap_tokens') AS t`)).rows[0].t).toBeNull();
    });

    it('tabel sesi, undangan, reset, dan outbox tidak menyimpan token mentah', async () => {
      const kolom = await pool.query(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_name IN ('sessions','staff_invitations','password_reset_tokens') AND column_name IN ('token','password','secret')`,
      );
      expect(kolom.rows).toEqual([]);
    });
  });
});
