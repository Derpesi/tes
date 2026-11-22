import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool, PoolClient } from 'pg';
import request from 'supertest';
import { urlAplikasiTanpaBypass } from './helpers/role-app';

const DB_URL = process.env.TEST_DATABASE_URL;
const jalan = DB_URL ? describe : describe.skip;

const ORIGIN = 'https://hris.contoh.invalid';
process.env.APP_BASE_URL = ORIGIN;
process.env.AUTH_HMAC_KEY = randomBytes(32).toString('base64');
process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString('base64');
process.env.TRUST_PROXY = '1';

interface Sesi { cookie: string; csrf: string; userId: string }
interface Widget { id: string; title: string; link: string; items: { key: string; label: string; value: number }[] }
const wib = (s: string) => new Date(`${s.replace(' ', 'T')}:00+07:00`);
const HARI = '2026-03-11';

/** Harapan widget per peran menurut matriks izin (docs/rbac.md + seed). */
const HARAPAN: Record<string, string[]> = {
  dir: ['karyawan', 'member', 'lamaran', 'pkwt', 'absensi_hari_ini', 'tinjauan_absensi', 'koreksi_absensi', 'titik_absensi', 'payroll', 'pengguna', 'rekanan'],
  hrd: ['karyawan', 'member', 'lamaran', 'pkwt', 'absensi_hari_ini', 'rekanan'],
  it: ['titik_absensi', 'pengguna', 'rekanan'],
  mo: ['karyawan', 'penempatan', 'lamaran', 'pkwt', 'absensi_hari_ini', 'tinjauan_absensi', 'koreksi_absensi', 'titik_absensi', 'payroll', 'rekanan'],
  mkt: ['karyawan', 'lamaran', 'rekanan'],
  adm: ['karyawan', 'member', 'lamaran', 'pkwt', 'absensi_hari_ini', 'titik_absensi', 'rekanan'],
  keu: ['pkwt', 'absensi_hari_ini', 'payroll', 'rekanan'],
  payabs: ['karyawan', 'pkwt', 'absensi_hari_ini', 'tinjauan_absensi', 'koreksi_absensi', 'titik_absensi', 'payroll', 'rekanan'],
  payint: ['absensi_hari_ini', 'tinjauan_absensi', 'koreksi_absensi', 'payroll'],
};
const ROLE: Record<string, string> = { dir: 'DIREKTUR', hrd: 'HRD', it: 'IT_ADMIN', mo: 'MANAGER_OPERASIONAL', mkt: 'MARKETING', adm: 'STAFF_ADMINISTRASI', keu: 'STAFF_KEUANGAN', payabs: 'STAFF_PAYROLL_ABSENSI_REKANAN', payint: 'STAFF_PAYROLL_INTERNAL' };

