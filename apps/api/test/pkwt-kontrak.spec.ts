import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { inflateSync } from 'node:zlib';
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

jalan('alur kontrak PKWT, PDF, dan scan bertanda tangan (PostgreSQL asli)', () => {
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
  const auditObjek = async (company: string, aksi: string, objekId: string) => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.company_ids', $1, true)`, [company]);
      const r = await c.query(`SELECT detail::text AS d, company_id FROM audit_logs WHERE action = $1 AND object_id = $2`, [aksi, objekId]);
      await c.query('ROLLBACK');
      return r.rows as { d: string; company_id: string }[];
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
  const tanganiBuffer = (r: request.Test) => r.buffer(true).parse((res, cb) => { const b: Buffer[] = []; res.on('data', (d) => b.push(d)); res.on('end', () => cb(null, Buffer.concat(b))); });
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

  /** Teks yang digambar di PDF (string heksa operator Tj). */
  const teksPdf = (pdf: Buffer): string => {
    const hasil: string[] = [];
    for (const m of pdf.toString('latin1').matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
      let isi: string;
      try {
        isi = inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1');
      } catch {
        isi = m[1];
      }
      for (const t of isi.matchAll(/<([0-9a-fA-F]+)>\s*Tj/g)) hasil.push(Buffer.from(t[1], 'hex').toString('latin1'));
    }
    return hasil.join('\n').replace(/\u0097/g, '—'); // WinAnsi 0x97 = tanda pisah panjang
  };

  it('prasyarat: aplikasi berjalan sebagai role non-superuser tanpa BYPASSRLS (RLS benar-benar berlaku)', async () => {
    const { POOL } = await import('../src/database/tokens');
    const r = await app.get<Pool>(POOL).query(`SELECT current_user AS u, (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass`);
    expect(r.rows[0]).toEqual({ u: 'hris_app_uji', bypass: false });
  });

  describe('alur PKWT dan pemisahan tugas', () => {
    it('DRAFT -> REVIEW -> PERSETUJUAN -> PENANDATANGANAN -> MENUNGGU_VERIFIKASI_DOKUMEN -> DITANDATANGANI dengan riwayat, versi, dan audit', async () => {
      const p = await pemeranA();
      const pel = await siapPelamar(perusahaanA);
      const tpl = await templateOk(p);
      const k = (await buatKontrak(p.adm, pel.lamaran, tpl).expect(201)).body;
      expect(k.status).toBe('DRAFT');
      expect(k.contractNumber).toMatch(new RegExp(`^[A-Z0-9/.-]+/${tahunMulai}/\\d{4}$`));
      expect(k.currentVersion).toBe(1);
      expect(k.createdBy).toBe(p.adm.userId);
      await http('post', `/pkwt/${k.id}/submit`, p.adm).expect(403); // Adm hanya membuat draf
      await http('post', `/pkwt/${k.id}/review`, p.hrdR).expect(409); // belum diajukan
      await http('post', `/pkwt/${k.id}/submit`, p.hrdU).expect(200);
      await http('post', `/pkwt/${k.id}/submit`, p.hrdU).expect(409);
      await http('post', `/pkwt/${k.id}/approve`, p.dir).expect(409); // belum diperiksa
      expect((await http('post', `/pkwt/${k.id}/review`, p.hrdR).expect(200)).body.status).toBe('PERSETUJUAN');
      expect((await http('post', `/pkwt/${k.id}/approve`, p.dir).expect(200)).body.status).toBe('PENANDATANGANAN');
      await http('post', `/pkwt/${k.id}/approve`, p.dir).expect(409);
      const scan = (await unggahScan(p.hrdU, k.id).expect(201)).body;
      expect(scan.status).toBe('MENUNGGU_VERIFIKASI');
      expect(await statusKontrak(p, k.id)).toBe('MENUNGGU_VERIFIKASI_DOKUMEN');
      expect((await http('post', `/pkwt/${k.id}/documents/${scan.id}/verify`, p.hrdR).expect(200)).body.status).toBe('DITANDATANGANI');
      const det = (await http('get', `/pkwt/${k.id}`, p.hrdR).expect(200)).body;
      expect(det.status).toBe('DITANDATANGANI');
      expect(det.reviewedBy).toBe(p.hrdR.userId);
      expect(det.approvedBy).toBe(p.dir.userId);
      expect((det.history as { to: string }[]).map((h) => h.to).reverse()).toEqual(['DRAFT', 'REVIEW', 'PERSETUJUAN', 'PENANDATANGANAN', 'MENUNGGU_VERIFIKASI_DOKUMEN', 'DITANDATANGANI']);
      expect(det.documents[0].status).toBe('TERVERIFIKASI');
      expect(det.applicantName).toBe(pel.nama);
      expect(JSON.stringify(det)).not.toContain(pel.nik); // tanpa NIK di detail
      for (const aksi of ['created', 'submitted', 'reviewed', 'approved']) expect((await auditObjek(perusahaanA, `pkwt.contract.${aksi}`, k.id)).length).toBe(1);
      expect((await auditObjek(perusahaanA, 'pkwt.document.verified', scan.id)).length).toBe(1);
    });

    it('pemisahan tugas: pembuat tidak dapat memeriksa; pemeriksa tidak dapat menyetujui; pengunggah tidak dapat memverifikasi scan', async () => {
      const p = await pemeranA();
      const pel = await siapPelamar(perusahaanA);
      const tpl = await templateOk(p);
      // pembuat sekaligus HRD (berhak memeriksa) -> tetap ditolak memeriksa kontraknya sendiri
      const hrdPembuat = await buatStaff('HRD', [perusahaanA]);
      await pool.query(`INSERT INTO user_roles (user_id, role_code, grant_source) VALUES ($1, 'STAFF_ADMINISTRASI', 'MANUAL')`, [hrdPembuat.userId]);
      const k = (await buatKontrak(hrdPembuat, pel.lamaran, tpl).expect(201)).body;
      await http('post', `/pkwt/${k.id}/submit`, hrdPembuat).expect(200);
      expect((await http('post', `/pkwt/${k.id}/review`, hrdPembuat).expect(403)).body.kode).toBe('PEMISAHAN_TUGAS');
      expect(await statusKontrak(p, k.id)).toBe('REVIEW');
      // pemeriksa sekaligus Direktur -> tidak dapat menyetujui kontrak yang ia periksa
      const dirPemeriksa = await buatStaff('DIREKTUR', [perusahaanA]);
      await pool.query(`INSERT INTO user_roles (user_id, role_code, grant_source) VALUES ($1, 'HRD', 'MANUAL')`, [dirPemeriksa.userId]);
      await http('post', `/pkwt/${k.id}/review`, dirPemeriksa).expect(200);
      expect((await http('post', `/pkwt/${k.id}/approve`, dirPemeriksa).expect(403)).body.kode).toBe('PEMISAHAN_TUGAS');
      // pembuat yang juga Direktur tidak dapat menyetujui
      const dirPembuat = await buatStaff('DIREKTUR', [perusahaanA]);
      await pool.query(`INSERT INTO user_roles (user_id, role_code, grant_source) VALUES ($1, 'STAFF_ADMINISTRASI', 'MANUAL')`, [dirPembuat.userId]);
      const pel2 = await siapPelamar(perusahaanA);
      const k2 = (await buatKontrak(dirPembuat, pel2.lamaran, tpl).expect(201)).body;
      await http('post', `/pkwt/${k2.id}/submit`, p.hrdU).expect(200);
      await http('post', `/pkwt/${k2.id}/review`, p.hrdR).expect(200);
      expect((await http('post', `/pkwt/${k2.id}/approve`, dirPembuat).expect(403)).body.kode).toBe('PEMISAHAN_TUGAS');
      await http('post', `/pkwt/${k2.id}/approve`, p.dir).expect(200);
      // pengunggah scan tidak dapat memverifikasi/menolaknya sendiri
      const hrdGanda = await buatStaff('HRD', [perusahaanA]);
      const sc = (await unggahScan(hrdGanda, k2.id).expect(201)).body;
      expect((await http('post', `/pkwt/${k2.id}/documents/${sc.id}/verify`, hrdGanda).expect(403)).body.kode).toBe('PEMISAHAN_TUGAS');
      expect((await http('post', `/pkwt/${k2.id}/documents/${sc.id}/reject`, hrdGanda).send({ reason: 'sendiri' }).expect(403)).body.kode).toBe('PEMISAHAN_TUGAS');
      expect(await statusKontrak(p, k2.id)).toBe('MENUNGGU_VERIFIKASI_DOKUMEN');
    });

    it('template belum diverifikasi: kontrak dapat dibuat/diajukan tetapi tidak lolos pemeriksaan (409); setelah diverifikasi lanjut', async () => {
      const p = await pemeranA();
      const pel = await siapPelamar(perusahaanA);
      const t = (await http('post', '/pkwt/templates', p.hrdU).send({ name: `Belum ${randomBytes(3).toString('hex')}`, body: TPL }).expect(201)).body;
      const k = (await buatKontrak(p.adm, pel.lamaran, t.id).expect(201)).body;
      await http('post', `/pkwt/${k.id}/submit`, p.hrdU).expect(200);
      expect((await http('post', `/pkwt/${k.id}/review`, p.hrdR).expect(409)).body.kode).toBe('TEMPLATE_BELUM_DIVERIFIKASI');
      expect(await statusKontrak(p, k.id)).toBe('REVIEW');
      await http('post', `/pkwt/templates/${t.id}/verify`, p.dir).send({ note: 'Diverifikasi ahli hukum (uji)' }).expect(200);
      await http('post', `/pkwt/${k.id}/review`, p.hrdR).expect(200);
    });

    it('tolak review/persetujuan -> kembali DRAFT dengan alasan di riwayat (alasan wajib); ubah DRAFT = versi baru; di luar DRAFT tidak dapat diubah', async () => {
      const p = await pemeranA();
      const pel = await siapPelamar(perusahaanA);
      const tpl = await templateOk(p);
      const k = (await buatKontrak(p.adm, pel.lamaran, tpl).expect(201)).body;
      expect((await http('patch', `/pkwt/${k.id}`, p.hrdU).send({ position: 'Cleaning Service', reason: 'Koreksi jabatan' }).expect(200)).body.currentVersion).toBe(2);
      await http('patch', `/pkwt/${k.id}`, p.hrdU).send({}).expect(400);
      await http('patch', `/pkwt/${k.id}`, p.hrdU).send({ endDate: `${tahunMulai - 1}-01-01` }).expect(400);
      await http('patch', `/pkwt/${k.id}`, p.hrdU).send({ status: 'AKTIF' }).expect(400);
      await http('post', `/pkwt/${k.id}/submit`, p.hrdU).expect(200);
      await http('patch', `/pkwt/${k.id}`, p.hrdU).send({ position: 'Diubah saat review' }).expect(409);
      await http('post', `/pkwt/${k.id}/review/reject`, p.hrdR).send({}).expect(400);
      await http('post', `/pkwt/${k.id}/review/reject`, p.hrdR).send({ reason: 'Tanggal mulai perlu dikoreksi' }).expect(200);
      expect(await statusKontrak(p, k.id)).toBe('DRAFT');
      expect((await http('patch', `/pkwt/${k.id}`, p.hrdU).send({ startDate: `${tahunMulai}-02-01`, reason: 'Sesuai permintaan pemeriksa' }).expect(200)).body.currentVersion).toBe(3);
      await http('post', `/pkwt/${k.id}/submit`, p.hrdU).expect(200);
      await http('post', `/pkwt/${k.id}/review`, p.hrdR).expect(200);
      await http('post', `/pkwt/${k.id}/approve/reject`, p.dir).send({ reason: 'Jabatan tidak sesuai' }).expect(200);
      const det = (await http('get', `/pkwt/${k.id}`, p.hrdR).expect(200)).body;
      expect(det.status).toBe('DRAFT');
      expect(det.reviewedBy).toBeNull(); // pemeriksaan harus diulang
      expect((det.versions as { versionNo: number; reason: string; position: string }[]).map((v) => v.versionNo)).toEqual([3, 2, 1]);
      expect((det.history as { reason: string | null }[]).some((h) => h.reason === 'Tanggal mulai perlu dikoreksi')).toBe(true);
      // versi lama tidak tertimpa
      const v1 = det.versions.find((v: { versionNo: number }) => v.versionNo === 1);
      expect(v1.position).toBe('Satpam');
    });

    it('batalkan dengan alasan dari tahap sebelum ditandatangani; kontrak yang sudah DITANDATANGANI tidak dapat dibatalkan; dibatalkan tidak dapat dicetak/diproses', async () => {
      const p = await pemeranA();
      const tpl = await templateOk(p);
      const k = (await buatKontrak(p.adm, (await siapPelamar(perusahaanA)).lamaran, tpl).expect(201)).body;
      await http('post', `/pkwt/${k.id}/cancel`, p.hrdU).send({}).expect(400);
      await http('post', `/pkwt/${k.id}/cancel`, p.hrdU).send({ reason: 'Pelamar mengundurkan diri' }).expect(200);
      expect(await statusKontrak(p, k.id)).toBe('DIBATALKAN');
      await http('post', `/pkwt/${k.id}/cancel`, p.hrdU).send({ reason: 'Lagi' }).expect(409);
      await http('post', `/pkwt/${k.id}/submit`, p.hrdU).expect(409);
      await http('get', `/pkwt/${k.id}/pdf`, p.hrdU).expect(409);
      const k2 = (await buatKontrak(p.adm, (await siapPelamar(perusahaanA)).lamaran, tpl).expect(201)).body;
      await sampaiDitandatangani(p, k2.id);
      await http('post', `/pkwt/${k2.id}/cancel`, p.hrdU).send({ reason: 'Terlambat' }).expect(409);
    });

    it('pembuatan: lamaran harus MENUNGGU_PKWT, satu kontrak per lamaran, template satu perusahaan dan tidak diarsipkan, member dapat dikontrak', async () => {
      const p = await pemeranA();
      const tpl = await templateOk(p);
      const pel = await siapPelamar(perusahaanA);
      await buatKontrak(p.adm, '00000000-0000-4000-8000-000000000000', tpl).expect(404);
      await buatKontrak(p.adm, pel.lamaran, '00000000-0000-4000-8000-000000000000').expect(404);
      const k = await buatKontrak(p.adm, pel.lamaran, tpl).expect(201);
      expect((await buatKontrak(p.adm, pel.lamaran, tpl).expect(409)).body.kode).toBe('KONTRAK_SUDAH_ADA');
      await http('post', `/pkwt/${k.body.id}/cancel`, p.hrdU).send({ reason: 'Uji dibatalkan' }).expect(200);
      await buatKontrak(p.adm, pel.lamaran, tpl).expect(201); // yang dibatalkan tidak menghalangi
      // lamaran bukan MENUNGGU_PKWT
      const lain = await siapPelamar(perusahaanA);
      await tenant([perusahaanA], async (c) => void (await c.query(`UPDATE job_applications SET status = 'INTERVIEW' WHERE id = $1`, [lain.lamaran])));
      expect((await buatKontrak(p.adm, lain.lamaran, tpl).expect(409)).body.kode).toBe('LAMARAN_BELUM_DITERIMA');
      // member sudah karyawan aktif
      const aktif = await siapPelamar(perusahaanA, 'SINTETIS Aktif', 'KARYAWAN_AKTIF');
      expect((await buatKontrak(p.adm, aktif.lamaran, tpl).expect(409)).body.kode).toBe('PELAMAR_TIDAK_DAPAT_DIKONTRAK');
      // template diarsipkan
      const arsip = await templateOk(p);
      await http('post', `/pkwt/templates/${arsip}/archive`, p.hrdU).expect(200);
      expect((await buatKontrak(p.adm, (await siapPelamar(perusahaanA)).lamaran, arsip).expect(409)).body.kode).toBe('TEMPLATE_DIARSIPKAN');
      // validasi masukan
      const pel2 = await siapPelamar(perusahaanA);
      expect(JSON.stringify((await buatKontrak(p.adm, pel2.lamaran, tpl, { endDate: `${tahunMulai - 1}-01-01` }).expect(400)).body)).toMatch(/sebelum/);
      await buatKontrak(p.adm, pel2.lamaran, tpl, { position: '' }).expect(400);
      await buatKontrak(p.adm, pel2.lamaran, tpl, { startDate: '2026-02-30' }).expect(400);
    });

    it('perpanjangan = kontrak lanjutan bertaut yang melewati alur penuh; hanya dari kontrak berjalan, milik pelamar sama, dan tidak tumpang tindih', async () => {
      const p = await pemeranA();
      const tpl = await templateOk(p);
      const pel = await siapPelamar(perusahaanA);
      const k1 = (await buatKontrak(p.adm, pel.lamaran, tpl).expect(201)).body;
      await buatKontrak(p.adm, pel.lamaran, tpl, { extendsContractId: k1.id, startDate: `${tahunMulai + 1}-01-01`, endDate: `${tahunMulai + 1}-12-31` }).expect(409); // k1 belum ditandatangani
      await sampaiDitandatangani(p, k1.id);
      expect((await buatKontrak(p.adm, pel.lamaran, tpl, { extendsContractId: k1.id, startDate: `${tahunMulai}-12-31`, endDate: `${tahunMulai + 1}-12-31` }).expect(409)).body.kode).toBe('PERIODE_TUMPANG_TINDIH');
      const lain = await siapPelamar(perusahaanA);
      expect((await buatKontrak(p.adm, lain.lamaran, tpl, { extendsContractId: k1.id, startDate: `${tahunMulai + 1}-01-01`, endDate: `${tahunMulai + 1}-12-31` }).expect(409)).body.kode).toBe('KONTRAK_BUKAN_MILIK_PELAMAR');
      const k2 = (await buatKontrak(p.adm, pel.lamaran, tpl, { extendsContractId: k1.id, startDate: `${tahunMulai + 1}-01-01`, endDate: `${tahunMulai + 1}-12-31` }).expect(201)).body;
      expect(k2.extendsContractId).toBe(k1.id);
      expect(k2.contractNumber).not.toBe(k1.contractNumber);
      await sampaiDitandatangani(p, k2.id);
      expect(await statusKontrak(p, k1.id)).toBe('DITANDATANGANI'); // kontrak awal tidak tertimpa
    });

    it('nomor kontrak berurutan unik untuk pembuatan serentak', async () => {
      const p = await pemeranA();
      const tpl = await templateOk(p);
      const pel = await Promise.all([1, 2, 3, 4].map(() => siapPelamar(perusahaanA)));
      const r = await Promise.all(pel.map((x) => buatKontrak(p.adm, x.lamaran, tpl)));
      expect(r.map((x) => x.status)).toEqual([201, 201, 201, 201]);
      const no = r.map((x) => x.body.contractNumber as string);
      expect(new Set(no).size).toBe(4);
    });
  });

  describe('PDF', () => {
    it('PDF berisi variabel terisi (nama/NIK/nomor/tanggal Indonesia) dan HANYA teks template + catatan kaki sistem; NIK tidak ada di audit', async () => {
      const p = await pemeranA();
      const pel = await siapPelamar(perusahaanA, 'SINTETIS Budi Uji');
      const tpl = await templateOk(p);
      const k = (await buatKontrak(p.adm, pel.lamaran, tpl).expect(201)).body;
      const draf = await tanganiBuffer(http('get', `/pkwt/${k.id}/pdf`, p.hrdU)).expect(200);
      expect(draf.headers['content-type']).toMatch(/application\/pdf/);
      expect(draf.headers['cache-control']).toMatch(/no-store/);
      expect(draf.headers['content-disposition']).toMatch(/^attachment/);
      const t1 = teksPdf(draf.body as Buffer).replace(/\n/g, ' '); // teks terbungkus per baris: normalkan
      expect(t1).toContain('SINTETIS Budi Uji');
      expect(t1).toContain(pel.nik);
      expect(t1).toContain(k.contractNumber);
      expect(t1).toContain(`1 Januari ${tahunMulai}`);
      expect(t1).toContain(`31 Desember ${tahunMulai}`);
      expect(t1).toContain('CONTOH UJI — BUKAN DOKUMEN HUKUM');
      expect(t1).toContain('DRAF — belum disetujui');
      expect(t1).toContain('Perusahaan: PT SINTETIS A');
      expect(t1).not.toMatch(/\{\{|\}\}/);
      await sampaiPenandatanganan(p, k.id);
      const resmi = teksPdf((await tanganiBuffer(http('get', `/pkwt/${k.id}/pdf`, p.hrdU)).expect(200)).body as Buffer);
      expect(resmi).toContain('Belum sah sebelum scan bertanda tangan diunggah dan diverifikasi HRD');
      // Tanpa klausul/teks hukum tambahan: seluruh teks PDF = judul + isi template yang dirender + catatan kaki sistem, tidak ada yang lain.
      const namaPt = (await pool.query(`SELECT name FROM companies WHERE id = $1`, [perusahaanA])).rows[0].name as string;
      const rendah = TPL.replace('{{nama}}', pel.nama).replace('{{nik}}', pel.nik).replace('{{nomor}}', k.contractNumber).replace('{{jabatan}}', 'Satpam')
        .replace('{{tanggal_mulai}}', `1 Januari ${tahunMulai}`).replace('{{tanggal_akhir}}', `31 Desember ${tahunMulai}`).replace('{{perusahaan}}', namaPt);
      const harapan = [`Nomor: ${k.contractNumber}`, rendah, 'Dokumen untuk ditandatangani basah. Belum sah sebelum scan bertanda tangan diunggah dan diverifikasi HRD.'].join(' ');
      expect(resmi.replace(/\s+/g, ' ').trim()).toBe(harapan);
      const aud = await auditObjek(perusahaanA, 'pkwt.pdf.generated', k.id);
      expect(aud.length).toBe(2);
      expect(aud.some((a) => a.d.includes(pel.nik) || a.d.includes('Budi'))).toBe(false);
    });

    it('template belum diverifikasi: PDF diberi peringatan; biodata belum lengkap -> 409; hanya pemegang pkwt.export', async () => {
      const p = await pemeranA();
      const t = (await http('post', '/pkwt/templates', p.hrdU).send({ name: `Belum ${randomBytes(3).toString('hex')}`, body: TPL }).expect(201)).body;
      const pel = await siapPelamar(perusahaanA);
      const k = (await buatKontrak(p.adm, pel.lamaran, t.id).expect(201)).body;
      expect(teksPdf((await tanganiBuffer(http('get', `/pkwt/${k.id}/pdf`, p.hrdU)).expect(200)).body as Buffer)).toContain('TEMPLATE BELUM DIVERIFIKASI');
      await http('get', `/pkwt/${k.id}/pdf`, p.adm).expect(403);
      await http('get', `/pkwt/${k.id}/pdf`, p.dir).expect(403);
      await pool.query(`UPDATE member_profiles SET nik_enc = NULL, nik_hmac = NULL, status = 'PROFIL_BELUM_LENGKAP' WHERE person_id = $1`, [pel.person]);
      expect((await http('get', `/pkwt/${k.id}/pdf`, p.hrdU).expect(409)).body.kode).toBe('DATA_PEKERJA_BELUM_LENGKAP');
    });
  });

  describe('templat PKWT alih daya dari draf pemilik (docs/templates/pkwt-alih-daya/isi.txt)', () => {
    const isi = fs.readFileSync(join(__dirname, '../../../docs/templates/pkwt-alih-daya/isi.txt'), 'utf8');
    const ringkas = (b: Buffer) => teksPdf(b).replace(/\s+/g, ' ');

    it('dua perusahaan memakai templat yang SAMA dengan pengaturan PKWT masing-masing; tidak ada kebocoran antar perusahaan; tanpa pengaturan => isian tangan (titik-titik) dan audit hanya memuat NAMA variabel', async () => {
      const pA = await pemeranA();
      const pB = { adm: await buatStaff('STAFF_ADMINISTRASI', [perusahaanB]), hrd: await buatStaff('HRD', [perusahaanB]), dir: await buatStaff('DIREKTUR', [perusahaanB]) };
      await pool.query(`UPDATE companies SET legal_name = 'PT Sintetis Alfa Hukum', address = 'Jl. Alfa 1', city = 'Bandung', province = 'Jawa Barat', document_settings = document_settings || $2::jsonb WHERE id = $1`,
        [perusahaanA, JSON.stringify({ pkwt: { penandatanganNama: 'Penanda Alfa', penandatanganJabatan: 'Personalia', legalitas: ['Akta ALFA-001', 'NIB ALFA-002'], pengadilanNegeri: 'Bandung' } })]);
      await pool.query(`UPDATE companies SET legal_name = 'PT Sintetis Beta Hukum', document_settings = document_settings || $2::jsonb WHERE id = $1`, [perusahaanB, JSON.stringify({ pkwt: { legalitas: ['Akta BETA-001'] } })]);
      const tplA = await templateOk(pA, isi);
      const tplB = (await http('post', '/pkwt/templates', pB.hrd).send({ name: `Alih ${randomBytes(3).toString('hex')}`, body: isi }).expect(201)).body.id as string;
      await http('post', `/pkwt/templates/${tplB}/verify`, pB.dir).send({ note: 'Diverifikasi ahli hukum (uji)' }).expect(200);

      const pelA = await siapPelamar(perusahaanA, 'SINTETIS Alfa Pekerja');
      const kA = (await buatKontrak(pA.adm, pelA.lamaran, tplA).expect(201)).body;
      const a = ringkas((await tanganiBuffer(http('get', `/pkwt/${kA.id}/pdf`, pA.hrdU)).expect(200)).body as Buffer);
      for (const x of ['PT Sintetis Alfa Hukum', 'PT SINTETIS ALFA HUKUM', 'Jl. Alfa 1, Bandung, Jawa Barat', 'a. Akta ALFA-001', 'b. NIB ALFA-002', 'Penanda Alfa', 'selaku Personalia', 'Pengadilan Negeri Bandung', pelA.nik, 'SINTETIS Alfa Pekerja', kA.contractNumber]) expect(a).toContain(x);
      expect(a).not.toMatch(/BETA/i);
      expect(a).not.toMatch(/\{\{|\}\}/);
      expect(a).toContain('PERJANJIAN KERJA WAKTU TERTENTU'); // teks klausul dari draf pemilik, tidak diubah
      expect(a).not.toContain('TEMPLATE BELUM DIVERIFIKASI');

      const pelB = await siapPelamar(perusahaanB, 'SINTETIS Beta Pekerja');
      const kB = (await buatKontrak(pB.adm, pelB.lamaran, tplB).expect(201)).body;
      const b = ringkas((await tanganiBuffer(http('get', `/pkwt/${kB.id}/pdf`, pB.hrd)).expect(200)).body as Buffer);
      for (const x of ['PT Sintetis Beta Hukum', 'PT SINTETIS BETA HUKUM', 'a. Akta BETA-001', 'SINTETIS Beta Pekerja']) expect(b).toContain(x);
      expect(b).not.toMatch(/ALFA/i);
      expect(b).toMatch(/\u0085{5,}/); // penandatangan/alamat/pengguna jasa belum diisi => titik-titik untuk diisi tangan
      await http('get', `/pkwt/${kA.id}/pdf`, pB.hrd).expect(404); // lintas perusahaan tetap 404

      const audA = await auditObjek(perusahaanA, 'pkwt.pdf.generated', kA.id);
      const audB = await auditObjek(perusahaanB, 'pkwt.pdf.generated', kB.id);
      expect(JSON.parse(audA[0].d).isianTangan).toEqual(expect.arrayContaining(['pengguna_jasa', 'alamat_pengguna_jasa']));
      expect(JSON.parse(audA[0].d).isianTangan).not.toContain('penandatangan_nama');
      expect(JSON.parse(audB[0].d).isianTangan).toEqual(expect.arrayContaining(['penandatangan_nama', 'penandatangan_jabatan', 'perusahaan_alamat']));
      expect([...audA, ...audB].some((x) => x.d.includes(pelA.nik) || x.d.includes(pelB.nik) || x.d.includes('Alfa') || x.d.includes('Beta'))).toBe(false);
    });

    it('perusahaan pengguna jasa terisi dari lowongan -> lokasi -> rekanan; templat belum diverifikasi tetap diberi peringatan draf', async () => {
      const pA = await pemeranA();
      const t = (await http('post', '/pkwt/templates', pA.hrdU).send({ name: `Alih ${randomBytes(3).toString('hex')}`, body: isi }).expect(201)).body;
      const pel = await siapPelamar(perusahaanA, 'SINTETIS Penempatan');
      await tenant([perusahaanA], async (c) => {
        const u = (await c.query(`SELECT created_by FROM job_vacancies WHERE id = (SELECT vacancy_id FROM job_applications WHERE id = $1)`, [pel.lamaran])).rows[0].created_by;
        const rek = (await c.query(`INSERT INTO partners (company_id, name, created_by) VALUES ($1, 'Rekanan Pengguna Sintetis', $2) RETURNING id`, [perusahaanA, u])).rows[0].id;
        const lok = (await c.query(`INSERT INTO partner_locations (company_id, partner_id, name, address, city, created_by) VALUES ($1, $2, 'Lokasi Sintetis', 'Jl. Lokasi 9', 'Tangerang', $3) RETURNING id`, [perusahaanA, rek, u])).rows[0].id;
        await c.query(`UPDATE job_vacancies SET location_id = $2 WHERE id = (SELECT vacancy_id FROM job_applications WHERE id = $1)`, [pel.lamaran, lok]);
      });
      const k = (await buatKontrak(pA.adm, pel.lamaran, t.id).expect(201)).body;
      const teks = ringkas((await tanganiBuffer(http('get', `/pkwt/${k.id}/pdf`, pA.hrdU)).expect(200)).body as Buffer);
      expect(teks).toContain('a. Perusahaan : Rekanan Pengguna Sintetis');
      expect(teks).toContain('b. Beralamat di : Jl. Lokasi 9, Tangerang');
      expect(teks).toContain('c. Jenis Pekerjaan : Satpam');
      expect(teks).toContain('TEMPLATE BELUM DIVERIFIKASI');
      const aud = await auditObjek(perusahaanA, 'pkwt.pdf.generated', k.id);
      expect(JSON.parse(aud[0].d).isianTangan).not.toContain('pengguna_jasa');
    });
  });

  describe('scan bertanda tangan', () => {
    it('hanya saat PENANDATANGANAN; berkas palsu/kosong/besar ditolak; tersimpan TERENKRIPSI; unduh terdekripsi untuk pkwt_document.review; ditolak -> unggah ulang -> verifikasi', async () => {
      const p = await pemeranA();
      const pel = await siapPelamar(perusahaanA);
      const tpl = await templateOk(p);
      const k = (await buatKontrak(p.adm, pel.lamaran, tpl).expect(201)).body;
      await unggahScan(p.hrdU, k.id).expect(409); // belum waktunya
      await sampaiPenandatanganan(p, k.id);
      await unggahScan(p.hrdU, k.id, Buffer.from('MZ\x90\x00\x03' + 'x'.repeat(40))).expect(415);
      await unggahScan(p.hrdU, k.id, Buffer.alloc(0)).expect(400);
      await unggahScan(p.hrdU, k.id, Buffer.concat([PDF_SCAN, Buffer.alloc(10 * 1024 * 1024)])).expect(413);
      await http('post', `/pkwt/${k.id}/documents`, p.hrdU).expect(400); // tanpa berkas
      await http('post', `/pkwt/${k.id}/documents`, p.hrdU, { tanpaCsrf: true }).attach('berkas', PDF_SCAN, 's.pdf').expect(403);
      expect(await statusKontrak(p, k.id)).toBe('PENANDATANGANAN');
      const d = (await unggahScan(p.hrdU, k.id).expect(201)).body;
      expect(JSON.stringify(d)).not.toMatch(/object_key|objectKey|hris-pkwt/);
      const key = (await tenant([perusahaanA], async (c) => (await c.query(`SELECT object_key, sha256 FROM contract_documents WHERE id = $1`, [d.id])).rows[0])) as { object_key: string; sha256: Buffer };
      expect(key.object_key.startsWith(`${perusahaanA}/`)).toBe(true);
      expect(key.sha256).toHaveLength(32);
      const mentah = fs.readFileSync(join(STORAGE, key.object_key));
      expect(mentah.includes(Buffer.from('SCAN-TTD-SINTETIS-RAHASIA-UJI'))).toBe(false);
      await unggahScan(p.hrdU, k.id).expect(409); // sudah menunggu verifikasi
      const dl = await tanganiBuffer(http('get', `/pkwt/${k.id}/documents/${d.id}/download`, p.hrdR)).expect(200);
      expect(Buffer.compare(dl.body as Buffer, PDF_SCAN)).toBe(0);
      expect(dl.headers['content-disposition']).toMatch(/^attachment/);
      expect((await auditObjek(perusahaanA, 'pkwt.document.downloaded', d.id)).length).toBe(1);
      for (const s of [p.dir, p.adm]) await http('get', `/pkwt/${k.id}/documents/${d.id}/download`, s).expect(403);
      await http('post', `/pkwt/${k.id}/documents/${d.id}/reject`, p.hrdR).send({}).expect(400);
      await http('post', `/pkwt/${k.id}/documents/${d.id}/reject`, p.hrdR).send({ reason: 'Tanda tangan tidak terbaca' }).expect(200);
      expect(await statusKontrak(p, k.id)).toBe('PENANDATANGANAN');
      const det = (await http('get', `/pkwt/${k.id}`, p.hrdR).expect(200)).body;
      expect(det.documents[0].status).toBe('DITOLAK');
      expect(det.documents[0].rejectReason).toBe('Tanda tangan tidak terbaca');
      const d2 = (await unggahScan(p.hrdU, k.id).expect(201)).body;
      expect((await http('post', `/pkwt/${k.id}/documents/${d.id}/verify`, p.hrdR).expect(409)).body.kode).toBe('DOKUMEN_SUDAH_DIPUTUSKAN'); // dokumen lama sudah ditolak
      await http('post', `/pkwt/${k.id}/documents/${d2.id}/verify`, p.hrdR).expect(200);
      expect(await statusKontrak(p, k.id)).toBe('DITANDATANGANI');
      await unggahScan(p.hrdU, k.id).expect(409);
    });

    it('dokumen kontrak lain tidak dapat dipakai lewat ID kontrak yang salah (404)', async () => {
      const p = await pemeranA();
      const tpl = await templateOk(p);
      const a = (await buatKontrak(p.adm, (await siapPelamar(perusahaanA)).lamaran, tpl).expect(201)).body;
      const b = (await buatKontrak(p.adm, (await siapPelamar(perusahaanA)).lamaran, tpl).expect(201)).body;
      await sampaiPenandatanganan(p, a.id);
      await sampaiPenandatanganan(p, b.id);
      const da = (await unggahScan(p.hrdU, a.id).expect(201)).body;
      await unggahScan(p.hrdU, b.id).expect(201); // b juga menunggu verifikasi: pencarian dokumen yang menentukan
      await http('get', `/pkwt/${b.id}/documents/${da.id}/download`, p.hrdR).expect(404);
      await http('post', `/pkwt/${b.id}/documents/${da.id}/verify`, p.hrdR).expect(404);
    });
  });

  describe('isolasi lintas perusahaan', () => {
    it('staff B tidak melihat/memproses kontrak, template, dan dokumen A (404); membuat kontrak dari lamaran A ditolak', async () => {
      const p = await pemeranA();
      const tpl = await templateOk(p);
      const k = (await buatKontrak(p.adm, (await siapPelamar(perusahaanA)).lamaran, tpl).expect(201)).body;
      await sampaiPenandatanganan(p, k.id);
      const d = (await unggahScan(p.hrdU, k.id).expect(201)).body;
      const pB = { adm: await buatStaff('STAFF_ADMINISTRASI', [perusahaanB]), hrd: await buatStaff('HRD', [perusahaanB]), dir: await buatStaff('DIREKTUR', [perusahaanB]) };
      await http('get', `/pkwt/${k.id}`, pB.hrd).expect(404);
      await http('patch', `/pkwt/${k.id}`, pB.hrd).send({ position: 'Diretas' }).expect(404);
      for (const aksi of ['submit', 'review', 'approve']) await http('post', `/pkwt/${k.id}/${aksi}`, aksi === 'approve' ? pB.dir : pB.hrd).expect(404);
      await http('post', `/pkwt/${k.id}/cancel`, pB.hrd).send({ reason: 'Lintas perusahaan' }).expect(404);
      await http('get', `/pkwt/${k.id}/pdf`, pB.hrd).expect(404);
      await http('get', `/pkwt/${k.id}/documents`, pB.hrd).expect(404);
      await http('get', `/pkwt/${k.id}/documents/${d.id}/download`, pB.hrd).expect(404);
      await http('post', `/pkwt/${k.id}/documents/${d.id}/verify`, pB.hrd).expect(404);
      await unggahScan(pB.hrd, k.id).expect(404);
      await buatKontrak(pB.adm, (await siapPelamar(perusahaanA)).lamaran, tpl).expect(404); // lamaran perusahaan A
      expect(((await http('get', '/pkwt?limit=100', pB.hrd).expect(200)).body.items as { id: string }[]).map((x) => x.id)).not.toContain(k.id);
      expect((await http('get', `/pkwt?applicationId=${k.applicationId}`, pB.hrd).expect(200)).body.items).toEqual([]);
      expect(await statusKontrak(p, k.id)).toBe('MENUNGGU_VERIFIKASI_DOKUMEN'); // utuh
    });

    it('template perusahaan lain tidak dapat dipakai (404)', async () => {
      const p = await pemeranA();
      const hrdB = await buatStaff('HRD', [perusahaanB]);
      const dirB = await buatStaff('DIREKTUR', [perusahaanB]);
      const tB = (await http('post', '/pkwt/templates', hrdB).send({ name: `B ${randomBytes(3).toString('hex')}`, body: TPL }).expect(201)).body;
      await http('post', `/pkwt/templates/${tB.id}/verify`, dirB).send({ note: 'Diverifikasi ahli hukum (uji)' }).expect(200);
      await buatKontrak(p.adm, (await siapPelamar(perusahaanA)).lamaran, tB.id).expect(404);
    });

    it('keyset daftar kontrak: tanpa duplikat; filter status; batas dan kursor divalidasi', async () => {
      const p = await pemeranA();
      const tpl = await templateOk(p);
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) ids.push((await buatKontrak(p.adm, (await siapPelamar(perusahaanA)).lamaran, tpl).expect(201)).body.id);
      const lihat = new Set<string>();
      let kursor: string | null = null;
      let n = 0;
      do {
        const r: request.Response = await http('get', `/pkwt?limit=2&status=DRAFT${kursor ? `&cursor=${kursor}` : ''}`, p.hrdU).expect(200);
        for (const x of r.body.items as { id: string }[]) {
          expect(lihat.has(x.id)).toBe(false);
          lihat.add(x.id);
        }
        kursor = r.body.nextCursor;
        n++;
      } while (kursor && n < 80);
      for (const id of ids) expect(lihat.has(id)).toBe(true);
      await http('get', '/pkwt?limit=101', p.hrdU).expect(400);
      await http('get', '/pkwt?status=ASAL', p.hrdU).expect(400);
      await http('get', '/pkwt?cursor=bukan-kursor', p.hrdU).expect(400);
    });
  });

  describe('izin per peran (sesuai docs/rbac.md)', () => {
    // [lihat, buat (C), ubah/ajukan/batal/unggah (U), periksa (K), setujui (A), cetak PDF (E), dokumen (pkwt_document.review)]
    const izin: Record<string, [boolean, boolean, boolean, boolean, boolean, boolean, boolean]> = {
      DIREKTUR: [true, false, false, false, true, false, false],
      MANAGER_OPERASIONAL: [true, false, false, false, false, false, false],
      IT_ADMIN: [false, false, false, false, false, false, false],
      HRD: [true, true, true, true, false, true, true],
      MARKETING: [false, false, false, false, false, false, false],
      STAFF_ADMINISTRASI: [true, true, false, false, false, false, false],
      STAFF_PAYROLL_ABSENSI_REKANAN: [true, false, false, false, false, false, false],
      STAFF_KEUANGAN: [true, false, false, false, false, false, false],
      STAFF_PAYROLL_INTERNAL: [false, false, false, false, false, false, false],
    };
    it.each(Object.entries(izin))('%s', async (peranKode, [v, c, u, k, ap, e, dok]) => {
      const p = await pemeranA();
      const tpl = await templateOk(p);
      const kon = (await buatKontrak(p.adm, (await siapPelamar(perusahaanA)).lamaran, tpl).expect(201)).body;
      const s = await buatStaff(peranKode, [perusahaanA]);
      const cek = async (boleh: boolean, res: request.Test) => {
        const r = await res;
        if (boleh) expect(r.status).not.toBe(403);
        else expect(r.status).toBe(403);
      };
      await cek(v, http('get', '/pkwt', s));
      await cek(v, http('get', `/pkwt/${kon.id}`, s));
      await cek(v, http('get', `/pkwt/${kon.id}/documents`, s));
      await cek(c, buatKontrak(s, (await siapPelamar(perusahaanA)).lamaran, tpl));
      await cek(u, http('patch', `/pkwt/${kon.id}`, s).send({ position: 'Uji izin' }));
      await cek(u, http('post', `/pkwt/${kon.id}/submit`, s));
      await cek(u, http('post', `/pkwt/${kon.id}/cancel`, s).send({ reason: 'uji izin' }));
      await cek(u, unggahScan(s, kon.id));
      await cek(k, http('post', `/pkwt/${kon.id}/review`, s));
      await cek(k, http('post', `/pkwt/${kon.id}/review/reject`, s).send({ reason: 'uji izin' }));
      await cek(ap, http('post', `/pkwt/${kon.id}/approve`, s));
      await cek(ap, http('post', `/pkwt/${kon.id}/approve/reject`, s).send({ reason: 'uji izin' }));
      await cek(e, http('get', `/pkwt/${kon.id}/pdf`, s));
      await cek(dok, http('get', `/pkwt/${kon.id}/documents/${randomUUID()}/download`, s));
      await cek(dok, http('post', `/pkwt/${kon.id}/documents/${randomUUID()}/verify`, s));
      await cek(dok, http('post', `/pkwt/${kon.id}/documents/${randomUUID()}/reject`, s).send({ reason: 'uji izin' }));
    });

    it('mencakup semua peran; tanpa sesi 401; member tidak dapat memakai rute staff', async () => {
      expect(Object.keys(izin)).toHaveLength(9);
      await http('get', '/pkwt').expect(401);
      const person = (await pool.query(`INSERT INTO persons (display_name) VALUES ('SINTETIS Member') RETURNING id`)).rows[0].id as string;
      const u = (await pool.query(`INSERT INTO users (person_id, realm, email, status) VALUES ($1, 'member', $2, 'AKTIF') RETURNING id`, [person, `m-${randomBytes(4).toString('hex')}@contoh.invalid`])).rows[0].id as string;
      const ss = await sessions.buat({ userId: u, realm: 'member', state: 'PENUH' });
      await http('get', '/pkwt', { cookie: `__Host-sid=${ss.token}`, csrf: ss.csrfToken }).expect(403);
    });
  });
});
