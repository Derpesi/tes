import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { blindIndexNik, enkripsiNik } from '../src/common/crypto/pii';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { urlAplikasiTanpaBypass } from './helpers/role-app';

const DB_URL = process.env.TEST_DATABASE_URL;
const jalan = DB_URL ? describe : describe.skip;

const ORIGIN = 'https://hris.contoh.invalid';
process.env.APP_BASE_URL = ORIGIN;
process.env.AUTH_HMAC_KEY = randomBytes(32).toString('base64');
process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString('base64');
process.env.TRUST_PROXY = '1';
const STORAGE = mkdtempSync(join(tmpdir(), 'hris-member-'));
process.env.STORAGE_DIR = STORAGE;

interface Sesi { cookie: string; csrf: string; userId: string; personId: string }

// Semua NIK/nama di bawah ini SINTETIS (bukan data pekerja nyata).

jalan('dashboard member/karyawan dan notifikasi kontrak akan berakhir (PostgreSQL asli)', () => {
  let app: INestApplication;
  let pool: Pool;
  let nomorIp = 1;
  const terkirim: { to: string; subject: string; text: string }[] = [];
  let perusahaanA: string;
  let perusahaanB: string;
  let sessions: import('../src/auth/session.service').SessionService;
  let outbox: import('../src/notifications/outbox.worker').OutboxWorker;

  beforeAll(async () => {
    execFileSync('node', ['scripts/migrate.js', 'up'], { env: { ...process.env, DATABASE_URL: DB_URL } });
    const { AppModule } = await import('../src/app.module');
    const { konfigurasiApp } = await import('../src/app.factory');
    const { SessionService } = await import('../src/auth/session.service');
    process.env.DATABASE_URL = await urlAplikasiTanpaBypass(DB_URL!);
    const { EMAIL_CHANNEL } = await import('../src/notifications/email.channel');
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EMAIL_CHANNEL)
      .useValue({ tersedia: () => true, kirim: async (p: { to: string; subject: string; text: string }) => void terkirim.push(p) })
      .compile();
    app = mod.createNestApplication();
    konfigurasiApp(app);
    await app.init();
    sessions = app.get(SessionService);
    const { OutboxWorker } = await import('../src/notifications/outbox.worker');
    outbox = app.get(OutboxWorker);
    pool = new Pool({ connectionString: DB_URL, max: 4 });
    await pool.query(`UPDATE notification_outbox SET status = 'GAGAL', payload_enc = NULL WHERE status = 'MENUNGGU'`); // sisa run sebelumnya
    perusahaanA = (await pool.query(`INSERT INTO companies (name) VALUES ($1) RETURNING id`, [`PT SINTETIS A ${randomBytes(3).toString('hex')}`])).rows[0].id;
    perusahaanB = (await pool.query(`INSERT INTO companies (name) VALUES ($1) RETURNING id`, [`PT SINTETIS B ${randomBytes(3).toString('hex')}`])).rows[0].id;
  });
  afterAll(async () => {
    await pool?.end();
    await app?.close();
    fs.rmSync(STORAGE, { recursive: true, force: true });
  });

  const ipBaru = () => `10.50.${Math.floor(nomorIp / 250)}.${(nomorIp++ % 250) + 1}`;
  const http = (metode: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string, s?: Pick<Sesi, 'cookie' | 'csrf'>, o: { origin?: string | null; tanpaCsrf?: boolean } = {}) => {
    let r = request(app.getHttpServer())[metode](path).set('X-Forwarded-For', ipBaru());
    if (o.origin !== null) r = r.set('Origin', o.origin ?? ORIGIN);
    if (s) r = r.set('Cookie', s.cookie);
    if (s && !o.tanpaCsrf) r = r.set('X-CSRF-Token', s.csrf);
    return r;
  };
  const buatStaff = async (role: string, companyIds: string[] = []): Promise<Sesi> => {
    const u = (await pool.query(`INSERT INTO users (realm, email, status) VALUES ('staff', $1, 'AKTIF') RETURNING id`, [`s-${randomBytes(4).toString('hex')}@contoh.invalid`])).rows[0].id as string;
    await pool.query(`INSERT INTO user_roles (user_id, role_code, grant_source) VALUES ($1, $2, 'MANUAL')`, [u, role]);
    for (const c of companyIds) await pool.query(`INSERT INTO user_company_scopes (user_id, scope_company_id) VALUES ($1, $2)`, [u, c]);
    const s = await sessions.buat({ userId: u, realm: 'staff', state: 'PENUH' });
    return { cookie: `__Host-sid=${s.token}`, csrf: s.csrfToken, userId: u, personId: '' };
  };






  // ---------- helper domain ----------
  const TPL = 'CONTOH UJI — BUKAN DOKUMEN HUKUM. Nama: {{nama}}; NIK: {{nik}}; Nomor: {{nomor}}; Jabatan: {{jabatan}}; Mulai: {{tanggal_mulai}}; Akhir: {{tanggal_akhir}}; Perusahaan: {{perusahaan}}';
  const PDF_SCAN = Buffer.from('%PDF-1.4\nSCAN-TTD-SINTETIS-RAHASIA-UJI\n%%EOF\n');
  const nikBaru = () => `98${String(Math.floor(Math.random() * 1e14)).padStart(14, '0')}`; // sintetis
  const kunciEnk = () => Buffer.from(process.env.APP_ENCRYPTION_KEY!, 'base64');
  const kunciHmac = () => Buffer.from(process.env.AUTH_HMAC_KEY!, 'base64');
  const tahunMulai = 2096 + Math.floor(Math.random() * 3); // nomor kontrak per tahun: hindari bentrok antar-run

  const tenant = async <T>(companyIds: string[], fn: (c: import('pg').PoolClient) => Promise<T>): Promise<T> => {
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

  /** Pelamar siap dikontrak: member BELUM_DITEMPATKAN (NIK terenkripsi sungguhan) + lamaran MENUNGGU_PKWT di perusahaan `company`. */
  const siapPelamar = async (company: string, nama = 'SINTETIS Pekerja Uji', statusMember = 'BELUM_DITEMPATKAN') => {
    const person = (await pool.query(`INSERT INTO persons (display_name) VALUES ($1) RETURNING id`, [nama])).rows[0].id as string;
    const pemeriksa = (await pool.query(`INSERT INTO users (realm, email, status) VALUES ('staff', $1, 'AKTIF') RETURNING id`, [`v-${randomBytes(4).toString('hex')}@contoh.invalid`])).rows[0].id as string;
    const nik = nikBaru();
    const pid = (await pool.query(`INSERT INTO member_profiles (person_id) VALUES ($1) RETURNING id`, [person])).rows[0].id as string;
    await pool.query(
      `UPDATE member_profiles SET status = $2, full_name = $3, nik_enc = $4, nik_hmac = $5, birth_place = 'K', birth_date = '1990-01-01', gender = 'L', address = 'A', city = 'Bandung', province = 'P', phone = '08123456', education = 'SMA/SMK', emergency_contact_name = 'E', emergency_contact_phone = '08123457', verified_by = $6, verified_at = now() WHERE id = $1`,
      [pid, statusMember, nama, enkripsiNik(nik, kunciEnk(), pid), blindIndexNik(kunciHmac(), nik), pemeriksa],
    );
    const lamaran = await tenant([company], async (c) => {
      const v = (await c.query(`INSERT INTO job_vacancies (company_id, title, description, created_by) VALUES ($1, 'L', 'D', $2) RETURNING id`, [company, pemeriksa])).rows[0].id;
      return (await c.query(`INSERT INTO job_applications (company_id, vacancy_id, person_id, status) VALUES ($1, $2, $3, 'MENUNGGU_PKWT') RETURNING id`, [company, v, person])).rows[0].id as string;
    });
    return { person, nik, nama, lamaran, pid };
  };

  interface Pemeran { adm: Sesi; hrdU: Sesi; hrdR: Sesi; dir: Sesi }
  const pemeranA = async (): Promise<Pemeran> => ({
    adm: await buatStaff('STAFF_ADMINISTRASI', [perusahaanA]),
    hrdU: await buatStaff('HRD', [perusahaanA]),
    hrdR: await buatStaff('HRD', [perusahaanA]),
    dir: await buatStaff('DIREKTUR', [perusahaanA]),
  });
  /** Template terverifikasi (dibuat HRD, diverifikasi Direktur). */
  const templateOk = async (p: Pemeran, body = TPL) => {
    const t = (await http('post', '/pkwt/templates', p.hrdU).send({ name: `Tpl ${randomBytes(3).toString('hex')}`, body }).expect(201)).body;
    await http('post', `/pkwt/templates/${t.id}/verify`, p.dir).send({ note: 'Diverifikasi ahli hukum (uji)' }).expect(200);
    return t.id as string;
  };
  const buatKontrak = (s: Sesi, lamaran: string, templateId: string, o: object = {}) =>
    http('post', '/pkwt', s).send({ applicationId: lamaran, templateId, position: 'Satpam', startDate: `${tahunMulai}-01-01`, endDate: `${tahunMulai}-12-31`, ...o });
  const unggahScan = (s: Sesi, id: string, isi: Buffer = PDF_SCAN, nama = 'kontrak-ttd.pdf') => http('post', `/pkwt/${id}/documents`, s).attach('berkas', isi, nama);
  /** Mengantar kontrak sampai PENANDATANGANAN (draft -> review -> persetujuan -> penandatanganan). */
  const sampaiPenandatanganan = async (p: Pemeran, id: string) => {
    await http('post', `/pkwt/${id}/submit`, p.hrdU).expect(200);
    await http('post', `/pkwt/${id}/review`, p.hrdR).expect(200);
    await http('post', `/pkwt/${id}/approve`, p.dir).expect(200);
  };
  /** Mengantar sampai DITANDATANGANI (scan diunggah hrdU, diverifikasi hrdR). */
  const sampaiDitandatangani = async (p: Pemeran, id: string) => {
    await sampaiPenandatanganan(p, id);
    const d = (await unggahScan(p.hrdU, id).expect(201)).body;
    await http('post', `/pkwt/${id}/documents/${d.id}/verify`, p.hrdR).expect(200);
    return d.id as string;
  };
  const statusKontrak = async (p: Pemeran, id: string) => (await http('get', `/pkwt/${id}`, p.hrdU).expect(200)).body.status as string;



  // ---------- helper domain 6C ----------
  const Y = tahunMulai;
  const MULAI = `${Y}-03-01`;
  const AKHIR = `${Y}-08-31`;
  /** Instan tengah hari WIB pada tanggal tertentu (jam yang disuntikkan ke siklus). */
  const pada = (tanggal: string) => new Date(`${tanggal}T05:00:00Z`);
  const hari = (tanggal: string, selisih: number) => new Date(Date.parse(`${tanggal}T00:00:00Z`) + selisih * 86400000).toISOString().slice(0, 10);

  const lokasiBaru = async (company: string, createdBy: string, nama = 'Gedung Uji') =>
    tenant([company], async (c) => {
      const p = (await c.query(`INSERT INTO partners (company_id, name, created_by) VALUES ($1, $2, $3) RETURNING id`, [company, `Rek ${randomBytes(3).toString('hex')}`, createdBy])).rows[0].id;
      return (await c.query(`INSERT INTO partner_locations (company_id, partner_id, name, created_by) VALUES ($1, $2, $3, $4) RETURNING id`, [company, p, nama, createdBy])).rows[0].id as string;
    });
  const memberSesi = async (person: string): Promise<Sesi> => {
    const u = (await pool.query(`INSERT INTO users (person_id, realm, email, status) VALUES ($1, 'member', $2, 'AKTIF') RETURNING id`, [person, `m-${randomBytes(4).toString('hex')}@contoh.invalid`])).rows[0].id as string;
    const s = await sessions.buat({ userId: u, realm: 'member', state: 'PENUH' });
    return { cookie: `__Host-sid=${s.token}`, csrf: s.csrfToken, userId: u, personId: person };
  };
  const statusMemberDb = async (person: string) => (await pool.query(`SELECT status FROM member_profiles WHERE person_id = $1`, [person])).rows[0].status as string;
  const siklus = async () => (await import('../src/pkwt/lifecycle.service')).ContractLifecycleService;
  const jalankanSiklus = async (tanggal: string) => app.get(await siklus()).prosesOrang(currentPerson, pada(tanggal));
  const hariNyata = (selisih = 0) => new Date(Date.now() + selisih * 86400000 + 7 * 3600000).toISOString().slice(0, 10); // tanggal WIB hari ini +/- selisih

  interface Aktor extends Pemeran { ops: Sesi; hrdP: Sesi }
  const aktor = async (): Promise<Aktor> => ({
    ...(await pemeranA()),
    ops: await buatStaff('MANAGER_OPERASIONAL', [perusahaanA]),
    hrdP: await buatStaff('HRD', [perusahaanA]),
  });
  let currentPerson = '';
  /** Pelamar -> kontrak DITANDATANGANI (periode MULAI..AKHIR) + lokasi, belum ada penempatan. */
  const kontrakSiap = async (t: Aktor, o: { start?: string; end?: string; extendsId?: string; lamaran?: string; person?: string; statusMember?: string } = {}) => {
    const pel = o.lamaran ? { lamaran: o.lamaran, person: o.person!, pid: '', nik: '', nama: '' } : await siapPelamar(perusahaanA, 'SINTETIS Karyawan Uji', o.statusMember);
    currentPerson = pel.person;
    const tpl = await templateOk(t);
    const k = (await buatKontrak(t.adm, pel.lamaran, tpl, { startDate: o.start ?? MULAI, endDate: o.end ?? AKHIR, ...(o.extendsId ? { extendsContractId: o.extendsId } : {}) }).expect(201)).body;
    await sampaiDitandatangani(t, k.id);
    const lokasi = await lokasiBaru(perusahaanA, t.hrdU.userId);
    return { pel, kontrakId: k.id as string, lokasi, tpl };
  };
  const rencanakan = (s: Sesi, kontrakId: string, lokasi: string, o: object = {}) => http('post', '/placements', s).send({ contractId: kontrakId, locationId: lokasi, startDate: MULAI, endDate: AKHIR, ...o });
  const penempatanSiap = async (t: Aktor, k: { kontrakId: string; lokasi: string }, o: object = {}) => {
    const p = (await rencanakan(t.hrdP, k.kontrakId, k.lokasi, o).expect(201)).body;
    await http('post', `/placements/${p.id}/approve`, t.ops).expect(200);
    return p.id as string;
  };


  const nama = 'SINTETIS Karyawan Uji';
  const emailKe = async (email: string) => (await pool.query(`SELECT count(*)::int AS n FROM notification_outbox WHERE recipient = $1 AND template = 'kontrak_akan_berakhir'`, [email])).rows[0].n as number;
  const emailStaff = async (s: Sesi) => (await pool.query(`SELECT email FROM users WHERE id = $1`, [s.userId])).rows[0].email as string;

  it('prasyarat: aplikasi berjalan sebagai role non-superuser tanpa BYPASSRLS (RLS benar-benar berlaku)', async () => {
    const { POOL } = await import('../src/database/tokens');
    const r = await app.get<Pool>(POOL).query(`SELECT current_user AS u, (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass`);
    expect(r.rows[0]).toEqual({ u: 'hris_app_uji', bypass: false });
  });

  describe('dashboard member', () => {
    it('mengikuti status: menunggu kontrak -> kontrak ditandatangani + penempatan menunggu -> aktif (sisa hari) -> berakhir; tanpa data internal', async () => {
      const t = await aktor();
      const pel = await siapPelamar(perusahaanA, nama);
      currentPerson = pel.person;
      const m = await memberSesi(pel.person);
      let d = (await http('get', '/member/dashboard', m).expect(200)).body;
      expect(d.status).toBe('BELUM_DITEMPATKAN');
      expect(d.contract).toBeNull();
      expect(d.placement).toBeNull();
      expect(d.applicationsAwaitingContract).toBe(1);
      const tpl = await templateOk(t);
      const kon = (await buatKontrak(t.adm, pel.lamaran, tpl, { startDate: MULAI, endDate: AKHIR }).expect(201)).body;
      d = (await http('get', '/member/dashboard', m).expect(200)).body;
      expect(d.contract).toBeNull(); // draf internal tidak terlihat member
      await sampaiPenandatanganan(t, kon.id);
      expect((await http('get', '/member/dashboard', m).expect(200)).body.contract).toBeNull();
      const sc = (await unggahScan(t.hrdU, kon.id).expect(201)).body;
      await http('post', `/pkwt/${kon.id}/documents/${sc.id}/verify`, t.hrdR).expect(200);
      const lokasi = await lokasiBaru(perusahaanA, t.hrdU.userId, 'Gedung Karyawan');
      const pen = (await rencanakan(t.hrdP, kon.id, lokasi).expect(201)).body.id;
      await http('post', `/placements/${pen}/approve`, t.ops).expect(200);
      d = (await http('get', '/member/dashboard', m).expect(200)).body;
      expect(d.contract.status).toBe('DITANDATANGANI');
      expect(d.contract.daysLeft).toBeNull();
      expect(d.placement).toMatchObject({ status: 'MENUNGGU_KONTRAK', locationName: 'Gedung Karyawan' });
      await jalankanSiklus(MULAI);
      d = (await http('get', '/member/dashboard', m).expect(200)).body;
      expect(d.status).toBe('KARYAWAN_AKTIF');
      expect(d.contract).toMatchObject({ status: 'AKTIF', position: 'Satpam', startDate: MULAI, endDate: AKHIR });
      expect(d.contract.daysLeft).toBe(Math.round((Date.parse(`${AKHIR}T00:00:00Z`) - Date.parse(`${hariNyata()}T00:00:00Z`)) / 86400000));
      expect(d.placement.status).toBe('AKTIF');
      expect(JSON.stringify(d)).not.toMatch(/createdBy|reviewedBy|approvedBy|companyId|personId|"id"|nik|object_key/i);
      await jalankanSiklus(hari(AKHIR, 1));
      d = (await http('get', '/member/dashboard', m).expect(200)).body;
      expect(d.status).toBe('KONTRAK_BERAKHIR');
      expect(d.contract.status).toBe('BERAKHIR');
      expect(d.placement).toBeNull();
    });

    it('hanya data miliknya; staff dan tanpa sesi ditolak', async () => {
      const t = await aktor();
      const k = await kontrakSiap(t, { start: hari(hariNyata(), -2), end: hari(hariNyata(), 200) });
      const pemilik = await memberSesi(k.pel.person);
      const lain = await memberSesi((await siapPelamar(perusahaanA)).person);
      expect((await http('get', '/member/dashboard', lain).expect(200)).body.contract).toBeNull();
      expect((await http('get', '/member/dashboard', pemilik).expect(200)).body.contract).not.toBeNull();
      await http('get', '/member/dashboard', t.hrdU).expect(403);
      await http('get', '/member/dashboard').expect(401);
    });
  });

  describe('dashboard karyawan aktif (staff)', () => {
    it('hanya karyawan aktif/ditangguhkan dengan kontrak aktif dalam scope; tanpa PII sensitif; filter lokasi; keyset; ringkasan; isolasi', async () => {
      const t = await aktor();
      const hrdB = await buatStaff('HRD', [perusahaanB]);
      const k1 = await kontrakSiap(t);
      const pen1 = await penempatanSiap(t, k1);
      await jalankanSiklus(MULAI);
      const k2 = await kontrakSiap(t, { statusMember: 'BELUM_DITEMPATKAN' });
      await jalankanSiklus(MULAI); // kontrak k2 AKTIF
      const pen2 = await penempatanSiap(t, k2, { startDate: MULAI }); // jam nyata < tanggal mulai: penempatan tetap MENUNGGU_KONTRAK (kontrak aktif, penempatan belum)
      expect((await http('get', `/placements/${pen2}`, t.ops).expect(200)).body.status).toBe('MENUNGGU_KONTRAK');
      const k3 = await kontrakSiap(t);
      const pen3 = await penempatanSiap(t, k3);
      await jalankanSiklus(MULAI); // currentPerson = k3
      await http('post', `/placements/${pen3}/suspend`, t.hrdP).send({ reason: 'Cuti panjang' }).expect(200);
      const opsB = await buatStaff('MANAGER_OPERASIONAL', [perusahaanB]);
      void hrdB;
      const daftar = (await http('get', '/employees?limit=100', t.ops).expect(200)).body.items as { placementId: string; workerName: string; placementStatus: string; position: string; locationName: string; daysLeft: number }[];
      const ids = daftar.map((x) => x.placementId);
      expect(ids).toContain(pen1);
      expect(ids).toContain(pen3);
      expect(ids).not.toContain(pen2); // kontrak aktif tetapi penempatan belum aktif: belum terhitung karyawan
      expect(daftar.find((x) => x.placementId === pen1)).toMatchObject({ workerName: nama, placementStatus: 'AKTIF', position: 'Satpam', locationName: 'Gedung Uji' });
      expect(daftar.find((x) => x.placementId === pen3)!.placementStatus).toBe('DITANGGUHKAN');
      expect(daftar.every((x) => ['AKTIF', 'DITANGGUHKAN'].includes(x.placementStatus))).toBe(true); // yang MENUNGGU_KONTRAK tidak termasuk
      expect(JSON.stringify(daftar)).not.toMatch(/nik|phone|telepon|address|alamat|email|birth/i);
      expect(((await http('get', `/employees?locationId=${k1.lokasi}`, t.ops).expect(200)).body.items as { placementId: string }[]).map((x) => x.placementId)).toEqual([pen1]);
      expect(((await http('get', '/employees?limit=100', opsB).expect(200)).body.items as { placementId: string }[]).map((x) => x.placementId)).not.toContain(pen1); // isolasi
      const ringk = (await http('get', '/employees/summary', t.ops).expect(200)).body;
      expect(ringk.active).toBeGreaterThanOrEqual(1);
      expect(ringk.suspended).toBeGreaterThanOrEqual(1);
      expect((ringk.perLocation as { locationId: string; count: number }[]).find((x) => x.locationId === k1.lokasi)!.count).toBe(1);
      const ringkB = (await http('get', '/employees/summary', opsB).expect(200)).body;
      expect((ringkB.perLocation as { locationId: string }[]).map((x) => x.locationId)).not.toContain(k1.lokasi);
      // keyset
      const lihat = new Set<string>();
      let kursor: string | null = null;
      let n = 0;
      do {
        const r: request.Response = await http('get', `/employees?limit=1${kursor ? `&cursor=${kursor}` : ''}`, t.ops).expect(200);
        for (const x of r.body.items as { placementId: string }[]) {
          expect(lihat.has(x.placementId)).toBe(false);
          lihat.add(x.placementId);
        }
        kursor = r.body.nextCursor;
        n++;
      } while (kursor && n < 200);
      expect(lihat.has(pen1)).toBe(true);
      await http('get', '/employees?limit=101', t.ops).expect(400);
      await http('get', '/employees?akanBerakhir=mungkin', t.ops).expect(400);
      await http('get', '/employees?cursor=bukan-kursor', t.ops).expect(400);
    });

    // placement.view: Direktur, Mgr Ops, HRD, Marketing, Adm, PayAbs (docs/rbac.md "Penempatan & jadwal")
    const boleh: Record<string, boolean> = {
      DIREKTUR: true, MANAGER_OPERASIONAL: true, IT_ADMIN: false, HRD: true, MARKETING: true, STAFF_ADMINISTRASI: true, STAFF_PAYROLL_ABSENSI_REKANAN: true, STAFF_KEUANGAN: false, STAFF_PAYROLL_INTERNAL: false,
    };
    it.each(Object.entries(boleh))('izin %s', async (peranKode, ok) => {
      const s = await buatStaff(peranKode, [perusahaanA]);
      for (const path of ['/employees', '/employees/summary']) {
        const r = await http('get', path, s);
        if (ok) expect(r.status).toBe(200);
        else expect(r.status).toBe(403);
      }
    });
    it('mencakup semua peran; tanpa sesi 401; member tidak dapat memakai rute staff', async () => {
      expect(Object.keys(boleh)).toHaveLength(9);
      await http('get', '/employees').expect(401);
      await http('get', '/employees', await memberSesi((await siapPelamar(perusahaanA)).person)).expect(403);
    });
  });

  describe('kontrak akan berakhir: filter dan notifikasi', () => {
    it('filter akanBerakhir hanya kontrak <= 30 hari tanpa lanjutan; email HRD perusahaan (dan akses semua perusahaan) tepat SEKALI, bukan peran lain/perusahaan lain', async () => {
      const t = await aktor();
      const hrdScopeA = await buatStaff('HRD', [perusahaanA]);
      const hrdSemua = await buatStaff('HRD', []);
      await pool.query(`UPDATE users SET all_companies = true WHERE id = $1`, [hrdSemua.userId]);
      const hrdB = await buatStaff('HRD', [perusahaanB]);
      const [eA, eSemua, eB, eDir, eOps] = await Promise.all([emailStaff(hrdScopeA), emailStaff(hrdSemua), emailStaff(hrdB), emailStaff(t.dir), emailStaff(t.ops)]);
      // kontrak berjalan dengan tanggal nyata: mulai 5 hari lalu, berakhir 10 hari lagi
      const k = await kontrakSiap(t, { start: hariNyata(-5), end: hariNyata(10) });
      const kLama = await kontrakSiap(t, { start: hariNyata(-5), end: hariNyata(200) });
      const pen = await penempatanSiap(t, k, { startDate: hariNyata(-5), endDate: hariNyata(10) });
      const penLama = await penempatanSiap(t, kLama, { startDate: hariNyata(-5), endDate: hariNyata(200) });
      await app.get(await siklus()).prosesOrang(k.pel.person, new Date());
      await app.get(await siklus()).prosesOrang(kLama.pel.person, new Date());
      expect(await statusKontrak(t, k.kontrakId)).toBe('AKTIF');
      expect(await statusMemberDb(k.pel.person)).toBe('KONTRAK_AKAN_BERAKHIR');
      expect(await statusMemberDb(kLama.pel.person)).toBe('KARYAWAN_AKTIF');
      const idsAkan = ((await http('get', '/employees?akanBerakhir=true&limit=100', t.ops).expect(200)).body.items as { placementId: string; daysLeft: number }[]);
      expect(idsAkan.map((x) => x.placementId)).toContain(pen);
      expect(idsAkan.map((x) => x.placementId)).not.toContain(penLama);
      expect(idsAkan.find((x) => x.placementId === pen)!.daysLeft).toBe(10);
      expect((await http('get', '/employees/summary', t.ops).expect(200)).body.expiringWithin30Days).toBeGreaterThanOrEqual(1);
      // notifikasi: tepat satu per penerima yang berhak
      expect(await emailKe(eA)).toBe(1);
      expect(await emailKe(eSemua)).toBe(1);
      expect(await emailKe(eB)).toBe(0); // HRD perusahaan lain
      expect(await emailKe(eDir)).toBe(0); // bukan HRD
      expect(await emailKe(eOps)).toBe(0);
      // idempoten: siklus berulang (termasuk jalankan() global) tidak mengirim lagi
      await app.get(await siklus()).prosesOrang(k.pel.person, new Date());
      await app.get(await siklus()).jalankan(new Date());
      expect(await emailKe(eA)).toBe(1);
      expect(await emailKe(eSemua)).toBe(1);
      const kolom = await tenant([perusahaanA], async (c) => (await c.query(`SELECT expiry_notified_at FROM employment_contracts WHERE id = $1`, [k.kontrakId])).rows[0]);
      expect(kolom.expiry_notified_at).not.toBeNull();
      // payload outbox terenkripsi (tanpa nomor kontrak/nama terbaca)
      const raw = (await pool.query(`SELECT payload_enc FROM notification_outbox WHERE recipient = $1 AND template = 'kontrak_akan_berakhir'`, [eA])).rows[0].payload_enc as Buffer;
      expect(raw.includes(Buffer.from(nama))).toBe(false);
      // dikirim lewat kanal email palsu: isi Indonesia tanpa NIK
      terkirim.length = 0;
      for (let i = 0; i < 30 && (await outbox.prosesBatch(100)) > 0; i++);
      const pesan = terkirim.find((p) => p.to === eA)!;
      expect(pesan.subject).toMatch(/akan berakhir 10 hari lagi/);
      expect(pesan.text).toContain('Nomor kontrak');
      expect(pesan.text).toContain(nama);
      expect(pesan.text).toContain('10 hari lagi');
      expect(pesan.text).not.toContain(k.pel.nik);
      expect(terkirim.some((p) => p.to === eB || p.to === eDir)).toBe(false);
    });

    it('kontrak yang sudah memiliki lanjutan ditandatangani tidak memicu notifikasi dan tidak AKAN_BERAKHIR', async () => {
      const t = await aktor();
      const hrdScope = await buatStaff('HRD', [perusahaanA]);
      const eml = await emailStaff(hrdScope);
      const sebelum = await emailKe(eml);
      const mulai1 = hariNyata(1); // belum aktif saat ditandatangani
      const k1 = await kontrakSiap(t, { start: mulai1, end: hariNyata(10) });
      await penempatanSiap(t, k1, { startDate: mulai1, endDate: hariNyata(10) });
      const k2 = (await buatKontrak(t.adm, k1.pel.lamaran, k1.tpl, { extendsContractId: k1.kontrakId, startDate: hariNyata(11), endDate: hariNyata(100) }).expect(201)).body;
      await sampaiDitandatangani(t, k2.id);
      const r = await app.get(await siklus()).prosesOrang(k1.pel.person, pada(mulai1)); // k1 aktif pada hari mulai
      expect(r.kontrakAktif).toBe(1);
      expect(r.notifikasiDiantre).toBe(0);
      expect(await emailKe(eml)).toBe(sebelum);
      expect(await statusMemberDb(k1.pel.person)).toBe('KARYAWAN_AKTIF'); // ada lanjutan: tidak AKAN_BERAKHIR
    });

    it('templat email: Indonesia, memuat nomor/pekerja/tanggal/sisa hari', async () => {
      const { renderTemplate } = await import('../src/notifications/templates');
      const p = renderTemplate('kontrak_akan_berakhir', 'hrd@contoh.invalid', { nomor: 'PKWT/X/2026/0001', nama: 'SINTETIS A', jabatan: 'Satpam', perusahaan: 'PT SINTETIS', tanggal_akhir: '31 Desember 2026', sisa_hari: '12' });
      expect(p.subject).toBe('Kontrak PKWT/X/2026/0001 akan berakhir 12 hari lagi');
      expect(p.text).toMatch(/Berakhir pada : 31 Desember 2026 \(12 hari lagi\)/);
      expect(p.text).toMatch(/Pengingat ini dikirim sekali per kontrak/);
    });
  });
});
