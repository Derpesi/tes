import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { generateSync } from 'otplib';
import { Pool } from 'pg';
import request from 'supertest';
import { enkripsi } from '../src/common/crypto/crypto';
import type { PesanEmail } from '../src/notifications/templates';

const DB_URL = process.env.TEST_DATABASE_URL;
const jalan = DB_URL ? describe : describe.skip;

const ORIGIN = 'https://hris.contoh.invalid';
process.env.APP_BASE_URL = ORIGIN;
process.env.AUTH_HMAC_KEY = randomBytes(32).toString('base64');
process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString('base64');
process.env.TRUST_PROXY = '1';

const PASSWORD = 'kuda lari malam hari di sawah';
const ROLES = ['DIREKTUR', 'MANAGER_OPERASIONAL', 'IT_ADMIN', 'HRD', 'MARKETING', 'STAFF_ADMINISTRASI', 'STAFF_PAYROLL_ABSENSI_REKANAN', 'STAFF_KEUANGAN', 'STAFF_PAYROLL_INTERNAL'];

interface Sesi {
  cookie: string;
  csrf: string;
}
interface Staff extends Sesi {
  userId: string;
  email: string;
  secret: string;
}

jalan('Master perusahaan dan dokumen legalitas (PostgreSQL asli)', () => {
  let app: INestApplication;
  let pool: Pool;
  let passwordHash: string;
  let encKey: Buffer;
  let perusahaanA: string;
  let perusahaanB: string;
  const terkirim: PesanEmail[] = [];
  let nomorIp = 1;

  beforeAll(async () => {
    execFileSync('node', ['scripts/migrate.js', 'up'], { env: { ...process.env, DATABASE_URL: DB_URL } });
    // Syarat produksi (ADR-0003): aplikasi berjalan sebagai role NON-superuser tanpa BYPASSRLS. Superuser mem-bypass RLS,
    // sehingga di CI (user DB = superuser) aplikasi dijalankan lewat role uji agar tes scope audit bermakna.
    const admin = new Pool({ connectionString: DB_URL, max: 1 });
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hris_app_uji') THEN CREATE ROLE hris_app_uji NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$`);
    await admin.query(`GRANT hris_app_uji TO CURRENT_USER`);
    await admin.query(`GRANT ALL ON ALL TABLES IN SCHEMA public TO hris_app_uji`);
    await admin.query(`GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO hris_app_uji`);
    await admin.end();
    process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), 'hris-uji-'));
    process.env.DATABASE_URL = `${DB_URL}${DB_URL!.includes('?') ? '&' : '?'}options=${encodeURIComponent('-c role=hris_app_uji')}`;
    const { AppModule } = await import('../src/app.module');
    const { konfigurasiApp } = await import('../src/app.factory');
    const { EMAIL_CHANNEL } = await import('../src/notifications/email.channel');
    const { PasswordService } = await import('../src/auth/password.service');
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EMAIL_CHANNEL)
      .useValue({ tersedia: () => true, kirim: async (p: PesanEmail) => void terkirim.push(p) })
      .compile();
    app = mod.createNestApplication();
    konfigurasiApp(app);
    await app.init();
    passwordHash = await app.get(PasswordService).hash(PASSWORD);
    encKey = Buffer.from(process.env.APP_ENCRYPTION_KEY!, 'base64');
    pool = new Pool({ connectionString: DB_URL, max: 4 }); // koneksi pemilik: hanya untuk menyiapkan/memeriksa data
    await pool.query(`UPDATE notification_outbox SET status = 'GAGAL', payload_enc = NULL WHERE status = 'MENUNGGU'`); // sisa run sebelumnya
    const a = await pool.query(`INSERT INTO companies (name) VALUES ($1) RETURNING id`, [`PT SINTETIS A ${randomBytes(3).toString('hex')}`]);
    const b = await pool.query(`INSERT INTO companies (name) VALUES ($1) RETURNING id`, [`PT SINTETIS B ${randomBytes(3).toString('hex')}`]);
    perusahaanA = a.rows[0].id;
    perusahaanB = b.rows[0].id;
  });
  afterAll(async () => {
    await pool?.end();
    await app?.close();
  });
  beforeEach(() => {
    terkirim.length = 0;
  });

  // ---------- helper ----------
  const ipBaru = () => `10.40.${Math.floor(nomorIp / 250)}.${(nomorIp++ % 250) + 1}`;
  const emailBaru = () => `rbac-${randomBytes(4).toString('hex')}@contoh.invalid`;
  const kodeBerikut = (secret: string) => generateSync({ secret, epoch: Math.floor(Date.now() / 1000) + 30 });
  const cookieNamed = (res: request.Response, nama: string) => ((res.headers['set-cookie'] as unknown as string[] | undefined)?.find((x) => x.startsWith(`${nama}=`)) ?? '').split(';')[0];

  /** Membuat staff AKTIF (kredensial + TOTP aktif) dengan peran/scope lewat SQL. */
  async function buatStaffSql(roles: string[], o: { companyIds?: string[]; allCompanies?: boolean; bootstrap?: boolean; expiresAt?: string | null } = {}) {
    const email = emailBaru();
    const secret = generateSecretSintetis();
    const p = await pool.query(`INSERT INTO persons (display_name) VALUES ('SINTETIS Staff') RETURNING id`);
    const u = await pool.query(`INSERT INTO users (person_id, realm, email, status, all_companies) VALUES ($1, 'staff', $2, 'AKTIF', $3) RETURNING id`, [p.rows[0].id, email, o.allCompanies ?? false]);
    const userId = u.rows[0].id as string;
    await pool.query(`INSERT INTO staff_credentials (user_id, password_hash) VALUES ($1, $2)`, [userId, passwordHash]);
    await pool.query(`INSERT INTO staff_mfa_factors (user_id, secret_enc, status, confirmed_at) VALUES ($1, $2, 'AKTIF', now())`, [userId, enkripsi(secret, encKey, `mfa:${userId}`)]);
    for (const r of roles) {
      await pool.query(`INSERT INTO user_roles (user_id, role_code, grant_source, expires_at) VALUES ($1, $2, $3, $4)`, [userId, r, o.bootstrap ? 'BOOTSTRAP' : 'MANUAL', o.expiresAt ?? null]);
    }
    for (const c of o.companyIds ?? []) await pool.query(`INSERT INTO user_company_scopes (user_id, scope_company_id) VALUES ($1, $2)`, [userId, c]);
    return { userId, email, secret };
  }
  function generateSecretSintetis(): string {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('otplib') as typeof import('otplib')).generateSecret();
  }
  async function masuk(email: string, secret: string, password = PASSWORD): Promise<Sesi> {
    const l = await http('post', '/auth/staff/login').send({ email, password }).expect(200);
    const c = cookieNamed(l, '__Host-sid');
    const v = await http('post', '/auth/staff/mfa/verify', { cookie: c, csrf: l.body.csrfToken }).send({ code: kodeBerikut(secret) }).expect(200);
    return { cookie: cookieNamed(v, '__Host-sid'), csrf: v.body.csrfToken };
  }
  async function buatStaffMasuk(roles: string[], o: Parameters<typeof buatStaffSql>[1] = {}): Promise<Staff> {
    const s = await buatStaffSql(roles, o);
    return { ...s, ...(await masuk(s.email, s.secret)) };
  }
  const http = (metode: 'get' | 'post' | 'delete' | 'patch', path: string, o: { cookie?: string; csrf?: string; origin?: string | null } = {}) => {
    let r = request(app.getHttpServer())[metode](path).set('X-Forwarded-For', ipBaru());
    if (o.origin !== null) r = r.set('Origin', o.origin ?? ORIGIN);
    if (o.cookie) r = r.set('Cookie', o.cookie);
    if (o.csrf) r = r.set('X-CSRF-Token', o.csrf);
    return r;
  };
  const api = (s: Sesi, metode: 'get' | 'post' | 'delete' | 'patch', path: string, body?: unknown) => {
    const r = http(metode, path, { cookie: s.cookie, csrf: s.csrf });
    return body === undefined ? r : r.send(body as object);
  };
  const bacaAuditSql = async (aksi: string, userId?: string) => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.audit_global', 'on', true)`);
      await c.query(`SELECT set_config('app.company_ids', $1, true)`, [[perusahaanA, perusahaanB].join(',')]); // entri ber-company_id hanya terbaca dengan scope-nya
      const r = await c.query(`SELECT detail::text AS d, actor_id FROM audit_logs WHERE action = $1 ${userId ? `AND (actor_id::text = $2 OR object_id = $2)` : ''}`, userId ? [aksi, userId] : [aksi]);
      await c.query('ROLLBACK');
      return r.rows as { d: string; actor_id: string | null }[];
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  };


  const kodeBaru = () => `T${randomBytes(4).toString('hex').toUpperCase()}`;
  const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  const buatPerusahaan = (s: Sesi, kode = kodeBaru()) => api(s, 'post', '/companies', { name: `PT SINTETIS ${kode}`, shortCode: kode });
  const unggah = (s: Sesi, companyId: string, berkas: Buffer | null, nama = 'akta.pdf', kolom: Record<string, string> = { kind: 'NIB', title: 'NIB sintetis' }) => {
    let r = http('post', `/companies/${companyId}/documents`, { cookie: s.cookie, csrf: s.csrf });
    for (const [k, v] of Object.entries(kolom)) r = r.field(k, v);
    return berkas ? r.attach('berkas', berkas, nama) : r;
  };

  describe('aktivasi perusahaan baru (tanpa ubah kode)', () => {
    it('IT membuat perusahaan nonaktif; baru berlaku setelah Direktur menyetujui; IT tidak dapat menyetujui sendiri', async () => {
      const it = await buatStaffMasuk(['IT_ADMIN']);
      const dir = await buatStaffMasuk(['DIREKTUR'], { allCompanies: true });
      const kode = kodeBaru();
      const res = await buatPerusahaan(it, kode).expect(201);
      expect(res.body.status).toBe('MENUNGGU_PERSETUJUAN');
      const id = res.body.id as string;
      expect((await pool.query(`SELECT active FROM companies WHERE id = $1`, [id])).rows[0].active).toBe(false);
      // pembuat melihat perusahaan pending-nya; staf lain tanpa scope tidak (404, bukan 403)
      await api(it, 'get', `/companies/${id}`).expect(200);
      await api(await buatStaffMasuk(['HRD']), 'get', `/companies/${id}`).expect(404);
      // IT tidak berwenang menyetujui; Direktur berwenang
      await api(it, 'post', `/approvals/${res.body.approvalId}/approve`, {}).expect(403);
      expect((await pool.query(`SELECT active FROM companies WHERE id = $1`, [id])).rows[0].active).toBe(false);
      await api(dir, 'post', `/approvals/${res.body.approvalId}/approve`, {}).expect(200);
      expect((await pool.query(`SELECT active FROM companies WHERE id = $1`, [id])).rows[0].active).toBe(true);
      await api(dir, 'post', `/approvals/${res.body.approvalId}/approve`, {}).expect(409);
      expect((await bacaAuditSql('master.company.created', it.userId)).length).toBeGreaterThan(0);
      expect((await bacaAuditSql('master.company.activated')).length).toBeGreaterThan(0);
    });

    it('penolakan aktivasi menjaga perusahaan tetap nonaktif', async () => {
      const it = await buatStaffMasuk(['IT_ADMIN']);
      const dir = await buatStaffMasuk(['DIREKTUR'], { allCompanies: true });
      const res = await buatPerusahaan(it).expect(201);
      await api(dir, 'post', `/approvals/${res.body.approvalId}/reject`, { note: 'data belum lengkap' }).expect(200);
      expect((await pool.query(`SELECT active FROM companies WHERE id = $1`, [res.body.id])).rows[0].active).toBe(false);
    });

    it('kode singkat unik (409) dan validasi berpesan Indonesia (400)', async () => {
      const it = await buatStaffMasuk(['IT_ADMIN']);
      const kode = kodeBaru();
      await buatPerusahaan(it, kode).expect(201);
      const dup = await buatPerusahaan(it, kode).expect(409);
      expect(dup.body.kode).toBe('KODE_PERUSAHAAN_SUDAH_ADA');
      const buruk = await api(it, 'post', '/companies', { name: '', shortCode: 'x', npwp: '123', email: 'bukan-email', phone: 'abc' }).expect(400);
      expect(JSON.stringify(buruk.body)).toMatch(/wajib|NPWP|email|telepon|Kode singkat/i);
    });
  });

  describe('scope dan izin per peran', () => {
    it('pengguna scope A tidak melihat, mengubah, atau menonaktifkan perusahaan B (selalu 404)', async () => {
      const it = await buatStaffMasuk(['IT_ADMIN'], { companyIds: [perusahaanA] });
      const dir = await buatStaffMasuk(['DIREKTUR'], { companyIds: [perusahaanA] });
      expect((await api(it, 'get', `/companies/${perusahaanA}`).expect(200)).body.id).toBe(perusahaanA);
      await api(it, 'get', `/companies/${perusahaanB}`).expect(404);
      await api(it, 'patch', `/companies/${perusahaanB}`, { city: 'Jakarta' }).expect(404);
      await api(dir, 'post', `/companies/${perusahaanB}/deactivate`).expect(404);
      const daftar = await api(it, 'get', '/companies').expect(200);
      const ids = (daftar.body.items as { id: string }[]).map((x) => x.id);
      expect(ids).toContain(perusahaanA);
      expect(ids).not.toContain(perusahaanB);
      expect((await pool.query(`SELECT city FROM companies WHERE id = $1`, [perusahaanB])).rows[0].city).toBeNull();
    });

    it('ubah profil: pengaturan divalidasi ketat dan digabung; audit memuat nama bidang saja', async () => {
      const it = await buatStaffMasuk(['IT_ADMIN'], { companyIds: [perusahaanA] });
      await api(it, 'patch', `/companies/${perusahaanA}`, { payrollSettings: { cutOffDay: 31 } }).expect(400);
      await api(it, 'patch', `/companies/${perusahaanA}`, { payrollSettings: { gajiPokok: 1 } }).expect(400);
      await api(it, 'patch', `/companies/${perusahaanA}`, {}).expect(400);
      const ok = await api(it, 'patch', `/companies/${perusahaanA}`, { city: 'Bandung', payrollSettings: { cutOffDay: 25 } }).expect(200);
      expect(ok.body.city).toBe('Bandung');
      expect(ok.body.payrollSettings.cutOffDay).toBe(25);
      const aud = await bacaAuditSql('master.company.updated', it.userId);
      expect(aud.some((x) => x.d.includes('Bandung'))).toBe(false);
    });

    it('pengaturan PKWT (penandatangan, kota, legalitas): divalidasi, digabung tanpa menghapus pengaturan lain, dan audit memuat nama bidang saja', async () => {
      const it = await buatStaffMasuk(['IT_ADMIN'], { companyIds: [perusahaanA] });
      await api(it, 'patch', `/companies/${perusahaanA}`, { documentSettings: { contractNumberPrefix: 'KTR' } }).expect(200);
      for (const buruk of [{ legalitas: Array.from({ length: 11 }, () => 'x') }, { legalitas: ['x'.repeat(301)] }, { penandatanganNama: '' }, { klausul: 'bebas' }]) {
        const r = await api(it, 'patch', `/companies/${perusahaanA}`, { documentSettings: { pkwt: buruk } }).expect(400);
        expect(JSON.stringify(r.body)).toMatch(/[A-Za-z]/);
      }
      const ok = await api(it, 'patch', `/companies/${perusahaanA}`, { documentSettings: { pkwt: { penandatanganNama: 'Rahasia Penanda Sintetis', penandatanganJabatan: 'Personalia', kota: 'Bandung', legalitas: ['Akta Sintetis RAHASIA-123'] } } }).expect(200);
      expect(ok.body.documentSettings.pkwt).toMatchObject({ penandatanganNama: 'Rahasia Penanda Sintetis', legalitas: ['Akta Sintetis RAHASIA-123'] });
      expect(ok.body.documentSettings.contractNumberPrefix).toBe('KTR'); // pengaturan lain tidak hilang
      const aud = await bacaAuditSql('master.company.updated', it.userId);
      expect(aud.some((x) => x.d.includes('RAHASIA') || x.d.includes('Rahasia Penanda'))).toBe(false);
      // perusahaan lain tidak terpengaruh dan tidak dapat diubah dari scope A
      await api(it, 'patch', `/companies/${perusahaanB}`, { documentSettings: { pkwt: { kota: 'X' } } }).expect(404);
    });

    const matriks: { izin: string; peran: string; metode: 'get' | 'post' | 'patch'; path: () => string; body?: object }[] = [];
    for (const r of ROLES.filter((x) => x !== 'IT_ADMIN')) matriks.push({ izin: 'company.create', peran: r, metode: 'post', path: () => '/companies', body: { name: 'PT SINTETIS X', shortCode: 'XX' } });
    for (const r of ['HRD', 'MARKETING', 'STAFF_PAYROLL_ABSENSI_REKANAN', 'STAFF_PAYROLL_INTERNAL', 'MANAGER_OPERASIONAL']) {
      matriks.push({ izin: 'company_document.view', peran: r, metode: 'get', path: () => `/companies/${perusahaanA}/documents` });
    }
    for (const r of ['DIREKTUR', 'MANAGER_OPERASIONAL', 'HRD', 'MARKETING']) matriks.push({ izin: 'company.update', peran: r, metode: 'patch', path: () => `/companies/${perusahaanA}`, body: { city: 'X' } });
    it.each(matriks)('$peran ditolak 403 pada $izin', async (m) => {
      const s = await buatStaffMasuk([m.peran], { companyIds: [perusahaanA] });
      await api(s, m.metode, m.path(), m.body).expect(403);
    });
  });

  describe('dokumen legalitas', () => {
    it('unggah PDF sah, daftar, unduh terkontrol, hapus lunak; respons tanpa kunci objek; semua diaudit', async () => {
      const it = await buatStaffMasuk(['IT_ADMIN'], { companyIds: [perusahaanA] });
      const up = await unggah(it, perusahaanA, PDF).expect(201);
      expect(JSON.stringify(up.body)).not.toMatch(/object_key|objectKey|STORAGE|\/tmp/);
      expect(up.body.mimeType).toBe('application/pdf');
      const dl = await http('get', `/companies/${perusahaanA}/documents/${up.body.id}/download`, { cookie: it.cookie }).buffer(true).parse((r, cb) => { const k: Buffer[] = []; r.on('data', (d) => k.push(d)); r.on('end', () => cb(null, Buffer.concat(k))); }).expect(200);
      expect(Buffer.compare(dl.body as Buffer, PDF)).toBe(0);
      expect(dl.headers['content-disposition']).toMatch(/^attachment/);
      expect(dl.headers['x-content-type-options']).toBe('nosniff');
      expect(dl.headers['cache-control']).toMatch(/no-store/);
      expect((await bacaAuditSql('master.company_document.downloaded', it.userId)).length).toBeGreaterThan(0);
      const adm = await buatStaffMasuk(['STAFF_ADMINISTRASI'], { companyIds: [perusahaanA] });
      expect(((await api(adm, 'get', `/companies/${perusahaanA}/documents`).expect(200)).body.items as { id: string }[]).some((x) => x.id === up.body.id)).toBe(true);
      await api(it, 'delete', `/companies/${perusahaanA}/documents/${up.body.id}`).expect(204);
      await http('get', `/companies/${perusahaanA}/documents/${up.body.id}/download`, { cookie: it.cookie }).expect(404);
    });

    it.each([
      ['berkas executable bernama .pdf', Buffer.from('MZ\x90\x00\x03' + 'x'.repeat(40)), 'akta.pdf', 415],
      ['PNG bernama .pdf (ekstensi tidak sesuai)', PNG, 'akta.pdf', 400],
      ['berkas kosong', Buffer.alloc(0), 'akta.pdf', 400],
      ['lebih dari 10 MB', Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024)]), 'akta.pdf', 413],
    ])('menolak %s', async (_n, isi, nama, status) => {
      const it = await buatStaffMasuk(['IT_ADMIN'], { companyIds: [perusahaanA] });
      await unggah(it, perusahaanA, isi, nama).expect(status);
    });

    it('menolak tanpa berkas dan kolom tidak sah; nama berkas traversal disanitasi', async () => {
      const it = await buatStaffMasuk(['IT_ADMIN'], { companyIds: [perusahaanA] });
      await unggah(it, perusahaanA, null).expect(400);
      await unggah(it, perusahaanA, PDF, 'akta.pdf', { kind: 'RAHASIA', title: 'x' }).expect(400);
      const ok = await unggah(it, perusahaanA, PDF, '../../etc/passwd.pdf').expect(201);
      expect(ok.body.originalFilename).not.toMatch(/\.\.|\//);
    });

    it('lintas perusahaan: unggah, daftar, dan unduh dokumen perusahaan B ditolak (404)', async () => {
      const itB = await buatStaffMasuk(['IT_ADMIN'], { companyIds: [perusahaanB] });
      const itA = await buatStaffMasuk(['IT_ADMIN'], { companyIds: [perusahaanA] });
      const dok = await unggah(itB, perusahaanB, PDF).expect(201);
      await unggah(itA, perusahaanB, PDF).expect(404);
      await api(itA, 'get', `/companies/${perusahaanB}/documents`).expect(404);
      await http('get', `/companies/${perusahaanB}/documents/${dok.body.id}/download`, { cookie: itA.cookie }).expect(404);
      // ID dokumen B dengan path perusahaan A juga tidak boleh terunduh
      await http('get', `/companies/${perusahaanA}/documents/${dok.body.id}/download`, { cookie: itA.cookie }).expect(404);
      await api(itA, 'delete', `/companies/${perusahaanA}/documents/${dok.body.id}`).expect(404);
    });

    it('unggah tanpa token CSRF atau dengan Origin asing ditolak', async () => {
      const it = await buatStaffMasuk(['IT_ADMIN'], { companyIds: [perusahaanA] });
      await http('post', `/companies/${perusahaanA}/documents`, { cookie: it.cookie }).field('kind', 'NIB').field('title', 'x').attach('berkas', PDF, 'a.pdf').expect(403);
      await http('post', `/companies/${perusahaanA}/documents`, { cookie: it.cookie, csrf: it.csrf, origin: 'https://jahat.invalid' }).field('kind', 'NIB').field('title', 'x').attach('berkas', PDF, 'a.pdf').expect(403);
    });
  });

  describe('seed perusahaan awal', () => {
    it('idempoten: dijalankan dua kali tidak menggandakan dan tidak mengubah data yang ada', async () => {
      const { SeedPerusahaanService } = await import('../src/master/seed-perusahaan.service');
      const svc = app.get(SeedPerusahaanService);
      await svc.jalankan();
      const hitung = async () => Number((await pool.query(`SELECT count(*) FROM companies WHERE short_code IN ('DMR','OSI','PCP')`)).rows[0].count);
      expect(await hitung()).toBe(3);
      const kedua = await svc.jalankan();
      expect(kedua).toEqual({ dibuat: 0, sudahAda: 3 });
      expect(await hitung()).toBe(3);
    });
  });
});