// Semua data SINTETIS.
jalan('Dashboard staf: widget per izin, akurasi angka, isolasi, dan tanpa data pribadi (PostgreSQL asli)', () => {
  let app: INestApplication;
  let pool: Pool;
  let nomorIp = 1;
  let A: string;
  let B: string;
  let u1: string;
  let u2: string;
  let u3: string;
  let sessions: import('../src/auth/session.service').SessionService;
  const s: Record<string, Sesi> = {};
  let awalMember: Record<string, number>;
  let awalPengguna: Record<string, number>;

  beforeAll(async () => {
    execFileSync('node', ['scripts/migrate.js', 'up'], { env: { ...process.env, DATABASE_URL: DB_URL } });
    const { AppModule } = await import('../src/app.module');
    const { konfigurasiApp } = await import('../src/app.factory');
    const { SessionService } = await import('../src/auth/session.service');
    const { JAM_ABSENSI } = await import('../src/attendance/jam');
    process.env.DATABASE_URL = await urlAplikasiTanpaBypass(DB_URL!);
    const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(JAM_ABSENSI).useValue(() => wib(`${HARI} 10:00`)).compile();
    app = mod.createNestApplication();
    konfigurasiApp(app);
    await app.init();
    sessions = app.get(SessionService);
    pool = new Pool({ connectionString: DB_URL, max: 6 });
    A = (await pool.query(`INSERT INTO companies (name) VALUES ($1) RETURNING id`, [`PT SINTETIS A ${randomBytes(3).toString('hex')}`])).rows[0].id;
    B = (await pool.query(`INSERT INTO companies (name) VALUES ($1) RETURNING id`, [`PT SINTETIS B ${randomBytes(3).toString('hex')}`])).rows[0].id;
    for (const k of Object.keys(ROLE)) s[k] = await buatStaff([ROLE[k]], [A]);
    s.moB = await buatStaff(['MANAGER_OPERASIONAL'], [B]);
    s.dirB = await buatStaff(['DIREKTUR'], [B]);
    s.tanpaPeran = await buatStaff([], [A]);
    [u1, u2, u3] = [s.mo.userId, s.keu.userId, s.dir.userId];
    awalMember = hitungan(await widget(s.dir, 'member'));
    awalPengguna = hitungan(await widget(s.dir, 'pengguna'));
  });
  afterAll(async () => {
    await pool?.end();
    await app?.close();
  });

  const ipBaru = () => `10.96.${Math.floor(nomorIp / 250)}.${(nomorIp++ % 250) + 1}`;
  const http = (path: string, x?: Sesi) => {
    let r = request(app.getHttpServer()).get(path).set('X-Forwarded-For', ipBaru()).set('Origin', ORIGIN);
    if (x) r = r.set('Cookie', x.cookie).set('X-CSRF-Token', x.csrf);
    return r;
  };
  const buatStaff = async (roles: string[], companyIds: string[]): Promise<Sesi> => {
    const u = (await pool.query(`INSERT INTO users (realm, email, status) VALUES ('staff', $1, 'AKTIF') RETURNING id`, [`s-${randomBytes(4).toString('hex')}@contoh.invalid`])).rows[0].id as string;
    for (const role of roles) await pool.query(`INSERT INTO user_roles (user_id, role_code, grant_source) VALUES ($1, $2, 'MANUAL')`, [u, role]);
    for (const c of companyIds) await pool.query(`INSERT INTO user_company_scopes (user_id, scope_company_id) VALUES ($1, $2)`, [u, c]);
    const x = await sessions.buat({ userId: u, realm: 'staff', state: 'PENUH' });
    return { cookie: `__Host-sid=${x.token}`, csrf: x.csrfToken, userId: u };
  };
  const tenant = async <T>(companyIds: string[], fn: (c: PoolClient) => Promise<T>): Promise<T> => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.company_ids', $1, true)`, [companyIds.join(',')]);
      const r = await fn(c);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  };
  const semua = async (x: Sesi) => (await http('/dashboard/staff', x).expect(200)).body as { today: string; widgets: Widget[] };
  const widget = async (x: Sesi, id: string) => (await semua(x)).widgets.find((w) => w.id === id) as Widget;
  const hitungan = (w: Widget) => Object.fromEntries(w.items.map((i) => [i.key, i.value])) as Record<string, number>;

  /** Rantai kontrak AKTIF + penempatan di lokasi perusahaan (status penempatan dapat diatur). */
  const kontrakAktif = async (company: string, lokasi: string, akhir: string, statusPenempatan = 'AKTIF') =>
    tenant([company], async (c) => {
      const person = (await pool.query(`INSERT INTO persons (display_name) VALUES ('SINTETIS Pekerja') RETURNING id`)).rows[0].id as string;
      const v = (await c.query(`INSERT INTO job_vacancies (company_id, title, description, created_by) VALUES ($1, 'L', 'D', $2) RETURNING id`, [company, u1])).rows[0].id;
      const lamaran = (await c.query(`INSERT INTO job_applications (company_id, vacancy_id, person_id, status) VALUES ($1, $2, $3, 'DITERIMA') RETURNING id`, [company, v, person])).rows[0].id;
      const tpl = (await c.query(`INSERT INTO contract_templates (company_id, name, version, body, created_by) VALUES ($1, $2, 1, 'CONTOH UJI', $3) RETURNING id`, [company, `T ${randomBytes(3).toString('hex')}`, u1])).rows[0].id;
      await c.query(`UPDATE contract_templates SET status = 'TERVERIFIKASI', verified_by = $2, verified_at = now(), verification_note = 'uji' WHERE id = $1`, [tpl, u2]);
      const k = (await c.query(`INSERT INTO employment_contracts (company_id, application_id, person_id, template_id, contract_number, position, start_date, end_date, created_by) VALUES ($1, $2, $3, $4, $5, 'Satpam', '2026-01-01', $6, $7) RETURNING id`, [company, lamaran, person, tpl, `PKWT/${randomBytes(4).toString('hex')}`, akhir, u1])).rows[0].id;
      await c.query(`UPDATE employment_contracts SET status = 'PERSETUJUAN', reviewed_by = $2, reviewed_at = now() WHERE id = $1`, [k, u2]);
      await c.query(`UPDATE employment_contracts SET status = 'PENANDATANGANAN', approved_by = $2, approved_at = now() WHERE id = $1`, [k, u3]);
      await c.query(`INSERT INTO contract_documents (company_id, contract_id, version_no, object_key, original_filename, mime_type, size_bytes, sha256, status, uploaded_by, verified_by, verified_at) VALUES ($1, $2, 1, $3, 's.pdf', 'application/pdf', 10, $4, 'TERVERIFIKASI', $5, $6, now())`, [company, k, `${company}/${randomUUID()}`, randomBytes(32), u1, u2]);
      await c.query(`UPDATE employment_contracts SET status = 'DITANDATANGANI' WHERE id = $1`, [k]);
      await c.query(`UPDATE employment_contracts SET status = 'AKTIF', activated_at = now() WHERE id = $1`, [k]);
      await c.query(`INSERT INTO placements (company_id, person_id, contract_id, location_id, start_date, status, approved_by, approved_at, created_by) VALUES ($1, $2, $3, $4, '2026-01-01', $5, $6, now(), $7)`, [company, person, k, lokasi, statusPenempatan, u3, u1]);
      return { person };
    });
  const lokasiBaru = (company: string) =>
    tenant([company], async (c) => {
      const p = (await c.query(`INSERT INTO partners (company_id, name, created_by) VALUES ($1, $2, $3) RETURNING id`, [company, `Rek ${randomBytes(3).toString('hex')}`, u1])).rows[0].id;
      const l = (await c.query(`INSERT INTO partner_locations (company_id, partner_id, name, latitude, longitude, created_by) VALUES ($1, $2, 'Lokasi Dash', -6.9, 107.6, $3) RETURNING id`, [company, p, u1])).rows[0].id;
      return { partner: p as string, lokasi: l as string };
    });

  describe('widget per izin (matriks peran)', () => {
    it.each(Object.keys(HARAPAN))('%s melihat tepat widget yang diizinkan perannya', async (k) => {
      const d = await semua(s[k]);
      expect(d.today).toBe(HARI);
      expect(d.widgets.map((w) => w.id).sort()).toEqual([...HARAPAN[k]].sort());
    });
    it('staf tanpa peran: dashboard kosong (bukan galat); member 403; tanpa sesi 401', async () => {
      expect((await semua(s.tanpaPeran)).widgets).toEqual([]);
      const personM = (await pool.query(`INSERT INTO persons (display_name) VALUES ('SINTETIS Member') RETURNING id`)).rows[0].id;
      const um = (await pool.query(`INSERT INTO users (person_id, realm, email, status) VALUES ($1, 'member', $2, 'AKTIF') RETURNING id`, [personM, `m-${randomBytes(3).toString('hex')}@contoh.invalid`])).rows[0].id;
      const sm = await sessions.buat({ userId: um, realm: 'member', state: 'PENUH' });
      await http('/dashboard/staff', { cookie: `__Host-sid=${sm.token}`, csrf: sm.csrfToken, userId: um }).expect(403);
      await http('/dashboard/staff').expect(401);
    });
    it('payroll hanya menampilkan jenis yang boleh dilihat peran (PayAbs/Mgr Ops rekanan; PayInt internal; Direktur/Keuangan keduanya)', async () => {
      const kunci = async (k: string) => (await widget(s[k], 'payroll')).items.map((i) => i.key.split('_')[0]).filter((v, i, a) => a.indexOf(v) === i).sort();
      expect(await kunci('payabs')).toEqual(['partner']);
      expect(await kunci('mo')).toEqual(['partner']);
      expect(await kunci('payint')).toEqual(['internal']);
      expect(await kunci('dir')).toEqual(['internal', 'partner']);
      expect(await kunci('keu')).toEqual(['internal', 'partner']);
    });
  });

  describe('akurasi angka (data sintetis terkontrol, perusahaan A)', () => {
    it('karyawan, penempatan, rekrutmen, PKWT, titik, koreksi, tinjauan, absensi hari ini, payroll, rekanan', async () => {
      const { partner, lokasi } = await lokasiBaru(A);
      const lokB = await lokasiBaru(B);
      await tenant([A], (c) => c.query(`INSERT INTO partners (company_id, name, status, created_by) VALUES ($1, $2, 'NONAKTIF', $3)`, [A, `Rek Non ${randomBytes(3).toString('hex')}`, u1]));
      // 3 karyawan: 1 kontrak berakhir 10 hari lagi tanpa lanjutan, 1 jauh, 1 ditangguhkan; lalu penempatan menunggu
      const p1 = await kontrakAktif(A, lokasi, '2026-03-21');
      await kontrakAktif(A, lokasi, '2026-12-31');
      await kontrakAktif(A, lokasi, '2026-12-31', 'DITANGGUHKAN');
      const rencana = (await pool.query(`INSERT INTO persons (display_name) VALUES ('SINTETIS Rencana') RETURNING id`)).rows[0].id;
      await tenant([A], async (c) => {
        for (const st of ['DIRENCANAKAN', 'DIRENCANAKAN', 'MENUNGGU_KONTRAK']) {
          const o = (await pool.query(`INSERT INTO persons (display_name) VALUES ('SINTETIS Rencana') RETURNING id`)).rows[0].id;
          await c.query(`INSERT INTO placements (company_id, person_id, location_id, start_date, end_date, status, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [A, o, lokasi, st === 'DIRENCANAKAN' ? '2027-01-01' : '2028-01-01', st === 'DIRENCANAKAN' ? '2027-02-01' : '2028-02-01', st, u1]);
        }
        void rencana;
      });
      // lowongan dan lamaran
      await tenant([A], async (c) => {
        const buka = (await c.query(`INSERT INTO job_vacancies (company_id, title, description, status, created_by) VALUES ($1, 'Dibuka', 'D', 'DIBUKA', $2) RETURNING id`, [A, u1])).rows[0].id;
        await c.query(`INSERT INTO job_vacancies (company_id, title, description, status, created_by) VALUES ($1, 'Draf', 'D', 'DRAFT', $2)`, [A, u1]);
        for (const st of ['DIAJUKAN', 'DIAJUKAN', 'SELEKSI_ADMINISTRASI', 'INTERVIEW', 'MENUNGGU_PKWT', 'DITOLAK']) {
          const o = (await pool.query(`INSERT INTO persons (display_name) VALUES ('SINTETIS Pelamar') RETURNING id`)).rows[0].id;
          await c.query(`INSERT INTO job_applications (company_id, vacancy_id, person_id, status) VALUES ($1, $2, $3, $4)`, [A, buka, o, st]);
        }
      });
      // titik, koreksi, tinjauan, absensi hari ini
      const t = await tenant([A], async (c) => {
        const titik = (await c.query(`INSERT INTO attendance_points (company_id, location_id, created_by) VALUES ($1, $2, $3) RETURNING id`, [A, lokasi, u1])).rows[0].id as string;
        const l2 = (await c.query(`INSERT INTO partner_locations (company_id, partner_id, name, created_by) VALUES ($1, $2, 'Lokasi Dua', $3) RETURNING id`, [A, partner, u1])).rows[0].id;
        await c.query(`INSERT INTO attendance_points (company_id, location_id, status, created_by) VALUES ($1, $2, 'NONAKTIF', $3)`, [A, l2, u1]);
        return titik;
      });
      const placement = (await tenant([A], (c) => c.query(`SELECT id, person_id FROM placements WHERE person_id = $1`, [p1.person]))).rows[0];
      const rekaman = (kind: string, status: string, tanggal: string, orang = placement.person_id as string) =>
        tenant([A], async (c) => (await c.query(`INSERT INTO attendance_records (company_id, person_id, placement_id, point_id, location_id, kind, status, reject_reason, shift_date, occurred_at, idempotency_key) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`, [A, orang, placement.id, t, lokasi, kind, status, status === 'DITOLAK' ? 'LUAR_RADIUS' : null, tanggal, wib(`${tanggal} 08:00`), `dash-${randomBytes(6).toString('hex')}`])).rows[0].id as string);
      const orangBaru = async () => (await pool.query(`INSERT INTO persons (display_name) VALUES ('SINTETIS Orang') RETURNING id`)).rows[0].id as string;
      const [q1, q2, q3] = [await orangBaru(), await orangBaru(), await orangBaru()];
      await rekaman('MASUK', 'VALID', HARI);
      await rekaman('PULANG', 'VALID', HARI);
      const pv1 = await rekaman('PULANG', 'PERLU_VERIFIKASI', HARI, q1);
      await rekaman('MASUK', 'DITOLAK', HARI, q3);
      await rekaman('MASUK', 'VALID', '2026-03-10'); // kemarin: tidak dihitung pada "hari ini"
      const pv2 = await rekaman('PULANG', 'PERLU_VERIFIKASI', '2026-03-09', q2);
      await tenant([A], async (c) => {
        await c.query(`INSERT INTO attendance_reviews (company_id, record_id, stage, decision, actor_id, reason) VALUES ($1, $2, 'PERIKSA', 'DIPERIKSA', $3, 'periksa')`, [A, pv2, u2]);
        for (const st of ['DIAJUKAN', 'DIAJUKAN', 'DISETUJUI']) {
          await c.query(`INSERT INTO attendance_adjustments (company_id, adjustment_no, person_id, shift_date, effect, reason, status, created_by, decided_by, decided_at) VALUES ($1, $2, $3, '2026-03-05', 'HADIR', 'alasan', $4, $5, $6, $7)`, [A, `KOR/${randomBytes(4).toString('hex')}`, placement.person_id, st, u1, st === 'DIAJUKAN' ? null : u3, st === 'DIAJUKAN' ? null : new Date()]);
        }
      });
      void pv1;
      // payroll: periode PARTNER (draf, diverifikasi, disetujui) + INTERNAL (draf); rekap digantikan tidak dihitung
      await tenant([A], async (c) => {
        const per = async (kind: string, mulai: string, akhir: string) => (await c.query(`INSERT INTO payroll_periods (company_id, kind, label, start_date, end_date, created_by) VALUES ($1, $2, 'P', $3, $4, $5) RETURNING id`, [A, kind, mulai, akhir, u1])).rows[0].id as string;
        const rk = async (p: string, st: string) => {
          const id = (await c.query(`INSERT INTO payroll_recaps (company_id, period_id, version_no, created_by) VALUES ($1, $2, 1, $3) RETURNING id`, [A, p, u1])).rows[0].id;
          if (st !== 'DRAFT') await c.query(`UPDATE payroll_recaps SET status = 'DIVERIFIKASI', reviewed_by = $2, reviewed_at = now() WHERE id = $1`, [id, u2]);
          if (['DISETUJUI', 'DIGANTIKAN'].includes(st)) await c.query(`UPDATE payroll_recaps SET status = 'DISETUJUI', approved_by = $2, approved_at = now(), snapshot_hash = $3 WHERE id = $1`, [id, u3, 'a'.repeat(64)]);
          if (st === 'DIGANTIKAN') await c.query(`UPDATE payroll_recaps SET status = 'DIGANTIKAN' WHERE id = $1`, [id]);
        };
        await rk(await per('PARTNER', '2100-01-01', '2100-01-31'), 'DRAFT');
        await rk(await per('PARTNER', '2100-02-01', '2100-02-28'), 'DIVERIFIKASI');
        await rk(await per('PARTNER', '2100-03-01', '2100-03-31'), 'DISETUJUI');
        await rk(await per('PARTNER', '2100-04-01', '2100-04-30'), 'DIGANTIKAN');
        await rk(await per('INTERNAL', '2100-01-01', '2100-01-31'), 'DRAFT');
      });

      expect(hitungan(await widget(s.dir, 'karyawan'))).toEqual({ aktif: 2, ditangguhkan: 1, akan_berakhir: 1 });
      expect(hitungan(await widget(s.mo, 'penempatan'))).toEqual({ direncanakan: 2, menunggu_kontrak: 1 });
      expect(hitungan(await widget(s.hrd, 'lamaran'))).toEqual({ lowongan_dibuka: 1, diajukan: 2, seleksi: 1, interview: 1, menunggu_pkwt: 1 }); // lowongan rantai kontrak berstatus DRAFT; lamaran DITERIMA/DITOLAK tidak dihitung
      expect(hitungan(await widget(s.hrd, 'pkwt'))).toMatchObject({ draf: 0, aktif: 3 });
      expect(hitungan(await widget(s.dir, 'absensi_hari_ini'))).toEqual({ masuk: 1, valid: 2, perlu_verifikasi: 1, ditolak: 1 });
      expect(hitungan(await widget(s.payabs, 'tinjauan_absensi'))).toEqual({ menunggu_periksa: 1, menunggu_putusan: 1 });
      expect(hitungan(await widget(s.payint, 'koreksi_absensi'))).toEqual({ diajukan: 2 });
      expect(hitungan(await widget(s.adm, 'titik_absensi'))).toEqual({ aktif: 1 });
      expect(hitungan(await widget(s.dir, 'rekanan'))).toEqual({ rekanan_aktif: 1, lokasi_aktif: 2, kontrak_aktif: 0, kontrak_menunggu: 0 });
      expect(hitungan(await widget(s.keu, 'payroll'))).toEqual({ partner_draf: 1, partner_diverifikasi: 1, partner_disetujui: 1, partner_difinalisasi: 0, internal_draf: 1, internal_diverifikasi: 0, internal_disetujui: 0, internal_difinalisasi: 0 });
      expect(hitungan(await widget(s.payabs, 'payroll'))).toEqual({ partner_draf: 1, partner_diverifikasi: 1, partner_disetujui: 1, partner_difinalisasi: 0 });
      void lokB;
    });

    it('widget global (member, pengguna) mengikuti perubahan data', async () => {
      // member_profiles memerlukan kelengkapan untuk status lanjut; status awal TERDAFTAR tidak dihitung widget -> pakai pembaruan lengkap untuk satu status
      const p = (await pool.query(`INSERT INTO persons (display_name) VALUES ('SINTETIS Member') RETURNING id`)).rows[0].id;
      const pid = (await pool.query(`INSERT INTO member_profiles (person_id) VALUES ($1) RETURNING id`, [p])).rows[0].id;
      const { enkripsiNik, blindIndexNik } = await import('../src/common/crypto/pii');
      const nik = `98${String(Math.floor(Math.random() * 1e14)).padStart(14, '0')}`;
      await pool.query(
        `UPDATE member_profiles SET nik_enc = $2, nik_hmac = $3, status = 'MENUNGGU_VERIFIKASI', full_name = 'SINTETIS', birth_place = 'K', birth_date = '1990-01-01', gender = 'L', address = 'A', city = 'B', province = 'P', phone = '08123456', education = 'SMA/SMK', emergency_contact_name = 'E', emergency_contact_phone = '08123457' WHERE id = $1`,
        [pid, enkripsiNik(nik, Buffer.from(process.env.APP_ENCRYPTION_KEY!, 'base64'), pid), blindIndexNik(Buffer.from(process.env.AUTH_HMAC_KEY!, 'base64'), nik)],
      );
      const m = hitungan(await widget(s.dir, 'member'));
      expect(m.menunggu_verifikasi).toBe(awalMember.menunggu_verifikasi + 1);
      expect(m.belum_ditempatkan).toBe(awalMember.belum_ditempatkan);
      await pool.query(`INSERT INTO users (realm, email, status) VALUES ('staff', $1, 'DIUNDANG'), ('staff', $2, 'DIUNDANG')`, [`inv-${randomBytes(3).toString('hex')}@contoh.invalid`, `inv-${randomBytes(3).toString('hex')}@contoh.invalid`]);
      await pool.query(`INSERT INTO approval_requests (type, requested_by, subject_user_id, status, expires_at) VALUES ('RESET_MFA', $1, $2, 'MENUNGGU', now() + interval '1 day'), ('RESET_MFA', $1, $2, 'MENUNGGU', now() - interval '1 day')`, [s.it.userId, s.hrd.userId]);
      const u = hitungan(await widget(s.it, 'pengguna'));
      expect(u.diundang).toBe(awalPengguna.diundang + 2);
      expect(u.persetujuan_menunggu).toBe(awalPengguna.persetujuan_menunggu + 1); // yang kedaluwarsa tidak dihitung
    });
  });

  describe('isolasi dan privasi', () => {
    it('ISOLASI: staf B hanya melihat angka B; data A tidak bocor; RLS dimatikan => bocor (tes gagal bila RLS mati)', async () => {
      const lokB = await lokasiBaru(B);
      await kontrakAktif(B, lokB.lokasi, '2026-12-31');
      expect(hitungan(await widget(s.moB, 'karyawan'))).toEqual({ aktif: 1, ditangguhkan: 0, akan_berakhir: 0 });
      expect(hitungan(await widget(s.moB, 'penempatan'))).toEqual({ direncanakan: 0, menunggu_kontrak: 0 });
      expect(hitungan(await widget(s.dirB, 'absensi_hari_ini'))).toEqual({ masuk: 0, valid: 0, perlu_verifikasi: 0, ditolak: 0 });
      expect(hitungan(await widget(s.dirB, 'payroll'))).toMatchObject({ partner_draf: 0, partner_disetujui: 0 });
      expect(hitungan(await widget(s.dir, 'karyawan')).aktif).toBe(2); // A tidak melihat B
      const tabel = ['placements', 'employment_contracts'];
      for (const t of tabel) await pool.query(`ALTER TABLE ${t} DISABLE ROW LEVEL SECURITY`);
      try {
        expect(hitungan(await widget(s.moB, 'karyawan')).aktif).toBeGreaterThan(1); // tanpa RLS angka lintas perusahaan bocor
      } finally {
        for (const t of tabel) await pool.query(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
      }
      expect(hitungan(await widget(s.moB, 'karyawan')).aktif).toBe(1);
    });

    it('respons hanya berisi id/judul/tautan/angka: tanpa nama, NIK, email, atau nominal', async () => {
      for (const k of Object.keys(HARAPAN)) {
        const d = await semua(s[k]);
        for (const w of d.widgets) {
          expect(Object.keys(w).sort()).toEqual(['id', 'items', 'link', 'title']);
          expect(w.link).toMatch(/^\/staff\//);
          for (const i of w.items) {
            expect(Object.keys(i).sort()).toEqual(['key', 'label', 'value']);
            expect(Number.isInteger(i.value) && i.value >= 0).toBe(true);
          }
        }
        expect(JSON.stringify(d)).not.toMatch(/SINTETIS|@contoh|nik|nominal|amount|gaji/i);
      }
    });
  });
});
