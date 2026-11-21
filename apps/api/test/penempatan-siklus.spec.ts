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

jalan('penempatan, siklus hidup kontrak, dan status member otomatis (PostgreSQL asli)', () => {
  let app: INestApplication;
  let pool: Pool;
  let nomorIp = 1;
  let perusahaanA: string;
  let perusahaanB: string;
  let sessions: import('../src/auth/session.service').SessionService;

  beforeAll(async () => {
    execFileSync('node', ['scripts/migrate.js', 'up'], { env: { ...process.env, DATABASE_URL: DB_URL } });
    const { AppModule } = await import('../src/app.module');
    const { konfigurasiApp } = await import('../src/app.factory');
    const { SessionService } = await import('../src/auth/session.service');
    process.env.DATABASE_URL = await urlAplikasiTanpaBypass(DB_URL!);
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    konfigurasiApp(app);
    await app.init();
    sessions = app.get(SessionService);
    pool = new Pool({ connectionString: DB_URL, max: 4 });
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
  const lowonganTerbuka = (company: string, createdBy: string) =>
    tenant([company], async (c) => (await c.query(`INSERT INTO job_vacancies (company_id, title, description, status, opened_at, created_by) VALUES ($1, $2, 'D', 'DIBUKA', now(), $3) RETURNING id`, [company, `Lowongan ${randomBytes(3).toString('hex')}`, createdBy])).rows[0].id as string);
  const statusMemberDb = async (person: string) => (await pool.query(`SELECT status FROM member_profiles WHERE person_id = $1`, [person])).rows[0].status as string;
  const riwayatMember = async (person: string) => (await pool.query(`SELECT to_status, reason, actor_user_id FROM member_status_histories WHERE person_id = $1 ORDER BY created_at, id`, [person])).rows as { to_status: string; reason: string | null; actor_user_id: string | null }[];
  const siklus = async () => (await import('../src/pkwt/lifecycle.service')).ContractLifecycleService;
  const jalankanSiklus = async (tanggal: string) => app.get(await siklus()).prosesOrang(currentPerson, pada(tanggal));

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
  const statusPenempatan = async (t: Aktor, id: string) => (await http('get', `/placements/${id}`, t.ops).expect(200)).body.status as string;

  it('prasyarat: aplikasi berjalan sebagai role non-superuser tanpa BYPASSRLS (RLS benar-benar berlaku)', async () => {
    const { POOL } = await import('../src/database/tokens');
    const r = await app.get<Pool>(POOL).query(`SELECT current_user AS u, (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass`);
    expect(r.rows[0]).toEqual({ u: 'hris_app_uji', bypass: false });
  });

  describe('alur nyata: kontrak + penempatan -> status member berubah otomatis -> lamaran terblokir', () => {
    it('DITANDATANGANI -> (tanggal mulai) AKTIF + penempatan AKTIF -> KARYAWAN_AKTIF; 403 melamar; akan berakhir; berakhir; verifikasi HRD; boleh melamar lagi', async () => {
      const t = await aktor();
      const k = await kontrakSiap(t);
      const m = await memberSesi(k.pel.person);
      const lowongan = await lowonganTerbuka(perusahaanA, t.hrdU.userId);
      const lamar = () => http('post', '/member/applications', m).send({ vacancyId: lowongan });
      const penId = await penempatanSiap(t, k);
      expect(await statusPenempatan(t, penId)).toBe('MENUNGGU_KONTRAK');
      expect(await statusMemberDb(k.pel.person)).toBe('BELUM_DITEMPATKAN');
      // sebelum tanggal mulai: tidak ada perubahan (idempoten)
      let r = await jalankanSiklus(hari(MULAI, -1));
      expect(r).toEqual({ kontrakAktif: 0, kontrakBerakhir: 0, penempatanAktif: 0, penempatanSelesai: 0, statusMemberDiubah: 0, notifikasiDiantre: 0 });
      expect(await statusKontrak(t, k.kontrakId)).toBe('DITANDATANGANI');
      // tanggal mulai tiba
      r = await jalankanSiklus(MULAI);
      expect(r.kontrakAktif).toBe(1);
      expect(r.penempatanAktif).toBe(1);
      expect(r.statusMemberDiubah).toBe(1);
      expect(await statusKontrak(t, k.kontrakId)).toBe('AKTIF');
      expect(await statusPenempatan(t, penId)).toBe('AKTIF');
      expect(await statusMemberDb(k.pel.person)).toBe('KARYAWAN_AKTIF');
      // idempoten: menjalankan lagi tidak mengubah apa pun dan tidak menambah riwayat
      const sebelum = (await riwayatMember(k.pel.person)).length;
      expect(await jalankanSiklus(MULAI)).toEqual({ kontrakAktif: 0, kontrakBerakhir: 0, penempatanAktif: 0, penempatanSelesai: 0, statusMemberDiubah: 0, notifikasiDiantre: 0 });
      expect((await riwayatMember(k.pel.person)).length).toBe(sebelum);
      // ALUR NYATA -> LAMARAN DIBLOKIR di backend (tanpa mengatur status manual)
      expect((await lamar().expect(403)).body.kode).toBe('KARYAWAN_AKTIF_TIDAK_DAPAT_MELAMAR');
      expect((await http('get', '/member/eligibility', m).expect(200)).body.bisaMelamar).toBe(false);
      // akan berakhir (<= 30 hari tanpa kontrak lanjutan)
      await jalankanSiklus(hari(AKHIR, -10));
      expect(await statusMemberDb(k.pel.person)).toBe('KONTRAK_AKAN_BERAKHIR');
      expect((await lamar().expect(403)).body.kode).toBe('KARYAWAN_AKTIF_TIDAK_DAPAT_MELAMAR');
      // berakhir
      r = await jalankanSiklus(hari(AKHIR, 1));
      expect(r.kontrakBerakhir).toBe(1);
      expect(r.penempatanSelesai).toBe(1);
      expect(await statusKontrak(t, k.kontrakId)).toBe('BERAKHIR');
      expect(await statusPenempatan(t, penId)).toBe('SELESAI');
      expect(await statusMemberDb(k.pel.person)).toBe('KONTRAK_BERAKHIR');
      expect((await lamar().expect(403)).body.kode).toBe('KONTRAK_BERAKHIR_PERLU_VERIFIKASI');
      // kembali ke pencari kerja HANYA lewat verifikasi HRD
      await http('post', `/members/${(await pool.query(`SELECT id FROM member_profiles WHERE person_id = $1`, [k.pel.person])).rows[0].id}/reactivate`, t.hrdU).send({ reason: 'Kontrak selesai, siap melamar kembali' }).expect(200);
      expect(await statusMemberDb(k.pel.person)).toBe('BELUM_DITEMPATKAN');
      await lamar().expect(201);
      // riwayat: perubahan otomatis tanpa aktor, verifikasi HRD beraktor
      const rw = await riwayatMember(k.pel.person);
      expect(rw.filter((x) => x.reason?.startsWith('Otomatis:')).every((x) => x.actor_user_id === null)).toBe(true);
      expect(rw.map((x) => x.to_status)).toEqual(expect.arrayContaining(['KARYAWAN_AKTIF', 'KONTRAK_AKAN_BERAKHIR', 'KONTRAK_BERAKHIR', 'BELUM_DITEMPATKAN']));
    });

    it('lamaran aktif lain ditarik otomatis saat menjadi karyawan (lamaran kontrak tidak disentuh); riwayat bertanda Otomatis', async () => {
      const t = await aktor();
      const k = await kontrakSiap(t);
      const lowongan = await lowonganTerbuka(perusahaanA, t.hrdU.userId);
      const lain = await tenant([perusahaanA], async (c) => (await c.query(`INSERT INTO job_applications (company_id, vacancy_id, person_id, status) VALUES ($1, $2, $3, 'INTERVIEW') RETURNING id`, [perusahaanA, lowongan, k.pel.person])).rows[0].id as string);
      await penempatanSiap(t, k);
      await jalankanSiklus(MULAI);
      const st = await tenant([perusahaanA], async (c) => (await c.query(`SELECT id, status FROM job_applications WHERE person_id = $1`, [k.pel.person])).rows as { id: string; status: string }[]);
      expect(st.find((x) => x.id === lain)!.status).toBe('DITARIK');
      expect(st.find((x) => x.id === k.pel.lamaran)!.status).toBe('MENUNGGU_PKWT');
      const h = await tenant([perusahaanA], async (c) => (await c.query(`SELECT from_status, to_status, reason, actor_user_id FROM application_status_histories WHERE application_id = $1 ORDER BY created_at DESC`, [lain])).rows[0]);
      expect(h).toEqual({ from_status: 'INTERVIEW', to_status: 'DITARIK', reason: 'Otomatis: menjadi karyawan aktif', actor_user_id: null });
    });

    it('penempatan disetujui SEBELUM kontrak ditandatangani tetap menunggu, lalu aktif otomatis; scan diverifikasi sesudah tanggal mulai langsung mengaktifkan', async () => {
      const t = await aktor();
      const pel = await siapPelamar(perusahaanA);
      const tpl = await templateOk(t);
      const kon = (await buatKontrak(t.adm, pel.lamaran, tpl, { startDate: '2000-01-01', endDate: `${Y}-12-31` }).expect(201)).body; // sudah lewat tanggal mulai
      const lokasi = await lokasiBaru(perusahaanA, t.hrdU.userId);
      const pen = (await rencanakan(t.hrdP, kon.id, lokasi, { startDate: '2000-01-01', endDate: `${Y}-12-31` }).expect(201)).body.id;
      await http('post', `/placements/${pen}/approve`, t.ops).expect(200);
      expect(await statusPenempatan(t, pen)).toBe('MENUNGGU_KONTRAK'); // kontrak belum aktif
      await sampaiDitandatangani(t, kon.id); // verifikasi scan memicu siklus (jam nyata, tanggal mulai sudah lewat)
      expect(await statusKontrak(t, kon.id)).toBe('AKTIF');
      await app.get(await siklus()).prosesOrang(pel.person, new Date());
      expect(await statusPenempatan(t, pen)).toBe('AKTIF');
      expect(await statusMemberDb(pel.person)).toBe('KARYAWAN_AKTIF');
    });

    it('kontrak aktif tanpa penempatan aktif tidak menjadikan karyawan; penempatan ditangguhkan tidak menurunkan status', async () => {
      const t = await aktor();
      const k = await kontrakSiap(t);
      await jalankanSiklus(MULAI);
      expect(await statusKontrak(t, k.kontrakId)).toBe('AKTIF');
      expect(await statusMemberDb(k.pel.person)).toBe('BELUM_DITEMPATKAN'); // belum ada penempatan
      const pen = await penempatanSiap(t, k);
      await jalankanSiklus(MULAI);
      expect(await statusMemberDb(k.pel.person)).toBe('KARYAWAN_AKTIF');
      await http('post', `/placements/${pen}/suspend`, t.ops).send({ reason: 'Cuti panjang' }).expect(200);
      await jalankanSiklus(hari(MULAI, 5));
      expect(await statusMemberDb(k.pel.person)).toBe('KARYAWAN_AKTIF'); // masih terikat kontrak: tetap diblokir melamar
    });

    it('status NONAKTIF dan pra-verifikasi tidak disentuh otomatisasi', async () => {
      const t = await aktor();
      const k = await kontrakSiap(t);
      await penempatanSiap(t, k);
      await pool.query(`UPDATE member_profiles SET status = 'NONAKTIF' WHERE person_id = $1`, [k.pel.person]);
      await jalankanSiklus(MULAI);
      expect(await statusKontrak(t, k.kontrakId)).toBe('AKTIF'); // kontrak tetap berjalan
      expect(await statusMemberDb(k.pel.person)).toBe('NONAKTIF');
    });

    it('perpanjangan: kontrak lanjutan yang sudah ditandatangani mencegah KONTRAK_AKAN_BERAKHIR dan menjaga status tanpa celah saat peralihan', async () => {
      const t = await aktor();
      const k1 = await kontrakSiap(t);
      const pen1 = await penempatanSiap(t, k1);
      await jalankanSiklus(MULAI);
      const awal2 = hari(AKHIR, 1);
      const akhir2 = `${Y}-12-31`;
      const k2 = (await buatKontrak(t.adm, k1.pel.lamaran, k1.tpl, { extendsContractId: k1.kontrakId, startDate: awal2, endDate: akhir2 }).expect(201)).body;
      await sampaiDitandatangani(t, k2.id);
      const pen2 = (await rencanakan(t.hrdP, k2.id, k1.lokasi, { startDate: awal2, endDate: akhir2 }).expect(201)).body.id; // berdampingan dengan penempatan 1
      await http('post', `/placements/${pen2}/approve`, t.ops).expect(200);
      await jalankanSiklus(hari(AKHIR, -5)); // dalam jendela 30 hari tetapi ada lanjutan
      expect(await statusMemberDb(k1.pel.person)).toBe('KARYAWAN_AKTIF');
      const r = await jalankanSiklus(awal2); // hari peralihan: aktivasi dulu, lalu berakhir, dalam satu transaksi
      expect(r.kontrakAktif).toBe(1);
      expect(r.kontrakBerakhir).toBe(1);
      expect(await statusKontrak(t, k1.kontrakId)).toBe('BERAKHIR');
      expect(await statusKontrak(t, k2.id)).toBe('AKTIF');
      expect(await statusPenempatan(t, pen1)).toBe('SELESAI');
      expect(await statusPenempatan(t, pen2)).toBe('AKTIF');
      expect(await statusMemberDb(k1.pel.person)).toBe('KARYAWAN_AKTIF'); // tidak pernah turun ke KONTRAK_BERAKHIR
      expect((await riwayatMember(k1.pel.person)).map((x) => x.to_status)).not.toContain('KONTRAK_BERAKHIR');
    });

    it('jalankan(): memproses orang yang jatuh tempo (worker) dan mengembalikan ringkasan; aman diulang', async () => {
      const t = await aktor();
      const besok = new Date(Date.now() + 86400000 + 7 * 3600000).toISOString().slice(0, 10); // jam realistis: hanya pekerjaan yang benar-benar jatuh tempo
      const k = await kontrakSiap(t, { start: besok, end: hari(besok, 100) });
      await penempatanSiap(t, k, { startDate: besok, endDate: hari(besok, 100) });
      const { ContractLifecycleService } = await import('../src/pkwt/lifecycle.service');
      const svc = app.get(ContractLifecycleService);
      const r = await svc.jalankan(pada(besok));
      expect(r.kontrakAktif).toBeGreaterThanOrEqual(1);
      expect(await statusMemberDb(k.pel.person)).toBe('KARYAWAN_AKTIF');
      const ulang = await svc.jalankan(pada(besok));
      expect(ulang.kontrakAktif).toBe(0);
      expect(ulang.statusMemberDiubah).toBe(0);
    });
  });

  describe('penempatan', () => {
    it('tumpang tindih ditolak API (409); berdampingan dan yang dibatalkan boleh; periode harus dalam kontrak; lokasi harus aktif dan satu perusahaan', async () => {
      const t = await aktor();
      const k = await kontrakSiap(t);
      const p1 = (await rencanakan(t.hrdP, k.kontrakId, k.lokasi, { startDate: MULAI, endDate: `${Y}-05-31` }).expect(201)).body;
      expect((await rencanakan(t.hrdP, k.kontrakId, k.lokasi, { startDate: `${Y}-05-31`, endDate: AKHIR }).expect(409)).body.kode).toBe('PENEMPATAN_TUMPANG_TINDIH');
      await rencanakan(t.hrdP, k.kontrakId, k.lokasi, { startDate: `${Y}-06-01`, endDate: AKHIR }).expect(201); // berdampingan
      await http('post', `/placements/${p1.id}/cancel`, t.hrdP).send({ reason: 'Rencana berubah' }).expect(200);
      await rencanakan(t.hrdP, k.kontrakId, k.lokasi, { startDate: MULAI, endDate: `${Y}-05-31` }).expect(201); // dibatalkan tidak menghalangi
      expect((await rencanakan(t.hrdP, k.kontrakId, k.lokasi, { startDate: `${Y - 1}-01-01`, endDate: AKHIR }).expect(409)).body.kode).toBe('PERIODE_DI_LUAR_KONTRAK');
      expect((await rencanakan(t.hrdP, k.kontrakId, k.lokasi, { startDate: MULAI, endDate: `${Y + 1}-01-01` }).expect(409)).body.kode).toBe('PERIODE_DI_LUAR_KONTRAK');
      await rencanakan(t.hrdP, k.kontrakId, k.lokasi, { startDate: AKHIR, endDate: MULAI }).expect(400);
      await rencanakan(t.hrdP, k.kontrakId, '00000000-0000-4000-8000-000000000000').expect(404);
      await rencanakan(t.hrdP, '00000000-0000-4000-8000-000000000000', k.lokasi).expect(404);
      const lokB = await lokasiBaru(perusahaanB, t.hrdU.userId);
      await rencanakan(t.hrdP, k.kontrakId, lokB).expect(404); // lokasi perusahaan lain
      await tenant([perusahaanA], async (c) => void (await c.query(`UPDATE partner_locations SET status = 'NONAKTIF' WHERE id = $1`, [k.lokasi])));
      await rencanakan(t.hrdP, k.kontrakId, k.lokasi, { startDate: `${Y}-07-01`, endDate: `${Y}-07-31` }).expect(404); // lokasi nonaktif
    });

    it('kontrak yang berakhir/dibatalkan tidak dapat ditempatkan; pemisahan tugas persetujuan (pembuat tidak dapat menyetujui)', async () => {
      const t = await aktor();
      const k = await kontrakSiap(t);
      // pembuat sekaligus Mgr Ops: tidak boleh menyetujui penempatannya sendiri
      const ganda = await buatStaff('MANAGER_OPERASIONAL', [perusahaanA]);
      await pool.query(`INSERT INTO user_roles (user_id, role_code, grant_source) VALUES ($1, 'HRD', 'MANUAL')`, [ganda.userId]);
      const p = (await rencanakan(ganda, k.kontrakId, k.lokasi).expect(201)).body;
      expect((await http('post', `/placements/${p.id}/approve`, ganda).expect(403)).body.kode).toBe('PEMISAHAN_TUGAS');
      expect(await statusPenempatan(t, p.id)).toBe('DIRENCANAKAN');
      await http('post', `/placements/${p.id}/approve`, t.ops).expect(200);
      await http('post', `/placements/${p.id}/approve`, t.ops).expect(409);
      // kontrak dibatalkan
      const pel = await siapPelamar(perusahaanA);
      const kb = (await buatKontrak(t.adm, pel.lamaran, k.tpl).expect(201)).body;
      await http('post', `/pkwt/${kb.id}/cancel`, t.hrdU).send({ reason: 'Uji dibatalkan' }).expect(200);
      expect((await rencanakan(t.hrdP, kb.id, k.lokasi).expect(409)).body.kode).toBe('KONTRAK_TIDAK_BERJALAN');
    });

    it('tangguhkan/lanjutkan/selesaikan/batalkan: transisi sah dengan alasan, transisi ilegal 409, riwayat lengkap', async () => {
      const t = await aktor();
      const k = await kontrakSiap(t);
      const id = await penempatanSiap(t, k);
      await http('post', `/placements/${id}/suspend`, t.hrdP).send({ reason: 'x' }).expect(400); // aktif saja & alasan wajib
      await http('post', `/placements/${id}/suspend`, t.hrdP).send({ reason: 'Cuti' }).expect(409); // belum AKTIF
      await jalankanSiklus(MULAI);
      expect(await statusPenempatan(t, id)).toBe('AKTIF');
      await http('post', `/placements/${id}/cancel`, t.hrdP).send({ reason: 'Terlambat' }).expect(409); // aktif tak dapat dibatalkan
      await http('post', `/placements/${id}/suspend`, t.hrdP).send({ reason: 'Cuti panjang' }).expect(200);
      await http('post', `/placements/${id}/suspend`, t.hrdP).send({ reason: 'Lagi' }).expect(409);
      await http('post', `/placements/${id}/resume`, t.hrdP).expect(200);
      await http('post', `/placements/${id}/resume`, t.hrdP).expect(409);
      await http('post', `/placements/${id}/complete`, t.hrdP).send({}).expect(400);
      await http('post', `/placements/${id}/complete`, t.hrdP).send({ reason: 'Proyek selesai lebih awal' }).expect(200);
      expect(await statusPenempatan(t, id)).toBe('SELESAI');
      const det = (await http('get', `/placements/${id}`, t.ops).expect(200)).body;
      expect((det.history as { to: string }[]).map((h) => h.to).reverse()).toEqual(['DIRENCANAKAN', 'MENUNGGU_KONTRAK', 'AKTIF', 'DITANGGUHKAN', 'AKTIF', 'SELESAI']);
      expect(det.workerName).toBe('SINTETIS Karyawan Uji');
      expect(det.contractNumber).toBeTruthy();
    });

    it('pindah lokasi: penempatan lama berakhir H-1 dan penempatan baru (perlu persetujuan) dimulai pada tanggal pindah; lama menjadi DIPINDAHKAN', async () => {
      const t = await aktor();
      const k = await kontrakSiap(t);
      const lama = await penempatanSiap(t, k);
      await jalankanSiklus(MULAI);
      const lokBaru = await lokasiBaru(perusahaanA, t.hrdU.userId, 'Gedung Baru');
      const tglPindah = `${Y}-06-01`;
      await http('post', `/placements/${lama}/move`, t.hrdP).send({ locationId: k.lokasi, moveDate: tglPindah, reason: 'sama' }).expect(409); // lokasi sama
      await http('post', `/placements/${lama}/move`, t.hrdP).send({ locationId: lokBaru, moveDate: MULAI, reason: 'tidak valid' }).expect(409); // tidak setelah mulai
      const baru = (await http('post', `/placements/${lama}/move`, t.hrdP).send({ locationId: lokBaru, moveDate: tglPindah, reason: 'Pindah proyek' }).expect(200)).body;
      expect(baru.status).toBe('DIRENCANAKAN');
      expect(baru.startDate).toBe(tglPindah);
      expect(baru.endDate).toBe(AKHIR);
      const detLama = (await http('get', `/placements/${lama}`, t.ops).expect(200)).body;
      expect(detLama.endDate).toBe(hari(tglPindah, -1));
      expect(detLama.replacedById).toBe(baru.id);
      await http('post', `/placements/${baru.id}/approve`, t.ops).expect(200);
      await jalankanSiklus(tglPindah);
      expect(await statusPenempatan(t, lama)).toBe('DIPINDAHKAN');
      expect(await statusPenempatan(t, baru.id)).toBe('AKTIF');
      expect(await statusMemberDb(k.pel.person)).toBe('KARYAWAN_AKTIF');
    });

    it('mengakhiri kontrak lebih awal (Direktur, alasan wajib): penempatan selesai dan status member KONTRAK_BERAKHIR', async () => {
      const t = await aktor();
      const k = await kontrakSiap(t);
      const pen = await penempatanSiap(t, k);
      await http('post', `/pkwt/${k.kontrakId}/terminate`, t.dir).send({ reason: 'Pelanggaran disiplin' }).expect(409); // belum AKTIF
      await jalankanSiklus(MULAI);
      await http('post', `/pkwt/${k.kontrakId}/terminate`, t.dir).send({}).expect(400);
      await http('post', `/pkwt/${k.kontrakId}/terminate`, t.hrdU).send({ reason: 'Bukan wewenang' }).expect(403);
      await http('post', `/pkwt/${k.kontrakId}/terminate`, t.dir).send({ reason: 'Pelanggaran disiplin' }).expect(200);
      expect(await statusKontrak(t, k.kontrakId)).toBe('DIAKHIRI_LEBIH_AWAL');
      expect(await statusPenempatan(t, pen)).toBe('SELESAI');
      expect(await statusMemberDb(k.pel.person)).toBe('KONTRAK_BERAKHIR');
      await http('post', `/pkwt/${k.kontrakId}/terminate`, t.dir).send({ reason: 'Lagi' }).expect(409);
    });

    it('reaktivasi member: hanya dari KONTRAK_BERAKHIR, alasan wajib, hanya member.review', async () => {
      const t = await aktor();
      const pel = await siapPelamar(perusahaanA);
      const mid = pel.pid;
      await http('post', `/members/${mid}/reactivate`, t.hrdU).send({ reason: 'Tidak ada kontrak berakhir' }).expect(409);
      await pool.query(`UPDATE member_profiles SET status = 'KONTRAK_BERAKHIR' WHERE id = $1`, [mid]);
      await http('post', `/members/${mid}/reactivate`, t.hrdU).send({}).expect(400);
      await http('post', `/members/${mid}/reactivate`, t.dir).send({ reason: 'Direktur tidak berhak' }).expect(403);
      await http('post', `/members/${mid}/reactivate`, t.hrdU).send({ reason: 'Siap melamar kembali' }).expect(200);
      expect(await statusMemberDb(pel.person)).toBe('BELUM_DITEMPATKAN');
      await http('post', `/members/${mid}/reactivate`, t.hrdU).send({ reason: 'Lagi' }).expect(409);
    });
  });

  describe('isolasi lintas perusahaan', () => {
    it('staff B tidak melihat/memproses penempatan A (404); daftar dan filter tidak membocorkan; data A utuh', async () => {
      const t = await aktor();
      const k = await kontrakSiap(t);
      const id = await penempatanSiap(t, k);
      const hrdB = await buatStaff('HRD', [perusahaanB]);
      const opsB = await buatStaff('MANAGER_OPERASIONAL', [perusahaanB]);
      await http('get', `/placements/${id}`, opsB).expect(404);
      for (const aksi of ['approve', 'resume']) await http('post', `/placements/${id}/${aksi}`, opsB).expect(404);
      for (const aksi of ['suspend', 'complete', 'cancel']) await http('post', `/placements/${id}/${aksi}`, opsB).send({ reason: 'lintas perusahaan' }).expect(404);
      await http('post', `/placements/${id}/move`, opsB).send({ locationId: k.lokasi, moveDate: `${Y}-06-01`, reason: 'lintas' }).expect(404);
      await rencanakan(hrdB, k.kontrakId, k.lokasi).expect(404); // kontrak perusahaan A
      expect(((await http('get', '/placements?limit=100', opsB).expect(200)).body.items as { id: string }[]).map((x) => x.id)).not.toContain(id);
      expect((await http('get', `/placements?contractId=${k.kontrakId}`, opsB).expect(200)).body.items).toEqual([]);
      expect(await statusPenempatan(t, id)).toBe('MENUNGGU_KONTRAK');
    });

    it('keyset daftar penempatan: tanpa duplikat; filter status; batas dan kursor divalidasi', async () => {
      const t = await aktor();
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const k = await kontrakSiap(t);
        ids.push((await rencanakan(t.hrdP, k.kontrakId, k.lokasi).expect(201)).body.id);
      }
      const lihat = new Set<string>();
      let kursor: string | null = null;
      let n = 0;
      do {
        const r: request.Response = await http('get', `/placements?limit=2&status=DIRENCANAKAN${kursor ? `&cursor=${kursor}` : ''}`, t.ops).expect(200);
        for (const x of r.body.items as { id: string }[]) {
          expect(lihat.has(x.id)).toBe(false);
          lihat.add(x.id);
        }
        kursor = r.body.nextCursor;
        n++;
      } while (kursor && n < 80);
      for (const id of ids) expect(lihat.has(id)).toBe(true);
      await http('get', '/placements?limit=101', t.ops).expect(400);
      await http('get', '/placements?status=ASAL', t.ops).expect(400);
      await http('get', '/placements?cursor=bukan-kursor', t.ops).expect(400);
    });
  });

  describe('izin per peran (sesuai docs/rbac.md)', () => {
    // [lihat (V), buat (C), ubah: tangguh/lanjut/selesai/batal/pindah (U), setujui (A)]
    const izin: Record<string, [boolean, boolean, boolean, boolean]> = {
      DIREKTUR: [true, false, false, false],
      MANAGER_OPERASIONAL: [true, true, true, true],
      IT_ADMIN: [false, false, false, false],
      HRD: [true, true, true, false],
      MARKETING: [true, false, false, false],
      STAFF_ADMINISTRASI: [true, false, false, false],
      STAFF_PAYROLL_ABSENSI_REKANAN: [true, false, true, false], // U(shift): kualifikator sel belum ditegakkan (keterbatasan tercatat)
      STAFF_KEUANGAN: [false, false, false, false],
      STAFF_PAYROLL_INTERNAL: [false, false, false, false],
    };
    it.each(Object.entries(izin))('%s', async (peranKode, [v, c, u, ap]) => {
      const t = await aktor();
      const k = await kontrakSiap(t);
      const id = (await rencanakan(t.hrdP, k.kontrakId, k.lokasi).expect(201)).body.id as string;
      const s = await buatStaff(peranKode, [perusahaanA]);
      const cek = async (boleh: boolean, res: request.Test) => {
        const r = await res;
        if (boleh) expect(r.status).not.toBe(403);
        else expect(r.status).toBe(403);
      };
      await cek(v, http('get', '/placements', s));
      await cek(v, http('get', `/placements/${id}`, s));
      await cek(c, rencanakan(s, k.kontrakId, k.lokasi, { startDate: `${Y}-04-01`, endDate: `${Y}-04-02` }));
      await cek(u, http('post', `/placements/${id}/suspend`, s).send({ reason: 'uji izin' }));
      await cek(u, http('post', `/placements/${id}/resume`, s));
      await cek(u, http('post', `/placements/${id}/complete`, s).send({ reason: 'uji izin' }));
      await cek(u, http('post', `/placements/${id}/move`, s).send({ locationId: k.lokasi, moveDate: `${Y}-06-01`, reason: 'uji izin' }));
      await cek(u, http('post', `/placements/${id}/cancel`, s).send({ reason: 'uji izin' }));
      await cek(ap, http('post', `/placements/${id}/approve`, s));
    });

    it('mencakup semua peran; tanpa sesi 401; member tidak dapat memakai rute staff', async () => {
      expect(Object.keys(izin)).toHaveLength(9);
      await http('get', '/placements').expect(401);
      const m = await memberSesi((await siapPelamar(perusahaanA)).person);
      await http('get', '/placements', m).expect(403);
      await http('post', '/placements', m).send({}).expect(403);
    });
  });
});
