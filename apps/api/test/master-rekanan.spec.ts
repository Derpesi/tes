import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
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

jalan('Rekanan, lokasi, kontak, dan kebutuhan tenaga (PostgreSQL asli)', () => {
  let app: INestApplication;
  let pool: Pool;
  let passwordHash: string;
  let encKey: Buffer;
  let perusahaanA: string;
  let perusahaanB: string;
  const terkirim: PesanEmail[] = [];
  const sesiPeran = new Map<string, Staff>();
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
    for (const r of ROLES) sesiPeran.set(r, await buatStaffMasuk([r]));
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


  const namaBaru = () => `REKANAN SINTETIS ${randomBytes(4).toString('hex')}`;
  const pegawai = (r: string, companyIds: string[]) => buatStaffMasuk([r], { companyIds });
  const buatRekanan = (s: Sesi, body: object = {}) => api(s, 'post', '/partners', { name: namaBaru(), ...body });

  describe('isolasi lintas perusahaan lewat API (menebak ID -> 404)', () => {
    it('scope A tidak dapat melihat, mengubah, atau menonaktifkan rekanan, kontak, lokasi, dan kebutuhan B', async () => {
      const mA = await pegawai('MARKETING', [perusahaanA]);
      const mB = await pegawai('MARKETING', [perusahaanB]);
      const opsA = await pegawai('MANAGER_OPERASIONAL', [perusahaanA]);
      const rek = (await buatRekanan(mB).expect(201)).body;
      expect(rek.companyId).toBe(perusahaanB);
      const kontak = (await api(mB, 'post', `/partners/${rek.id}/contacts`, { name: 'PIC Sintetis' }).expect(201)).body;
      const lok = (await api(mB, 'post', `/partners/${rek.id}/locations`, { name: 'Lokasi 1', latitude: -6.2, longitude: 106.8 }).expect(201)).body;
      const keb = await api(mB, 'post', `/locations/${lok.id}/manpower`, { position: 'Satpam', headcount: 3, validFrom: '2026-01-01' }).expect(201);
      expect(keb.body.validFrom).toBe('2026-01-01');

      await api(mA, 'get', `/partners/${rek.id}`).expect(404);
      await api(mA, 'patch', `/partners/${rek.id}`, { city: 'Bogor' }).expect(404);
      await api(opsA, 'post', `/partners/${rek.id}/deactivate`).expect(404);
      await api(mA, 'get', `/partners/${rek.id}/contacts`).expect(404);
      await api(mA, 'post', `/partners/${rek.id}/contacts`, { name: 'X' }).expect(404);
      await api(mA, 'patch', `/partners/${rek.id}/contacts/${kontak.id}`, { name: 'Y' }).expect(404);
      await api(opsA, 'post', `/partners/${rek.id}/contacts/${kontak.id}/deactivate`).expect(404);
      await api(mA, 'get', `/partners/${rek.id}/locations`).expect(404);
      await api(mA, 'post', `/partners/${rek.id}/locations`, { name: 'X' }).expect(404);
      await api(mA, 'get', `/locations/${lok.id}`).expect(404);
      await api(mA, 'patch', `/locations/${lok.id}`, { name: 'Y' }).expect(404);
      await api(opsA, 'post', `/locations/${lok.id}/deactivate`).expect(404);
      await api(mA, 'get', `/locations/${lok.id}/manpower`).expect(404);
      await api(mA, 'post', `/locations/${lok.id}/manpower`, { position: 'X', headcount: 1, validFrom: '2026-01-01' }).expect(404);
      const daftar = await api(mA, 'get', '/partners').expect(200);
      expect((daftar.body.items as { id: string }[]).map((x) => x.id)).not.toContain(rek.id);
      // filter companyId ke perusahaan lain tidak membuka data
      expect((await api(mA, 'get', `/partners?companyId=${perusahaanB}`).expect(200)).body.items).toEqual([]);
      // tidak ada efek samping pada data B
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.company_ids', $1, true)`, [perusahaanB]);
        const r = await c.query(`SELECT city, status FROM partners WHERE id = $1`, [rek.id]);
        expect(r.rows[0]).toEqual({ city: null, status: 'AKTIF' });
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
    });

    it('company_id berasal dari scope: perusahaan di luar scope ditolak, scope jamak wajib memilih', async () => {
      const m1 = await pegawai('MARKETING', [perusahaanA]);
      const ok = await buatRekanan(m1).expect(201); // scope tunggal -> otomatis
      expect(ok.body.companyId).toBe(perusahaanA);
      await buatRekanan(m1, { companyId: perusahaanB }).expect(404);
      const m2 = await pegawai('MARKETING', [perusahaanA, perusahaanB]);
      expect((await buatRekanan(m2).expect(400)).body.kode).toBe('PERUSAHAAN_WAJIB');
      expect((await buatRekanan(m2, { companyId: perusahaanB }).expect(201)).body.companyId).toBe(perusahaanB);
    });
  });

  describe('izin per peran (sesuai docs/rbac.md)', () => {
    // V C U D per peran, dari tabel "Rekanan & lokasi"
    const izin: Record<string, [boolean, boolean, boolean, boolean]> = {
      DIREKTUR: [true, false, false, false],
      MANAGER_OPERASIONAL: [true, true, true, true],
      IT_ADMIN: [true, false, false, false],
      HRD: [true, false, false, false],
      MARKETING: [true, true, true, false],
      STAFF_ADMINISTRASI: [true, true, true, false],
      STAFF_PAYROLL_ABSENSI_REKANAN: [true, false, false, false],
      STAFF_KEUANGAN: [true, false, false, false],
      STAFF_PAYROLL_INTERNAL: [false, false, false, false],
    };
    it.each(Object.entries(izin))('%s: lihat/buat/ubah/nonaktifkan', async (peranKode, [v, c, u, d]) => {
      const pemilik = await pegawai('MARKETING', [perusahaanA]);
      const rek = (await buatRekanan(pemilik).expect(201)).body;
      const lok = (await api(pemilik, 'post', `/partners/${rek.id}/locations`, { name: 'L' }).expect(201)).body;
      const s = await pegawai(peranKode, [perusahaanA]);
      const cek = async (boleh: boolean, res: request.Test) => {
        const r = await res;
        if (boleh) expect(r.status).not.toBe(403);
        else expect(r.status).toBe(403);
      };
      await cek(v, api(s, 'get', '/partners'));
      await cek(v, api(s, 'get', `/partners/${rek.id}/locations`));
      await cek(c, api(s, 'post', '/partners', { name: namaBaru() }));
      await cek(c, api(s, 'post', `/partners/${rek.id}/contacts`, { name: 'K' }));
      await cek(u, api(s, 'patch', `/partners/${rek.id}`, { city: 'Depok' }));
      await cek(u, api(s, 'post', `/locations/${lok.id}/manpower`, { position: 'P', headcount: 1, validFrom: '2026-01-01' }));
      await cek(d, api(s, 'post', `/locations/${lok.id}/deactivate`));
      await cek(d, api(s, 'post', `/partners/${rek.id}/deactivate`));
    });
  });

  describe('validasi dan aturan data', () => {
    it('nama rekanan aktif unik per perusahaan (409), boleh sama di perusahaan lain; konkurensi hanya satu menang', async () => {
      const mA = await pegawai('MARKETING', [perusahaanA]);
      const mB = await pegawai('MARKETING', [perusahaanB]);
      const nama = namaBaru();
      await buatRekanan(mA, { name: nama }).expect(201);
      expect((await buatRekanan(mA, { name: nama.toLowerCase() }).expect(409)).body.kode).toBe('REKANAN_SUDAH_ADA');
      await buatRekanan(mB, { name: nama }).expect(201);
      const balap = namaBaru();
      const hasil = await Promise.all([buatRekanan(mA, { name: balap }), buatRekanan(mA, { name: balap }), buatRekanan(mA, { name: balap })]);
      expect(hasil.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    });

    it('validasi berpesan Indonesia untuk rekanan, kontak, dan lokasi (koordinat/radius)', async () => {
      const m = await pegawai('MARKETING', [perusahaanA]);
      const rek = (await buatRekanan(m).expect(201)).body;
      expect(JSON.stringify((await api(m, 'post', '/partners', { name: '' }).expect(400)).body)).toMatch(/wajib/);
      await api(m, 'post', '/partners', { name: 'x', unknown: 1 }).expect(201); // kolom asing diabaikan, tidak pernah menentukan company_id
      expect(JSON.stringify((await api(m, 'post', `/partners/${rek.id}/contacts`, { name: 'K', email: 'salah', phone: 'abc' }).expect(400)).body)).toMatch(/email|telepon/i);
      const lokasi = (body: object) => api(m, 'post', `/partners/${rek.id}/locations`, { name: `L ${randomBytes(3).toString('hex')}`, ...body });
      await lokasi({ latitude: 91, longitude: 0 }).expect(400);
      await lokasi({ latitude: 0, longitude: 181 }).expect(400);
      expect(JSON.stringify((await lokasi({ latitude: 1 }).expect(400)).body)).toMatch(/bersamaan/);
      await lokasi({ geofenceRadiusM: 10 }).expect(400);
      await lokasi({ geofenceRadiusM: 2000 }).expect(400);
      const baku = (await lokasi({}).expect(201)).body;
      expect(baku.geofenceRadiusM).toBe(100);
      expect(baku.latitude).toBeNull();
      const ber = (await lokasi({ latitude: -6.175392, longitude: 106.827153, geofenceRadiusM: 250 }).expect(201)).body;
      expect(ber.latitude).toBeCloseTo(-6.175392, 6);
      expect(ber.geofenceRadiusM).toBe(250);
      await api(m, 'patch', `/locations/${ber.id}`, { latitude: null }).expect(400);
      const hapus = (await api(m, 'patch', `/locations/${ber.id}`, { latitude: null, longitude: null }).expect(200)).body;
      expect(hapus.latitude).toBeNull();
    });

    it('satu rekanan banyak lokasi; nama lokasi aktif unik per rekanan', async () => {
      const m = await pegawai('MARKETING', [perusahaanA]);
      const rek = (await buatRekanan(m).expect(201)).body;
      await api(m, 'post', `/partners/${rek.id}/locations`, { name: 'Gedung A' }).expect(201);
      await api(m, 'post', `/partners/${rek.id}/locations`, { name: 'Gedung B' }).expect(201);
      expect((await api(m, 'post', `/partners/${rek.id}/locations`, { name: 'gedung a' }).expect(409)).body.kode).toBe('LOKASI_SUDAH_ADA');
      expect(((await api(m, 'get', `/partners/${rek.id}/locations`).expect(200)).body.items as unknown[]).length).toBe(2);
    });

    it('kontak utama hanya satu; kebutuhan tenaga divalidasi', async () => {
      const m = await pegawai('MARKETING', [perusahaanA]);
      const rek = (await buatRekanan(m).expect(201)).body;
      const k1 = (await api(m, 'post', `/partners/${rek.id}/contacts`, { name: 'Satu', isPrimary: true }).expect(201)).body;
      const k2 = (await api(m, 'post', `/partners/${rek.id}/contacts`, { name: 'Dua', isPrimary: true }).expect(201)).body;
      const daftar = (await api(m, 'get', `/partners/${rek.id}/contacts`).expect(200)).body.items as { id: string; isPrimary: boolean }[];
      expect(daftar.filter((x) => x.isPrimary).map((x) => x.id)).toEqual([k2.id]);
      expect(k1.id).not.toBe(k2.id);
      const lok = (await api(m, 'post', `/partners/${rek.id}/locations`, { name: 'L' }).expect(201)).body;
      const keb = (b: object) => api(m, 'post', `/locations/${lok.id}/manpower`, { position: 'Satpam', headcount: 2, validFrom: '2026-02-01', ...b });
      await keb({ headcount: -1 }).expect(400);
      await keb({ headcount: 1.5 }).expect(400);
      await keb({ validFrom: '2026-02-30' }).expect(400);
      expect(JSON.stringify((await keb({ validTo: '2026-01-01' }).expect(400)).body)).toMatch(/sebelum/);
      await keb({ validTo: '2026-12-31' }).expect(201);
    });

    it('nonaktif tidak menghapus riwayat; induk nonaktif tidak menerima anak baru; nonaktif ulang 409', async () => {
      const ops = await pegawai('MANAGER_OPERASIONAL', [perusahaanA]);
      const rek = (await buatRekanan(ops).expect(201)).body;
      const lok = (await api(ops, 'post', `/partners/${rek.id}/locations`, { name: 'L' }).expect(201)).body;
      await api(ops, 'post', `/partners/${rek.id}/deactivate`).expect(204);
      expect((await api(ops, 'post', `/partners/${rek.id}/deactivate`).expect(409)).body.kode).toBe('REKANAN_SUDAH_NONAKTIF');
      expect((await api(ops, 'get', `/partners/${rek.id}`).expect(200)).body.status).toBe('NONAKTIF');
      await api(ops, 'get', `/locations/${lok.id}`).expect(200); // riwayat tetap ada
      await api(ops, 'post', `/partners/${rek.id}/locations`, { name: 'Baru' }).expect(409);
      await api(ops, 'post', `/partners/${rek.id}/contacts`, { name: 'Baru' }).expect(409);
      const nonaktif = (await api(ops, 'get', '/partners?status=NONAKTIF').expect(200)).body.items as { id: string }[];
      expect(nonaktif.map((x) => x.id)).toContain(rek.id);
    });
  });

  describe('daftar keyset dan audit', () => {
    it('keyset tanpa duplikat/hilang, batas ukuran, dan kursor palsu ditolak', async () => {
      const m = await pegawai('MARKETING', [perusahaanB]);
      const dibuat: string[] = [];
      for (let i = 0; i < 5; i++) dibuat.push((await buatRekanan(m).expect(201)).body.id);
      const lihat = new Set<string>();
      let kursor: string | null = null;
      let halaman = 0;
      do {
        const r: request.Response = await api(m, 'get', `/partners?limit=2${kursor ? `&cursor=${kursor}` : ''}`).expect(200);
        expect(r.body.items.length).toBeLessThanOrEqual(2);
        for (const x of r.body.items as { id: string }[]) {
          expect(lihat.has(x.id)).toBe(false);
          lihat.add(x.id);
        }
        kursor = r.body.nextCursor;
        halaman++;
      } while (kursor && halaman < 50);
      for (const id of dibuat) expect(lihat.has(id)).toBe(true);
      await api(m, 'get', '/partners?limit=101').expect(400);
      await api(m, 'get', '/partners?limit=0').expect(400);
      await api(m, 'get', '/partners?cursor=bukan-kursor').expect(400);
    });

    it('perubahan diaudit tanpa nilai data (hanya nama bidang)', async () => {
      const m = await pegawai('MARKETING', [perusahaanA]);
      const rek = (await buatRekanan(m).expect(201)).body;
      await api(m, 'patch', `/partners/${rek.id}`, { notes: 'CATATAN-RAHASIA-UJI' }).expect(200);
      expect((await bacaAuditSql('master.partner.created', m.userId)).length).toBeGreaterThan(0);
      const aud = await bacaAuditSql('master.partner.updated', m.userId);
      expect(aud.length).toBeGreaterThan(0);
      expect(aud.some((x) => x.d.includes('CATATAN-RAHASIA-UJI'))).toBe(false);
    });
  });

  describe('rekanan bukan pengguna (tanpa portal/akun/login)', () => {
    it('tidak ada tabel akun rekanan, realm/peran rekanan, maupun rute login/portal/dashboard rekanan', async () => {
      const tabel = (await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name ~ 'partner|rekanan|vendor|client'`)).rows.map((x) => x.table_name as string).sort();
      expect(tabel).toEqual(['partner_contacts', 'partner_contract_documents', 'partner_contracts', 'partner_locations', 'partners']);
      for (const t of tabel) {
        const kolom = (await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = $1`, [t])).rows.map((x) => x.column_name as string);
        expect(kolom.filter((k) => /password|credential|token|login|user_id|google|mfa/.test(k))).toEqual([]);
      }
      const realm = (await pool.query(`SELECT DISTINCT realm FROM users`)).rows.map((x) => x.realm);
      expect(realm.every((r: string) => ['staff', 'member'].includes(r))).toBe(true);
      const peranRekanan = (await pool.query(`SELECT code FROM roles WHERE code ~* 'partner|rekanan' AND code <> 'STAFF_PAYROLL_ABSENSI_REKANAN'`)).rowCount;
      expect(peranRekanan).toBe(0);
      const { PATH_METADATA } = await import('@nestjs/common/constants');
      const jalur: string[] = [];
      for (const w of [...app.get(ModulesContainer, { strict: false }).values()].flatMap((m) => [...m.controllers.values()])) {
        if (!w.metatype) continue;
        const dasar = String(Reflect.getMetadata(PATH_METADATA, w.metatype) ?? '');
        for (const nama of Object.getOwnPropertyNames(w.metatype.prototype)) {
          const p = Reflect.getMetadata(PATH_METADATA, w.metatype.prototype[nama]);
          if (p !== undefined) jalur.push(`${dasar}/${p}`);
        }
      }
      expect(jalur.length).toBeGreaterThan(40);
      expect(jalur.filter((p) => /(partner|rekanan).*(login|auth|portal|dashboard|signin|masuk)|(login|auth|portal|dashboard).*(partner|rekanan)/i.test(p))).toEqual([]);
    });
  });
});
