import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
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

jalan('lowongan, lamaran, seleksi, dan CanApply (PostgreSQL asli)', () => {
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
  const buatMember = async (): Promise<Sesi> => {
    const p = (await pool.query(`INSERT INTO persons (display_name) VALUES ('SINTETIS Member') RETURNING id`)).rows[0].id as string;
    const u = (await pool.query(`INSERT INTO users (person_id, realm, email, status) VALUES ($1, 'member', $2, 'AKTIF') RETURNING id`, [p, `m-${randomBytes(4).toString('hex')}@contoh.invalid`])).rows[0].id as string;
    const s = await sessions.buat({ userId: u, realm: 'member', state: 'PENUH' });
    return { cookie: `__Host-sid=${s.token}`, csrf: s.csrfToken, userId: u, personId: p };
  };
  const buatStaff = async (role: string, companyIds: string[] = []): Promise<Sesi> => {
    const u = (await pool.query(`INSERT INTO users (realm, email, status) VALUES ('staff', $1, 'AKTIF') RETURNING id`, [`s-${randomBytes(4).toString('hex')}@contoh.invalid`])).rows[0].id as string;
    await pool.query(`INSERT INTO user_roles (user_id, role_code, grant_source) VALUES ($1, $2, 'MANUAL')`, [u, role]);
    for (const c of companyIds) await pool.query(`INSERT INTO user_company_scopes (user_id, scope_company_id) VALUES ($1, $2)`, [u, c]);
    const s = await sessions.buat({ userId: u, realm: 'staff', state: 'PENUH' });
    return { cookie: `__Host-sid=${s.token}`, csrf: s.csrfToken, userId: u, personId: '' };
  };



  /** Query/ubah tabel tenant lewat koneksi bersekop (RLS berlaku juga bagi koneksi pemilik). */
  const dalamScopeDb = async <T>(companyIds: string[], fn: (c: import('pg').PoolClient) => Promise<T>, commit = false): Promise<T> => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.company_ids', $1, true)`, [companyIds.join(',')]);
      await c.query(`SELECT set_config('app.audit_global', 'on', true)`);
      const r = await fn(c);
      await c.query(commit ? 'COMMIT' : 'ROLLBACK');
      return r;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  };
  const hitungLamaran = (company: string, personId: string) => dalamScopeDb([company], async (c) => (await c.query(`SELECT count(*)::int AS n FROM job_applications WHERE person_id = $1 AND company_id = $2`, [personId, company])).rows[0].n as number); // filter eksplisit: benar juga bila koneksi pemeriksa superuser
  const auditObjek = (company: string, aksi: string, objekId: string) => dalamScopeDb([company], async (c) => (await c.query(`SELECT company_id FROM audit_logs WHERE action = $1 AND object_id = $2`, [aksi, objekId])).rows as { company_id: string }[]);

  /** Member dengan profil berstatus tertentu (diatur langsung di DB; alur verifikasi sudah diuji di 5C). */
  const memberStatus = async (status = 'BELUM_DITEMPATKAN'): Promise<Sesi> => {
    const m = await buatMember();
    const pemeriksa = (await pool.query(`INSERT INTO users (realm, email, status) VALUES ('staff', $1, 'AKTIF') RETURNING id`, [`v-${randomBytes(4).toString('hex')}@contoh.invalid`])).rows[0].id as string;
    const lengkap = ['TERDAFTAR', 'PROFIL_BELUM_LENGKAP'].includes(status) ? '' : `, nik_enc = $3, nik_hmac = $4, birth_place = 'K', birth_date = '1990-01-01', gender = 'L', address = 'A', city = 'Bandung', province = 'P', phone = '08123456', education = 'SMA/SMK', emergency_contact_name = 'E', emergency_contact_phone = '08123457'`;
    const verif = ['TERVERIFIKASI', 'BELUM_DITEMPATKAN', 'KARYAWAN_AKTIF', 'KONTRAK_AKAN_BERAKHIR', 'KONTRAK_BERAKHIR'].includes(status) ? `, verified_by = '${pemeriksa}', verified_at = now()` : '';
    await pool.query(`INSERT INTO member_profiles (person_id) VALUES ($1)`, [m.personId]);
    const params: unknown[] = [m.personId, status];
    if (lengkap) params.push(randomBytes(60), randomBytes(32));
    await pool.query(`UPDATE member_profiles SET status = $2, full_name = 'SINTETIS Pelamar'${lengkap}${verif} WHERE person_id = $1`, params);
    return m;
  };
  const setStatusMember = (personId: string, status: string) => pool.query(`UPDATE member_profiles SET status = $2 WHERE person_id = $1`, [personId, status]);

  const hrdA = async () => buatStaff('HRD', [perusahaanA]);
  const buatLowongan = (s: Sesi, o: object = {}) => http('post', '/vacancies', s).send({ title: `Lowongan SINTETIS ${randomBytes(3).toString('hex')}`, description: 'Deskripsi sintetis', internalNotes: 'CATATAN-INTERNAL-RAHASIA', ...o });
  /** Lowongan berstatus DIBUKA milik perusahaan scope staff. */
  const lowonganTerbuka = async (s: Sesi, o: object = {}) => {
    const v = (await buatLowongan(s, o).expect(201)).body;
    await http('post', `/vacancies/${v.id}/open`, s).expect(200);
    return v as { id: string; companyId: string; title: string };
  };
  const lamar = (m: Sesi, vacancyId: string) => http('post', '/member/applications', m).send({ vacancyId });

  it('prasyarat: aplikasi berjalan sebagai role non-superuser tanpa BYPASSRLS (RLS benar-benar berlaku)', async () => {
    const { POOL } = await import('../src/database/tokens');
    const r = await app.get<Pool>(POOL).query(`SELECT current_user AS u, (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass`);
    expect(r.rows[0]).toEqual({ u: 'hris_app_uji', bypass: false });
  });

  describe('lowongan (staff)', () => {
    it('DRAFT tidak terlihat member; buka -> terlihat lintas perusahaan tanpa catatan internal; tutup -> hilang; transisi ilegal 409', async () => {
      const hrd = await hrdA();
      const m = await memberStatus();
      const v = (await buatLowongan(hrd).expect(201)).body;
      expect(v.status).toBe('DRAFT');
      expect(v.companyId).toBe(perusahaanA); // scope tunggal -> otomatis
      const lihat = async () => ((await http('get', '/member/vacancies?limit=100', m).expect(200)).body.items as { id: string }[]).map((x) => x.id);
      expect(await lihat()).not.toContain(v.id);
      await http('get', `/member/vacancies/${v.id}`, m).expect(404);
      await http('post', `/vacancies/${v.id}/close`, hrd).expect(409); // DRAFT tak dapat ditutup
      await http('post', `/vacancies/${v.id}/open`, hrd).expect(200);
      await http('post', `/vacancies/${v.id}/open`, hrd).expect(409);
      expect(await lihat()).toContain(v.id);
      const det = (await http('get', `/member/vacancies/${v.id}`, m).expect(200)).body;
      expect(det.companyName).toMatch(/PT SINTETIS A/);
      expect(JSON.stringify(det)).not.toMatch(/CATATAN-INTERNAL|internalNotes|companyId|createdBy/);
      await http('post', `/vacancies/${v.id}/close`, hrd).expect(200);
      expect(await lihat()).not.toContain(v.id);
      await http('patch', `/vacancies/${v.id}`, hrd).send({ title: 'Baru' }).expect(409); // ditutup terkunci
      await http('post', `/vacancies/${v.id}/open`, hrd).expect(409);
    });

    it('validasi Indonesia; batas pendaftaran lewat tidak dapat dibuka dan lowongan kedaluwarsa tidak terlihat member', async () => {
      const hrd = await hrdA();
      expect(JSON.stringify((await buatLowongan(hrd, { title: '' }).expect(400)).body)).toMatch(/wajib/);
      await buatLowongan(hrd, { positions: 0 }).expect(400);
      await buatLowongan(hrd, { closesOn: '2026-02-30' }).expect(400);
      await http('patch', '/vacancies/00000000-0000-4000-8000-000000000000', hrd).send({}).expect(400);
      const lampau = (await buatLowongan(hrd, { closesOn: '2020-01-01' }).expect(201)).body;
      expect((await http('post', `/vacancies/${lampau.id}/open`, hrd).expect(409)).body.kode).toBe('BATAS_PENDAFTARAN_LEWAT');
      const v = await lowonganTerbuka(hrd);
      await dalamScopeDb([perusahaanA], async (c) => void (await c.query(`UPDATE job_vacancies SET closes_on = '2020-01-01' WHERE id = $1`, [v.id])), true);
      const m = await memberStatus();
      await http('get', `/member/vacancies/${v.id}`, m).expect(404);
      await lamar(m, v.id).expect(404);
    });

    it('lokasi harus milik perusahaan yang sama dan aktif', async () => {
      const hrd = await hrdA();
      const hrdB = await buatStaff('HRD', [perusahaanB]);
      const dalamB = await dalamScopeDb([perusahaanB], async (c) => {
        const p = (await c.query(`INSERT INTO partners (company_id, name, created_by) VALUES ($1, $2, $3) RETURNING id`, [perusahaanB, `Rek ${randomBytes(3).toString('hex')}`, hrdB.userId])).rows[0].id;
        return (await c.query(`INSERT INTO partner_locations (company_id, partner_id, name, created_by) VALUES ($1, $2, 'Lokasi B', $3) RETURNING id`, [perusahaanB, p, hrdB.userId])).rows[0].id as string;
      }, true);
      expect((await buatLowongan(hrd, { locationId: dalamB }).expect(404)).body.kode).toBe('LOKASI_TIDAK_DITEMUKAN');
      const sendiri = await dalamScopeDb([perusahaanA], async (c) => {
        const p = (await c.query(`INSERT INTO partners (company_id, name, created_by) VALUES ($1, $2, $3) RETURNING id`, [perusahaanA, `Rek ${randomBytes(3).toString('hex')}`, hrd.userId])).rows[0].id;
        return (await c.query(`INSERT INTO partner_locations (company_id, partner_id, name, created_by) VALUES ($1, $2, 'Lokasi A', $3) RETURNING id`, [perusahaanA, p, hrd.userId])).rows[0].id as string;
      }, true);
      const v = (await buatLowongan(hrd, { locationId: sendiri }).expect(201)).body;
      expect(v.locationId).toBe(sendiri);
      await http('patch', `/vacancies/${v.id}`, hrd).send({ locationId: dalamB }).expect(404);
    });

    it('lintas perusahaan: scope A tidak melihat/mengubah/membuka lowongan B (404); companyId di luar scope 404; scope jamak wajib memilih', async () => {
      const hA = await hrdA();
      const hB = await buatStaff('HRD', [perusahaanB]);
      const vB = await lowonganTerbuka(hB);
      await http('get', `/vacancies/${vB.id}`, hA).expect(404);
      await http('patch', `/vacancies/${vB.id}`, hA).send({ title: 'Diretas' }).expect(404);
      await http('post', `/vacancies/${vB.id}/close`, hA).expect(404);
      expect(((await http('get', '/vacancies?limit=100', hA).expect(200)).body.items as { id: string }[]).map((x) => x.id)).not.toContain(vB.id);
      expect((await http('get', `/vacancies?companyId=${perusahaanB}`, hA).expect(200)).body.items).toEqual([]);
      await buatLowongan(hA, { companyId: perusahaanB }).expect(404);
      const ganda = await buatStaff('HRD', [perusahaanA, perusahaanB]);
      expect((await buatLowongan(ganda).expect(409)).body.kode).toBe('PERUSAHAAN_WAJIB');
      expect((await buatLowongan(ganda, { companyId: perusahaanB }).expect(201)).body.companyId).toBe(perusahaanB);
      expect((await http('get', `/vacancies/${vB.id}`, hB).expect(200)).body.status).toBe('DIBUKA'); // data B utuh
    });

    it('keyset lowongan: tanpa duplikat, batas ukuran dan kursor divalidasi', async () => {
      const hrd = await buatStaff('HRD', [perusahaanB]);
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) ids.push((await buatLowongan(hrd).expect(201)).body.id);
      const lihat = new Set<string>();
      let kursor: string | null = null;
      let n = 0;
      do {
        const r: request.Response = await http('get', `/vacancies?limit=2${kursor ? `&cursor=${kursor}` : ''}`, hrd).expect(200);
        for (const x of r.body.items as { id: string }[]) {
          expect(lihat.has(x.id)).toBe(false);
          lihat.add(x.id);
        }
        kursor = r.body.nextCursor;
        n++;
      } while (kursor && n < 50);
      for (const id of ids) expect(lihat.has(id)).toBe(true);
      await http('get', '/vacancies?limit=101', hrd).expect(400);
      await http('get', '/vacancies?cursor=bukan-kursor', hrd).expect(400);
      await http('get', '/vacancies?status=ASAL', hrd).expect(400);
    });
  });

  describe('CanApply: aturan keras di backend', () => {
    const kasus: [string, boolean, string | null][] = [
      ['TERDAFTAR', false, 'PROFIL_BELUM_TERVERIFIKASI'],
      ['PROFIL_BELUM_LENGKAP', false, 'PROFIL_BELUM_TERVERIFIKASI'],
      ['MENUNGGU_VERIFIKASI', false, 'PROFIL_BELUM_TERVERIFIKASI'],
      ['TERVERIFIKASI', true, null],
      ['BELUM_DITEMPATKAN', true, null],
      ['KARYAWAN_AKTIF', false, 'KARYAWAN_AKTIF_TIDAK_DAPAT_MELAMAR'],
      ['KONTRAK_AKAN_BERAKHIR', false, 'KARYAWAN_AKTIF_TIDAK_DAPAT_MELAMAR'],
      ['KONTRAK_BERAKHIR', false, 'KONTRAK_BERAKHIR_PERLU_VERIFIKASI'],
      ['NONAKTIF', false, 'AKUN_MEMBER_NONAKTIF'],
    ];
    it.each(kasus)('status %s -> boleh melamar: %s', async (status, boleh, kode) => {
      const hrd = await hrdA();
      const v = await lowonganTerbuka(hrd);
      const m = await memberStatus(status);
      const e = (await http('get', '/member/eligibility', m).expect(200)).body;
      expect(e.bisaMelamar).toBe(boleh);
      const r = await lamar(m, v.id);
      if (boleh) {
        expect(r.status).toBe(201);
        expect(await hitungLamaran(perusahaanA, m.personId)).toBe(1);
      } else {
        expect(r.status).toBe(403);
        expect(r.body.kode).toBe(kode);
        expect(e.kode).toBe(kode);
        expect(await hitungLamaran(perusahaanA, m.personId)).toBe(0); // tidak ada lamaran tertulis
      }
    });

    it('karyawan aktif ditolak 403 walau lowongan tidak ada (aturan dievaluasi lebih dulu); tanpa profil diperlakukan belum terverifikasi', async () => {
      const aktif = await memberStatus('KARYAWAN_AKTIF');
      expect((await lamar(aktif, '00000000-0000-4000-8000-000000000000').expect(403)).body.kode).toBe('KARYAWAN_AKTIF_TIDAK_DAPAT_MELAMAR');
      const baru = await buatMember(); // belum punya baris profil
      expect((await lamar(baru, '00000000-0000-4000-8000-000000000000').expect(403)).body.kode).toBe('PROFIL_BELUM_TERVERIFIKASI');
    });

    it('status berubah menjadi karyawan aktif setelah melamar: lamaran baru tetap diblokir (status dibaca saat itu juga)', async () => {
      const hrd = await hrdA();
      const v1 = await lowonganTerbuka(hrd);
      const v2 = await lowonganTerbuka(hrd);
      const m = await memberStatus();
      await lamar(m, v1.id).expect(201);
      await setStatusMember(m.personId, 'KARYAWAN_AKTIF'); // Fase 6 akan melakukan ini otomatis
      await lamar(m, v2.id).expect(403);
      await setStatusMember(m.personId, 'KONTRAK_AKAN_BERAKHIR');
      await lamar(m, v2.id).expect(403);
      await setStatusMember(m.personId, 'BELUM_DITEMPATKAN');
      await lamar(m, v2.id).expect(201);
    });
  });

  describe('melamar dan menarik', () => {
    it('lintas perusahaan: member melamar lowongan perusahaan mana pun; company_id dari lowongan (bukan input); duplikat 409', async () => {
      const hB = await buatStaff('HRD', [perusahaanB]);
      const vB = await lowonganTerbuka(hB);
      const m = await memberStatus();
      const r = await http('post', '/member/applications', m).send({ vacancyId: vB.id, companyId: perusahaanA }).expect(201);
      expect(await hitungLamaran(perusahaanB, m.personId)).toBe(1);
      expect(await hitungLamaran(perusahaanA, m.personId)).toBe(0);
      expect(r.body.status).toBe('DIAJUKAN');
      expect((await lamar(m, vB.id).expect(409)).body.kode).toBe('SUDAH_MELAMAR');
      expect(((await auditObjek(perusahaanB, 'recruitment.application.submitted', r.body.id))).every((x) => x.company_id === perusahaanB)).toBe(true);
      expect((await auditObjek(perusahaanB, 'recruitment.application.submitted', r.body.id)).length).toBe(1);
    });

    it('DRAFT, ditutup, atau ID tak dikenal -> 404; body tanpa vacancyId 400', async () => {
      const hrd = await hrdA();
      const m = await memberStatus();
      const draft = (await buatLowongan(hrd).expect(201)).body;
      await lamar(m, draft.id).expect(404);
      const tutup = await lowonganTerbuka(hrd);
      await http('post', `/vacancies/${tutup.id}/close`, hrd).expect(200);
      await lamar(m, tutup.id).expect(404);
      await lamar(m, '00000000-0000-4000-8000-000000000000').expect(404);
      await http('post', '/member/applications', m).send({}).expect(400);
      await http('post', '/member/applications', m).send({ vacancyId: 'bukan-uuid' }).expect(400);
    });

    it('lamaran sendiri tampil dengan judul/perusahaan (meski lowongan ditutup) tanpa catatan staff; orang lain tidak melihatnya; tarik lalu lamar ulang', async () => {
      const hrd = await hrdA();
      const v = await lowonganTerbuka(hrd);
      const m = await memberStatus();
      const lain = await memberStatus();
      const l = (await lamar(m, v.id).expect(201)).body;
      const sendiri = async (s: Sesi) => (await http('get', '/member/applications', s).expect(200)).body.items as { id: string; vacancyTitle: string; companyName: string; status: string }[];
      expect((await sendiri(lain)).map((x) => x.id)).not.toContain(l.id);
      await http('post', `/member/applications/${l.id}/withdraw`, lain).expect(404); // bukan miliknya
      await http('post', `/applications/${l.id}/stage`, hrd).send({ status: 'SELEKSI_ADMINISTRASI', note: 'CATATAN-STAFF-RAHASIA' }).expect(200);
      const butir = (await sendiri(m)).find((x) => x.id === l.id)!;
      expect(butir.vacancyTitle).toBe(v.title);
      expect(butir.companyName).toMatch(/PT SINTETIS A/);
      expect(JSON.stringify(await sendiri(m))).not.toContain('CATATAN-STAFF-RAHASIA');
      await http('post', `/vacancies/${v.id}/close`, hrd).expect(200);
      expect((await sendiri(m)).find((x) => x.id === l.id)!.vacancyTitle).toBe(v.title); // lowongan tertutup tetap terbaca oleh pelamarnya
      expect((await http('post', `/member/applications/${l.id}/withdraw`, m).expect(200)).body.status).toBe('DITARIK');
      await http('post', `/member/applications/${l.id}/withdraw`, m).expect(409);
      await lamar(m, v.id).expect(404); // lowongan tertutup: tidak dapat melamar ulang
      const v2 = await lowonganTerbuka(hrd);
      const l2 = (await lamar(m, v2.id).expect(201)).body;
      await http('post', `/member/applications/${l2.id}/withdraw`, m).expect(200);
      await lamar(m, v2.id).expect(201); // setelah ditarik boleh melamar ulang ke lowongan yang masih dibuka
    });

    it('lamaran serentak ke lowongan yang sama: hanya satu berhasil', async () => {
      const hrd = await hrdA();
      const v = await lowonganTerbuka(hrd);
      const m = await memberStatus();
      const r = await Promise.all([lamar(m, v.id), lamar(m, v.id), lamar(m, v.id)]);
      expect(r.map((x) => x.status).sort()).toEqual([201, 409, 409]);
      expect(await hitungLamaran(perusahaanA, m.personId)).toBe(1);
    });
  });

  describe('seleksi lamaran (staff)', () => {
    it('DIAJUKAN -> SELEKSI_ADMINISTRASI -> INTERVIEW -> DITERIMA -> MENUNGGU_PKWT dengan riwayat lengkap dan audit ber-companyId', async () => {
      const hrd = await hrdA();
      const v = await lowonganTerbuka(hrd);
      const m = await memberStatus();
      const l = (await lamar(m, v.id).expect(201)).body;
      await http('post', `/applications/${l.id}/accept`, hrd).send({}).expect(409); // belum interview
      await http('post', `/applications/${l.id}/stage`, hrd).send({ status: 'INTERVIEW' }).expect(409); // tidak boleh melompat
      await http('post', `/applications/${l.id}/stage`, hrd).send({ status: 'ASAL' }).expect(400);
      await http('post', `/applications/${l.id}/stage`, hrd).send({ status: 'SELEKSI_ADMINISTRASI' }).expect(200);
      await http('post', `/applications/${l.id}/stage`, hrd).send({ status: 'SELEKSI_ADMINISTRASI' }).expect(409);
      await http('post', `/applications/${l.id}/stage`, hrd).send({ status: 'INTERVIEW', note: 'Jadwal sintetis Senin' }).expect(200);
      expect((await http('post', `/applications/${l.id}/accept`, hrd).send({}).expect(200)).body.status).toBe('MENUNGGU_PKWT');
      const det = (await http('get', `/applications/${l.id}`, hrd).expect(200)).body;
      expect(det.status).toBe('MENUNGGU_PKWT');
      expect((det.history as { to: string }[]).map((h) => h.to)).toEqual(expect.arrayContaining(['DIAJUKAN', 'SELEKSI_ADMINISTRASI', 'INTERVIEW', 'DITERIMA', 'MENUNGGU_PKWT']));
      expect(JSON.stringify(det)).not.toMatch(/nik|phone|telepon|address|email/i); // pelamar tanpa NIK/kontak
      expect(det.applicant.fullName).toBe('SINTETIS Pelamar');
      await http('post', `/applications/${l.id}/reject`, hrd).send({ reason: 'Terlambat menolak' }).expect(409);
      await http('post', `/member/applications/${l.id}/withdraw`, m).expect(409);
      for (const aksi of ['stage_changed', 'accepted']) {
        const a = await auditObjek(perusahaanA, `recruitment.application.${aksi}`, l.id);
        expect(a.length).toBeGreaterThan(0);
        expect(a.every((x) => x.company_id === perusahaanA)).toBe(true);
      }
    });

    it('tolak: alasan wajib; dari tahap mana pun yang aktif; tidak dapat diterima setelahnya', async () => {
      const hrd = await hrdA();
      const v = await lowonganTerbuka(hrd);
      const m = await memberStatus();
      const l = (await lamar(m, v.id).expect(201)).body;
      await http('post', `/applications/${l.id}/reject`, hrd).send({}).expect(400);
      await http('post', `/applications/${l.id}/reject`, hrd).send({ reason: 'ab' }).expect(400);
      expect((await http('post', `/applications/${l.id}/reject`, hrd).send({ reason: 'Tidak memenuhi kualifikasi' }).expect(200)).body.status).toBe('DITOLAK');
      await http('post', `/applications/${l.id}/stage`, hrd).send({ status: 'SELEKSI_ADMINISTRASI' }).expect(409);
      await http('post', `/applications/${l.id}/accept`, hrd).send({}).expect(409);
      await http('post', `/applications/${l.id}/reject`, hrd).send({ reason: 'Sekali lagi' }).expect(409);
      await http('post', `/member/applications/${l.id}/withdraw`, m).expect(409);
      expect((await lamar(m, v.id).expect(409)).body.kode).toBe('SUDAH_MELAMAR'); // yang ditolak tetap menghalangi lamaran ulang
    });

    it('pelamar yang sudah menjadi karyawan aktif tidak dapat diterima (409)', async () => {
      const hrd = await hrdA();
      const v = await lowonganTerbuka(hrd);
      const m = await memberStatus();
      const l = (await lamar(m, v.id).expect(201)).body;
      await http('post', `/applications/${l.id}/stage`, hrd).send({ status: 'SELEKSI_ADMINISTRASI' }).expect(200);
      await http('post', `/applications/${l.id}/stage`, hrd).send({ status: 'INTERVIEW' }).expect(200);
      await setStatusMember(m.personId, 'KARYAWAN_AKTIF');
      expect((await http('post', `/applications/${l.id}/accept`, hrd).send({}).expect(409)).body.kode).toBe('PELAMAR_TIDAK_DAPAT_DITERIMA');
      expect((await http('get', `/applications/${l.id}`, hrd).expect(200)).body.status).toBe('INTERVIEW');
    });

    it('lintas perusahaan: staff B tidak melihat/memproses lamaran ke lowongan A (404)', async () => {
      const hA = await hrdA();
      const hB = await buatStaff('HRD', [perusahaanB]);
      const vA = await lowonganTerbuka(hA);
      const m = await memberStatus();
      const l = (await lamar(m, vA.id).expect(201)).body;
      await http('get', `/applications/${l.id}`, hB).expect(404);
      await http('post', `/applications/${l.id}/stage`, hB).send({ status: 'SELEKSI_ADMINISTRASI' }).expect(404);
      await http('post', `/applications/${l.id}/reject`, hB).send({ reason: 'Diretas B' }).expect(404);
      await http('post', `/applications/${l.id}/accept`, hB).send({}).expect(404);
      expect(((await http('get', '/applications?limit=100', hB).expect(200)).body.items as { id: string }[]).map((x) => x.id)).not.toContain(l.id);
      expect((await http('get', `/applications?vacancyId=${vA.id}`, hB).expect(200)).body.items).toEqual([]);
      expect((await http('get', `/applications/${l.id}`, hA).expect(200)).body.status).toBe('DIAJUKAN'); // utuh
      expect(((await http('get', `/applications?vacancyId=${vA.id}`, hA).expect(200)).body.items as { id: string }[]).map((x) => x.id)).toContain(l.id);
    });
  });

  describe('izin per peran (sesuai docs/rbac.md) dan realm', () => {
    // [lihat (V), buat (C), ubah/buka/tutup (U), pindah tahap/tolak (K), terima (A)]
    const izin: Record<string, [boolean, boolean, boolean, boolean, boolean]> = {
      DIREKTUR: [true, false, false, false, false],
      MANAGER_OPERASIONAL: [true, false, false, false, false],
      IT_ADMIN: [false, false, false, false, false],
      HRD: [true, true, true, true, true],
      MARKETING: [true, false, false, false, false],
      STAFF_ADMINISTRASI: [true, false, false, false, false],
      STAFF_PAYROLL_ABSENSI_REKANAN: [false, false, false, false, false],
      STAFF_KEUANGAN: [false, false, false, false, false],
      STAFF_PAYROLL_INTERNAL: [false, false, false, false, false],
    };
    it.each(Object.entries(izin))('%s', async (peranKode, [v, c, u, k, ap]) => {
      const hrd = await hrdA();
      const lw = await lowonganTerbuka(hrd);
      const m = await memberStatus();
      const l = (await lamar(m, lw.id).expect(201)).body;
      const s = await buatStaff(peranKode, [perusahaanA]);
      const cek = async (boleh: boolean, res: request.Test) => {
        const r = await res;
        if (boleh) expect(r.status).not.toBe(403);
        else expect(r.status).toBe(403);
      };
      await cek(v, http('get', '/vacancies', s));
      await cek(v, http('get', `/vacancies/${lw.id}`, s));
      await cek(v, http('get', '/applications', s));
      await cek(v, http('get', `/applications/${l.id}`, s));
      await cek(c, buatLowongan(s));
      await cek(u, http('patch', `/vacancies/${lw.id}`, s).send({ positions: 2 }));
      await cek(u, http('post', `/vacancies/${lw.id}/close`, s));
      await cek(k, http('post', `/applications/${l.id}/stage`, s).send({ status: 'SELEKSI_ADMINISTRASI' }));
      await cek(k, http('post', `/applications/${l.id}/reject`, s).send({ reason: 'uji izin' }));
      await cek(ap, http('post', `/applications/${l.id}/accept`, s).send({}));
    });

    it('mencakup semua peran dan realm dipisahkan: staff tidak dapat memakai rute member, member tidak dapat memakai rute staff, tanpa sesi 401', async () => {
      expect(Object.keys(izin)).toHaveLength(9);
      const hrd = await hrdA();
      const m = await memberStatus();
      await http('get', '/member/vacancies', hrd).expect(403);
      await http('get', '/member/applications', hrd).expect(403);
      await http('get', '/member/eligibility', hrd).expect(403);
      await http('post', '/member/applications', hrd).send({ vacancyId: '00000000-0000-4000-8000-000000000000' }).expect(403);
      await http('get', '/vacancies', m).expect(403);
      await http('get', '/applications', m).expect(403);
      await http('post', '/vacancies', m).send({ title: 'x', description: 'y' }).expect(403);
      await http('get', '/member/vacancies').expect(401);
      await http('post', '/member/applications', m, { tanpaCsrf: true }).send({ vacancyId: '00000000-0000-4000-8000-000000000000' }).expect(403);
    });
  });
});
