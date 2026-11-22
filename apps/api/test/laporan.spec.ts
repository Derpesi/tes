import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool, PoolClient } from 'pg';
import request from 'supertest';
import { batasLaporanBerat } from '../src/common/batas-konkurensi';
import { urlAplikasiTanpaBypass } from './helpers/role-app';

const DB_URL = process.env.TEST_DATABASE_URL;
const jalan = DB_URL ? describe : describe.skip;

const ORIGIN = 'https://hris.contoh.invalid';
process.env.APP_BASE_URL = ORIGIN;
process.env.AUTH_HMAC_KEY = randomBytes(32).toString('base64');
process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString('base64');
process.env.TRUST_PROXY = '1';

interface Sesi { cookie: string; csrf: string; userId: string }
interface Baris { companyId: string | null; companyName: string; location: string | null; measure: string; value: string | number }
interface Laporan { from: string; to: string; sections: Record<string, Baris[]> }
const wib = (s: string) => new Date(`${s.replace(' ', 'T')}:00+07:00`);
const MARET = 'from=2026-03-01&to=2026-03-31';
const TAHUN = 'from=2026-01-01&to=2026-12-31';

const ROLE: Record<string, string> = { dir: 'DIREKTUR', mo: 'MANAGER_OPERASIONAL', hrd: 'HRD', mkt: 'MARKETING', keu: 'STAFF_KEUANGAN', it: 'IT_ADMIN', adm: 'STAFF_ADMINISTRASI', payabs: 'STAFF_PAYROLL_ABSENSI_REKANAN', payint: 'STAFF_PAYROLL_INTERNAL' };
/** Bagian yang boleh dilihat per peran (izin report_consolidated.view + izin domain bagian). */
const HARAPAN: Record<string, Record<string, string[]>> = {
  dir: { workforce: ['karyawan', 'kontrak', 'statusMember'], recruitment: ['lowongan', 'lamaran'], attendance: ['absensi', 'penandaAnomali'], payroll: ['rekanan', 'internal'] },
  mo: { workforce: ['karyawan', 'kontrak', 'statusMember'], recruitment: ['lowongan', 'lamaran'], attendance: ['absensi', 'penandaAnomali'], payroll: ['rekanan'] },
  hrd: { workforce: ['karyawan', 'kontrak', 'statusMember'], recruitment: ['lowongan', 'lamaran'], attendance: ['absensi', 'penandaAnomali'], payroll: [] },
  mkt: { workforce: ['karyawan', 'statusMember'], recruitment: ['lowongan', 'lamaran'], attendance: [], payroll: [] },
  keu: { workforce: ['kontrak'], recruitment: [], attendance: ['absensi', 'penandaAnomali'], payroll: ['rekanan', 'internal'] },
};

// Semua data SINTETIS.
jalan('Laporan konsolidasi: izin per bagian, akurasi, isolasi, ekspor CSV (PostgreSQL asli)', () => {
  let app: INestApplication;
  let pool: Pool;
  let nomorIp = 1;
  let A: string;
  let B: string;
  let C: string;
  let NAMA_A: string;
  let NAMA_B: string;
  let u1: string;
  let u2: string;
  let u3: string;
  let sessions: import('../src/auth/session.service').SessionService;
  let svc: import('../src/reports/reports.service').ReportsService;
  const s: Record<string, Sesi> = {};
  let lokA: { partner: string; lokasi: string; rekanan: string; nama: string };

  beforeAll(async () => {
    execFileSync('node', ['scripts/migrate.js', 'up'], { env: { ...process.env, DATABASE_URL: DB_URL } });
    const { AppModule } = await import('../src/app.module');
    const { konfigurasiApp } = await import('../src/app.factory');
    const { SessionService } = await import('../src/auth/session.service');
    const { ReportsService } = await import('../src/reports/reports.service');
    process.env.DATABASE_URL = await urlAplikasiTanpaBypass(DB_URL!);
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    konfigurasiApp(app);
    await app.init();
    sessions = app.get(SessionService);
    svc = app.get(ReportsService);
    pool = new Pool({ connectionString: DB_URL, max: 6 });
    NAMA_A = `PT SINTETIS A ${randomBytes(3).toString('hex')}`;
    NAMA_B = `PT SINTETIS B ${randomBytes(3).toString('hex')}`;
    A = (await pool.query(`INSERT INTO companies (name) VALUES ($1) RETURNING id`, [NAMA_A])).rows[0].id;
    B = (await pool.query(`INSERT INTO companies (name) VALUES ($1) RETURNING id`, [NAMA_B])).rows[0].id;
    C = (await pool.query(`INSERT INTO companies (name) VALUES ($1) RETURNING id`, [`=HYPERLINK("http://jahat.invalid","klik")${randomBytes(2).toString('hex')}`])).rows[0].id;
    for (const k of Object.keys(ROLE)) s[k] = await buatStaff([ROLE[k]], [A]);
    s.dirB = await buatStaff(['DIREKTUR'], [B]);
    s.moB = await buatStaff(['MANAGER_OPERASIONAL'], [B]);
    s.dirC = await buatStaff(['DIREKTUR'], [C]);
    [u1, u2, u3] = [s.mo.userId, s.keu.userId, s.dir.userId];
    lokA = await lokasiBaru(A);
    await isiDataA();
  });
  afterAll(async () => {
    await pool?.end();
    await app?.close();
  });

  const ipBaru = () => `10.97.${Math.floor(nomorIp / 250)}.${(nomorIp++ % 250) + 1}`;
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
  const lap = async (x: Sesi, nama: string, q = MARET) => (await http(`/reports/${nama}?${q}`, x).expect(200)).body as Laporan;
  const nilai = (l: Laporan, bagian: string, company: string, ukuran: string, lokasi: string | null = null) => l.sections[bagian]?.find((b) => b.companyName === company && b.measure === ukuran && b.location === lokasi)?.value;

  const lokasiBaru = (company: string) =>
    tenant([company], async (c) => {
      const nama = `Rek ${randomBytes(3).toString('hex')}`;
      const p = (await c.query(`INSERT INTO partners (company_id, name, created_by) VALUES ($1, $2, $3) RETURNING id`, [company, nama, u1 ?? s.mo?.userId])).rows[0].id;
      const l = (await c.query(`INSERT INTO partner_locations (company_id, partner_id, name, latitude, longitude, created_by) VALUES ($1, $2, 'Lokasi Lap', -6.9, 107.6, $3) RETURNING id`, [company, p, u1])).rows[0].id;
      return { partner: p as string, lokasi: l as string, rekanan: nama, nama: 'Lokasi Lap' };
    });
  /** Rantai kontrak AKTIF + penempatan (status penempatan dapat diatur). */
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

  /** Data terkontrol perusahaan A: 3 kontrak/penempatan, rekrutmen, absensi bulan Maret, payroll. */
  async function isiDataA() {
    await kontrakAktif(A, lokA.lokasi, '2026-04-15'); // berakhir 15 hari setelah 31 Maret
    await kontrakAktif(A, lokA.lokasi, '2026-12-31');
    const p3 = await kontrakAktif(A, lokA.lokasi, '2026-12-31', 'DITANGGUHKAN');
    await tenant([A], async (c) => {
      const buka = (await c.query(`INSERT INTO job_vacancies (company_id, title, description, status, created_by) VALUES ($1, 'Dibuka', 'D', 'DIBUKA', $2) RETURNING id`, [A, u1])).rows[0].id;
      for (const st of ['DIAJUKAN', 'DIAJUKAN', 'INTERVIEW', 'DITOLAK']) {
        const o = (await pool.query(`INSERT INTO persons (display_name) VALUES ('SINTETIS Pelamar') RETURNING id`)).rows[0].id;
        await c.query(`INSERT INTO job_applications (company_id, vacancy_id, person_id, status) VALUES ($1, $2, $3, $4)`, [A, buka, o, st]);
      }
    });
    const t = await tenant([A], async (c) => (await c.query(`INSERT INTO attendance_points (company_id, location_id, created_by) VALUES ($1, $2, $3) RETURNING id`, [A, lokA.lokasi, u1])).rows[0].id as string);
    const pl = (await tenant([A], (c) => c.query(`SELECT id FROM placements WHERE person_id = $1`, [p3.person]))).rows[0].id as string;
    const orang = async () => (await pool.query(`INSERT INTO persons (display_name) VALUES ('SINTETIS Orang') RETURNING id`)).rows[0].id as string;
    const rek = (person: string, kind: string, status: string, tanggal: string, flags: string[] = []) =>
      tenant([A], async (c) => {
        const id = (await c.query(`INSERT INTO attendance_records (company_id, person_id, placement_id, point_id, location_id, kind, status, reject_reason, shift_date, occurred_at, idempotency_key) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`, [A, person, pl, t, lokA.lokasi, kind, status, status === 'DITOLAK' ? 'LUAR_RADIUS' : null, tanggal, wib(`${tanggal} 08:00`), `lap-${randomBytes(6).toString('hex')}`])).rows[0].id as string;
        for (const f of flags) await c.query(`INSERT INTO attendance_flags (company_id, record_id, code, score) VALUES ($1, $2, $3, 0)`, [A, id, f]);
        return id;
      });
    const [q1, q2, q3, q4] = [await orang(), await orang(), await orang(), await orang()];
    await rek(q1, 'MASUK', 'VALID', '2026-03-10', ['TERLAMBAT']);
    await rek(q1, 'PULANG', 'VALID', '2026-03-10');
    const pend = await rek(q2, 'MASUK', 'PERLU_VERIFIKASI', '2026-03-10', ['AKURASI_BURUK']);
    await rek(q3, 'MASUK', 'DITOLAK', '2026-03-10');
    await rek(q4, 'MASUK', 'VALID', '2026-04-05'); // di luar rentang Maret
    await tenant([A], async (c) => {
      await c.query(`INSERT INTO attendance_reviews (company_id, record_id, stage, decision, actor_id, reason) VALUES ($1, $2, 'PERIKSA', 'DIPERIKSA', $3, 'periksa')`, [A, pend, u2]);
      await c.query(`INSERT INTO attendance_reviews (company_id, record_id, stage, decision, actor_id, reason) VALUES ($1, $2, 'PUTUSAN', 'DISETUJUI', $3, 'setuju')`, [A, pend, u1]);
      const per = async (kind: string, mulai: string, akhir: string) => (await c.query(`INSERT INTO payroll_periods (company_id, kind, label, start_date, end_date, created_by) VALUES ($1, $2, 'P', $3, $4, $5) RETURNING id`, [A, kind, mulai, akhir, u1])).rows[0].id as string;
      const rk = async (p: string, disetujui: boolean) => {
        const id = (await c.query(`INSERT INTO payroll_recaps (company_id, period_id, version_no, created_by) VALUES ($1, $2, 1, $3) RETURNING id`, [A, p, u1])).rows[0].id as string;
        for (const [nm, kind, amt] of [['Makan', 'TUNJANGAN', '100.50'], ['Transport', 'TUNJANGAN', '0.20'], ['Seragam', 'POTONGAN', '5']] as const) {
          for (const o of [await orang(), await orang()]) {
            const l = (await c.query(`INSERT INTO payroll_recap_lines (company_id, recap_id, person_id, worker_name, source) VALUES ($1, $2, $3, 'X', 'MANUAL') ON CONFLICT (recap_id, person_id) DO UPDATE SET worker_name = 'X' RETURNING id`, [A, id, o])).rows[0].id;
            await c.query(`INSERT INTO payroll_components (company_id, line_id, kind, name, amount) VALUES ($1, $2, $3, $4, $5)`, [A, l, kind, nm, amt]);
          }
        }
        if (disetujui) {
          await c.query(`UPDATE payroll_recaps SET status = 'DIVERIFIKASI', reviewed_by = $2, reviewed_at = now() WHERE id = $1`, [id, u2]);
          await c.query(`UPDATE payroll_recaps SET status = 'DISETUJUI', approved_by = $2, approved_at = now(), snapshot_hash = $3 WHERE id = $1`, [id, u3, 'b'.repeat(64)]);
        }
      };
      await rk(await per('PARTNER', '2026-03-01', '2026-03-31'), true);
      await rk(await per('PARTNER', '2026-04-01', '2026-04-30'), false); // draf: di luar rentang Maret dan belum disetujui
      await rk(await per('INTERNAL', '2026-03-01', '2026-03-31'), false);
    });
  }

  describe('izin per bagian', () => {
    it.each(Object.keys(HARAPAN))('%s: tepat bagian yang diizinkan pada setiap laporan', async (k) => {
      for (const [nama, bagian] of Object.entries(HARAPAN[k])) {
        const l = await lap(s[k], nama, TAHUN);
        expect(Object.keys(l.sections).sort()).toEqual([...bagian].sort());
      }
    });
    it('peran tanpa report_consolidated.view 403 (IT, Adm, PayAbs, PayInt); tanpa sesi 401; member 403', async () => {
      for (const k of ['it', 'adm', 'payabs', 'payint']) for (const nama of ['workforce', 'payroll']) await http(`/reports/${nama}?${MARET}`, s[k]).expect(403);
      await http(`/reports/workforce?${MARET}`).expect(401);
      const pm = (await pool.query(`INSERT INTO persons (display_name) VALUES ('SINTETIS Member') RETURNING id`)).rows[0].id;
      const um = (await pool.query(`INSERT INTO users (person_id, realm, email, status) VALUES ($1, 'member', $2, 'AKTIF') RETURNING id`, [pm, `m-${randomBytes(3).toString('hex')}@contoh.invalid`])).rows[0].id;
      const sm = await sessions.buat({ userId: um, realm: 'member', state: 'PENUH' });
      await http(`/reports/workforce?${MARET}`, { cookie: `__Host-sid=${sm.token}`, csrf: sm.csrfToken, userId: um }).expect(403);
    });
    it('ekspor hanya Direktur dan Keuangan (report_consolidated.export); lainnya 403', async () => {
      for (const k of ['mo', 'hrd', 'mkt', 'it', 'adm', 'payabs', 'payint']) await http(`/reports/workforce/export.csv?${MARET}`, s[k]).expect(403);
      for (const k of ['dir', 'keu']) await http(`/reports/attendance/export.csv?${MARET}`, s[k]).expect(200);
    });
  });

  describe('akurasi (perusahaan A, data terkontrol)', () => {
    it('ketenagakerjaan: karyawan per perusahaan/lokasi, kontrak per status dan dalam rentang', async () => {
      const l = await lap(s.dir, 'workforce');
      expect(nilai(l, 'karyawan', NAMA_A, 'Karyawan aktif')).toBe(2);
      expect(nilai(l, 'karyawan', NAMA_A, 'Karyawan ditangguhkan')).toBe(1);
      expect(nilai(l, 'karyawan', NAMA_A, 'Kontrak berakhir dalam 30 hari sejak tanggal akhir')).toBe(1);
      expect(nilai(l, 'karyawan', NAMA_A, 'Karyawan per lokasi', `${lokA.rekanan} — ${lokA.nama}`)).toBe(3);
      expect(nilai(l, 'kontrak', NAMA_A, 'Kontrak status AKTIF')).toBe(3);
      expect(nilai(l, 'kontrak', NAMA_A, 'Kontrak dimulai dalam rentang')).toBe(0); // mulai 1 Jan, di luar Maret
      expect(nilai(l, 'kontrak', NAMA_A, 'Kontrak berakhir dalam rentang')).toBe(0);
      const sampaiApril = await lap(s.dir, 'workforce', 'from=2026-04-01&to=2026-04-30');
      expect(nilai(sampaiApril, 'kontrak', NAMA_A, 'Kontrak berakhir dalam rentang')).toBe(1); // yang berakhir 15 April
      expect(nilai(await lap(s.dir, 'workforce', TAHUN), 'kontrak', NAMA_A, 'Kontrak dimulai dalam rentang')).toBe(3);
      expect(l.sections.statusMember.every((b) => b.companyId === null && b.companyName === 'Seluruh Group')).toBe(true);
    });
    it('rekrutmen: lowongan per status dan lamaran dibuat dalam rentang', async () => {
      const l = await lap(s.hrd, 'recruitment', TAHUN);
      expect(nilai(l, 'lowongan', NAMA_A, 'Lowongan status DIBUKA')).toBe(1);
      expect(nilai(l, 'lowongan', NAMA_A, 'Lowongan status DRAFT')).toBe(3);
      expect(nilai(l, 'lamaran', NAMA_A, 'Lamaran dibuat dalam rentang, status DIAJUKAN')).toBe(2);
      expect(nilai(l, 'lamaran', NAMA_A, 'Lamaran dibuat dalam rentang, status INTERVIEW')).toBe(1);
      expect(nilai(l, 'lamaran', NAMA_A, 'Lamaran dibuat dalam rentang, status DITOLAK')).toBe(1);
      expect(nilai(l, 'lamaran', NAMA_A, 'Lamaran dibuat dalam rentang, status DITERIMA')).toBe(3);
      const kosong = await lap(s.hrd, 'recruitment', 'from=2020-01-01&to=2020-12-31');
      expect(kosong.sections.lamaran).toEqual([]);
    });
    it('absensi: rekaman per status, hari hadir dari rekaman EFEKTIF (putusan tinjauan), terlambat, penanda anomali; di luar rentang tidak dihitung', async () => {
      const l = await lap(s.mo, 'attendance');
      const lok = `${lokA.rekanan} — ${lokA.nama}`;
      expect(nilai(l, 'absensi', NAMA_A, 'Rekaman valid', lok)).toBe(2);
      expect(nilai(l, 'absensi', NAMA_A, 'Rekaman perlu verifikasi', lok)).toBe(1);
      expect(nilai(l, 'absensi', NAMA_A, 'Rekaman ditolak', lok)).toBe(1);
      expect(nilai(l, 'absensi', NAMA_A, 'Hari hadir (orang-hari, rekaman efektif)', lok)).toBe(2); // q1 valid + q2 disetujui lewat tinjauan
      expect(nilai(l, 'absensi', NAMA_A, 'Masuk terlambat', lok)).toBe(1);
      expect(nilai(l, 'penandaAnomali', NAMA_A, 'Penanda AKURASI_BURUK')).toBe(1);
      expect(l.sections.penandaAnomali.some((b) => b.measure.includes('TERLAMBAT'))).toBe(false);
      const april = await lap(s.mo, 'attendance', 'from=2026-04-01&to=2026-04-30');
      expect(nilai(april, 'absensi', NAMA_A, 'Rekaman valid', lok)).toBe(1);
    });
    it('payroll: hanya subtotal rekap DISETUJUI/DIFINALISASI (nominal eksak, bukan gaji); jenis sesuai izin', async () => {
      const dir = await lap(s.dir, 'payroll');
      expect(nilai(dir, 'rekanan', NAMA_A, 'Rekanan: subtotal tunjangan (rekap disetujui, bukan gaji)')).toBe('201.40'); // 2 x 100.50 + 2 x 0.20 (penjumlahan numerik eksak)
      expect(nilai(dir, 'rekanan', NAMA_A, 'Rekanan: subtotal potongan (rekap disetujui, bukan gaji)')).toBe('10.00');
      expect(nilai(dir, 'rekanan', NAMA_A, 'Rekanan: periode dengan rekap status DISETUJUI')).toBe(1);
      expect(nilai(dir, 'rekanan', NAMA_A, 'Rekanan: baris pada rekap disetujui')).toBe(6);
      expect(dir.sections.rekanan.some((b) => b.measure.includes('status DRAFT'))).toBe(false); // April di luar rentang Maret
      expect(nilai(dir, 'internal', NAMA_A, 'Internal: periode dengan rekap status DRAFT')).toBe(1);
      expect(dir.sections.internal.some((b) => b.measure.includes('subtotal'))).toBe(false); // internal belum disetujui: tanpa nominal
      const april = await lap(s.dir, 'payroll', 'from=2026-04-01&to=2026-04-30');
      expect(nilai(april, 'rekanan', NAMA_A, 'Rekanan: periode dengan rekap status DRAFT')).toBe(1);
      expect(april.sections.rekanan.some((b) => b.measure.includes('subtotal'))).toBe(false);
      expect(Object.keys((await lap(s.mo, 'payroll')).sections)).toEqual(['rekanan']);
      expect(nilai(await lap(s.keu, 'payroll'), 'rekanan', NAMA_A, 'Rekanan: subtotal potongan (rekap disetujui, bukan gaji)')).toBe('10.00');
    });
  });

  describe('pembatas konkurensi kueri berat (Fase 11C)', () => {
    const tahan = () => {
      let lepas!: () => void;
      const p = new Promise<void>((r) => { lepas = r; });
      return { p, lepas };
    };
    afterEach(() => batasLaporanBerat.atur(2, 20, 10_000));

    it('slot penuh dan antrean penuh => 503 SISTEM_SIBUK dengan Retry-After pada laporan dan rekap; rute lain tidak terpengaruh; pulih setelah slot dilepas', async () => {
      batasLaporanBerat.atur(1, 0, 3000);
      const t = tahan();
      const penuh = batasLaporanBerat.jalankan(() => t.p);
      for (const path of [`/reports/workforce?${MARET}`, `/reports/workforce/export.csv?${MARET}`, '/attendance/recap?from=2026-03-01&to=2026-03-02']) {
        const r = await http(path, s.dir).expect(503);
        expect(r.body).toMatchObject({ kode: 'SISTEM_SIBUK' });
        expect(r.body.pesan).toMatch(/sibuk/i);
        expect(Number(r.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      }
      await http('/dashboard/staff', s.dir).expect(200); // rute non-berat tetap jalan saat slot berat penuh
      await http(`/reports/workforce?${MARET}`, s.it).expect(403); // otorisasi tetap lebih dulu daripada antrean
      t.lepas();
      await penuh;
      await http(`/reports/workforce?${MARET}`, s.dir).expect(200);
      expect(batasLaporanBerat.status).toEqual({ berjalan: 0, antre: 0 });
    });

    it('permintaan di dalam antrean menunggu lalu berhasil setelah slot dilepas', async () => {
      batasLaporanBerat.atur(1, 5, 5000);
      const t = tahan();
      const penuh = batasLaporanBerat.jalankan(() => t.p);
      const menunggu = http(`/reports/workforce?${MARET}`, s.dir).then((r) => r.status);
      await new Promise((r) => setTimeout(r, 150));
      expect(batasLaporanBerat.status.antre).toBe(1);
      t.lepas();
      await penuh;
      expect(await menunggu).toBe(200);
    });
  });

  describe('validasi, privasi, dan isolasi', () => {
    it('validasi parameter: laporan tak dikenal, rentang > 366 hari, urutan tanggal, tanggal tidak valid, parameter hilang', async () => {
      await http(`/reports/tidak-ada?${MARET}`, s.dir).expect(400);
      expect(JSON.stringify((await http('/reports/workforce?from=2025-01-01&to=2026-12-31', s.dir).expect(400)).body)).toMatch(/maksimal 366 hari/);
      expect(JSON.stringify((await http('/reports/workforce?from=2026-03-31&to=2026-03-01', s.dir).expect(400)).body)).toMatch(/tidak boleh sebelum/);
      await http('/reports/workforce?from=2026-02-30&to=2026-03-01', s.dir).expect(400);
      await http('/reports/workforce?from=2026-03-01', s.dir).expect(400);
      await http('/reports/workforce?from=2026-01-01&to=2026-12-31', s.dir).expect(200); // tepat 365 hari selisih = 366 hari
    });
    it('respons tanpa nama pekerja, NIK, atau email', async () => {
      for (const nama of ['workforce', 'recruitment', 'attendance', 'payroll']) expect(JSON.stringify(await lap(s.dir, nama, TAHUN))).not.toMatch(/SINTETIS (Pekerja|Pelamar|Orang|Member)|@contoh|nik/i);
    });
    it('ISOLASI: staf B hanya melihat perusahaan B; A tidak bocor; RLS dimatikan => bocor (tes gagal bila RLS mati)', async () => {
      const lokB = await lokasiBaru(B);
      await kontrakAktif(B, lokB.lokasi, '2026-12-31');
      for (const nama of ['workforce', 'attendance', 'payroll', 'recruitment']) {
        const l = await lap(s.dirB, nama, TAHUN);
        const nm = new Set(Object.values(l.sections).flat().map((b) => b.companyName).filter((n) => n !== 'Seluruh Group'));
        expect(nm.has(NAMA_A)).toBe(false);
      }
      expect(nilai(await lap(s.dirB, 'workforce', TAHUN), 'karyawan', NAMA_B, 'Karyawan aktif')).toBe(1);
      expect(nilai(await lap(s.dir, 'workforce', TAHUN), 'karyawan', NAMA_B, 'Karyawan aktif')).toBeUndefined();
      const tabel = ['placements', 'employment_contracts'];
      for (const t of tabel) await pool.query(`ALTER TABLE ${t} DISABLE ROW LEVEL SECURITY`);
      try {
        const bocor = await lap(s.dirB, 'workforce', TAHUN);
        expect(bocor.sections.karyawan.some((b) => b.companyId === A)).toBe(true); // tanpa RLS data A bocor ke staf B
      } finally {
        for (const t of tabel) await pool.query(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
      }
    });
  });

  describe('ekspor CSV', () => {
    const unduh = (x: Sesi, nama: string, q = MARET) => http(`/reports/${nama}/export.csv?${q}`, x).buffer(true).parse((res, cb) => { const d: Buffer[] = []; res.on('data', (c: Buffer) => d.push(c)); res.on('end', () => { const b = Buffer.concat(d); cb(null, /json/.test(String(res.headers['content-type'])) ? JSON.parse(b.toString('utf8')) : b); }); });
    it('isi CSV: BOM, kolom, baris sesuai bagian; header tanpa-cache; diaudit per perusahaan tanpa nominal', async () => {
      const r = await unduh(s.keu, 'payroll').expect(200);
      expect(r.headers['content-type']).toMatch(/text\/csv/);
      expect(r.headers['content-disposition']).toBe('attachment; filename="laporan-payroll-2026-03-01_2026-03-31.csv"');
      expect(r.headers['cache-control']).toMatch(/no-store/);
      const csv = (r.body as Buffer).toString('utf8');
      expect(csv.charCodeAt(0)).toBe(0xfeff);
      const baris = csv.slice(1).trimEnd().split('\r\n');
      expect(baris[0]).toBe('Bagian,Perusahaan,Lokasi,Ukuran,Nilai');
      expect(csv).toContain(`rekanan,${NAMA_A},,"Rekanan: subtotal potongan (rekap disetujui, bukan gaji)",10.00`); // ukuran berkoma dikutip
      expect(baris.length).toBeGreaterThan(3);
      const aud = await tenant([A], (c) => c.query(`SELECT detail, actor_id FROM audit_logs WHERE action = 'report.exported' AND object_id = 'payroll' AND company_id = $1 AND actor_id = $2`, [A, s.keu.userId]));
      expect(aud.rowCount).toBe(1);
      expect(aud.rows[0].detail).toMatchObject({ jenis: 'payroll', mulai: '2026-03-01', sampai: '2026-03-31', format: 'csv' });
      expect(JSON.stringify(aud.rows)).not.toMatch(/201\.40|10\.00|SINTETIS/);
    });
    it('anti formula injection: nama perusahaan berbahaya dinetralkan', async () => {
      const lokC = await lokasiBaru(C);
      await kontrakAktif(C, lokC.lokasi, '2026-12-31');
      const csv = ((await unduh(s.dirC, 'workforce', TAHUN).expect(200)).body as Buffer).toString('utf8');
      expect(csv).toContain(`'=HYPERLINK(""http://jahat.invalid"",""klik"")`);
      for (const b of csv.slice(1).trimEnd().split('\r\n').slice(1)) expect(b.split(',')[1].replace(/^"/, '')).not.toMatch(/^[=+\-@]/);
    });
    it('batas baris: laporan terlalu besar ditolak 422; ekspor tanpa data tetap valid (hanya kepala)', async () => {
      svc.batasBaris = 2;
      try {
        expect((await unduh(s.dir, 'workforce', TAHUN).expect(422)).body.kode).toBe('LAPORAN_TERLALU_BESAR');
        await http(`/reports/workforce?${TAHUN}`, s.dir).expect(422);
      } finally {
        svc.batasBaris = 5000;
      }
      const kosong = ((await unduh(s.dir, 'recruitment', 'from=2020-01-01&to=2020-12-31').expect(200)).body as Buffer).toString('utf8');
      expect(kosong.slice(1).trimEnd().split('\r\n')[0]).toBe('Bagian,Perusahaan,Lokasi,Ukuran,Nilai');
    });
  });
});
