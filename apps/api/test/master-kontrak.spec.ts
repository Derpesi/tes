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

interface Sesi {
  cookie: string;
  csrf: string;
}
interface Staff extends Sesi {
  userId: string;
  email: string;
  secret: string;
}

jalan('Kontrak layanan rekanan (PostgreSQL asli)', () => {
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


  const pegawai = (r: string | string[], companyIds: string[]) => buatStaffMasuk(Array.isArray(r) ? r : [r], { companyIds });
  const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
  const nomor = () => `KTR/SINTETIS/${randomBytes(4).toString('hex')}`;
  const rekananDi = async (marketing: Sesi) => (await api(marketing, 'post', '/partners', { name: `REKANAN SINTETIS ${randomBytes(4).toString('hex')}` }).expect(201)).body.id as string;
  const kontrak = (s: Sesi, partnerId: string, o: object = {}) => api(s, 'post', '/partner-contracts', { partnerId, contractNumber: nomor(), serviceType: 'Keamanan', startDate: '2026-01-01', endDate: '2026-12-31', ...o });
  const unggah = (s: Sesi, kontrakId: string, berkas: Buffer, nama = 'kontrak.pdf') => http('post', `/partner-contracts/${kontrakId}/documents`, { cookie: s.cookie, csrf: s.csrf }).field('title', 'Salinan sintetis').attach('berkas', berkas, nama);

  describe('state machine dan aktivasi Direktur', () => {
    it('DRAFT -> AKTIF (Direktur) -> BERAKHIR; transisi ilegal ditolak 409', async () => {
      const m = await pegawai('MARKETING', [perusahaanA]);
      const dir = await pegawai('DIREKTUR', [perusahaanA]);
      const k = (await kontrak(m, await rekananDi(m)).expect(201)).body;
      expect(k.status).toBe('DRAFT');
      expect(k.approvedBy).toBeNull();
      await api(dir, 'post', `/partner-contracts/${k.id}/end`).expect(409); // DRAFT tak bisa diakhiri
      const aktif = (await api(dir, 'post', `/partner-contracts/${k.id}/activate`).expect(200)).body;
      expect(aktif.status).toBe('AKTIF');
      expect(aktif.approvedBy).toBe(dir.userId);
      expect(aktif.createdBy).toBe(m.userId);
      expect((await api(dir, 'post', `/partner-contracts/${k.id}/activate`).expect(409)).body.kode).toBe('TRANSISI_TIDAK_VALID');
      await api(m, 'post', `/partner-contracts/${k.id}/cancel`).expect(409); // aktif tak bisa dibatalkan
      const akhir = (await api(dir, 'post', `/partner-contracts/${k.id}/end`).expect(200)).body;
      expect(akhir.status).toBe('BERAKHIR');
      expect(akhir.endedAt).not.toBeNull();
      await api(dir, 'post', `/partner-contracts/${k.id}/activate`).expect(409);
      await api(dir, 'post', `/partner-contracts/${k.id}/end`).expect(409);
      expect((await bacaAuditSql('master.partner_contract.activated', dir.userId)).length).toBeGreaterThan(0);
      expect((await bacaAuditSql('master.partner_contract.ended', dir.userId)).length).toBeGreaterThan(0);
    });

    it('DRAFT dapat dibatalkan, lalu tidak dapat diaktifkan atau diubah', async () => {
      const m = await pegawai('MARKETING', [perusahaanA]);
      const dir = await pegawai('DIREKTUR', [perusahaanA]);
      const k = (await kontrak(m, await rekananDi(m)).expect(201)).body;
      expect((await api(m, 'post', `/partner-contracts/${k.id}/cancel`).expect(200)).body.status).toBe('DIBATALKAN');
      await api(dir, 'post', `/partner-contracts/${k.id}/activate`).expect(409);
      await api(m, 'patch', `/partner-contracts/${k.id}`, { notes: 'x' }).expect(409);
      await api(m, 'post', `/partner-contracts/${k.id}/cancel`).expect(409);
    });

    it('pemisahan tugas: pembuat yang juga berhak menyetujui tetap tidak dapat mengaktifkan kontraknya sendiri', async () => {
      const ganda = await pegawai(['MARKETING', 'DIREKTUR'], [perusahaanA]);
      const k = (await kontrak(ganda, await rekananDi(ganda)).expect(201)).body;
      expect((await api(ganda, 'post', `/partner-contracts/${k.id}/activate`).expect(403)).body.kode).toBe('PEMISAHAN_TUGAS');
      expect((await api(ganda, 'get', `/partner-contracts/${k.id}`).expect(200)).body.status).toBe('DRAFT');
      const lain = await pegawai('DIREKTUR', [perusahaanA]);
      await api(lain, 'post', `/partner-contracts/${k.id}/activate`).expect(200);
    });

    it('aktivasi serentak: hanya satu berhasil (tanpa persetujuan ganda)', async () => {
      const m = await pegawai('MARKETING', [perusahaanA]);
      const d1 = await pegawai('DIREKTUR', [perusahaanA]);
      const d2 = await pegawai('DIREKTUR', [perusahaanA]);
      const k = (await kontrak(m, await rekananDi(m)).expect(201)).body;
      const r = await Promise.all([api(d1, 'post', `/partner-contracts/${k.id}/activate`), api(d2, 'post', `/partner-contracts/${k.id}/activate`)]);
      expect(r.map((x) => x.status).sort()).toEqual([200, 409]);
    });

    it('isi hanya dapat diubah saat DRAFT; periode dan nomor divalidasi', async () => {
      const m = await pegawai('MARKETING', [perusahaanA]);
      const dir = await pegawai('DIREKTUR', [perusahaanA]);
      const rek = await rekananDi(m);
      const k = (await kontrak(m, rek).expect(201)).body;
      expect((await api(m, 'patch', `/partner-contracts/${k.id}`, { serviceType: 'Cleaning Service' }).expect(200)).body.serviceType).toBe('Cleaning Service');
      await api(m, 'patch', `/partner-contracts/${k.id}`, { endDate: '2025-01-01' }).expect(400); // sebelum mulai (dicek DB)
      await api(m, 'patch', `/partner-contracts/${k.id}`, {}).expect(400);
      await api(m, 'patch', `/partner-contracts/${k.id}`, { status: 'AKTIF' }).expect(400); // status tidak dapat diubah lewat PATCH
      await api(dir, 'post', `/partner-contracts/${k.id}/activate`).expect(200);
      expect((await api(m, 'patch', `/partner-contracts/${k.id}`, { notes: 'sisipan' }).expect(409)).body.kode).toBe('KONTRAK_TIDAK_DAPAT_DIUBAH');
      expect(JSON.stringify((await kontrak(m, rek, { endDate: '2025-12-31' }).expect(400)).body)).toMatch(/sebelum/);
      await kontrak(m, rek, { startDate: '2026-02-30' }).expect(400);
      await kontrak(m, rek, { contractNumber: '' }).expect(400);
    });

    it('nomor kontrak unik per perusahaan (409), boleh sama di perusahaan lain; serentak satu menang', async () => {
      const mA = await pegawai('MARKETING', [perusahaanA]);
      const mB = await pegawai('MARKETING', [perusahaanB]);
      const rA = await rekananDi(mA);
      const rB = await rekananDi(mB);
      const no = nomor();
      await kontrak(mA, rA, { contractNumber: no }).expect(201);
      expect((await kontrak(mA, rA, { contractNumber: no }).expect(409)).body.kode).toBe('NOMOR_KONTRAK_SUDAH_ADA');
      await kontrak(mB, rB, { contractNumber: no }).expect(201);
      const balap = nomor();
      const hasil = await Promise.all([1, 2, 3].map(() => kontrak(mA, rA, { contractNumber: balap })));
      expect(hasil.map((x) => x.status).sort()).toEqual([201, 409, 409]);
    });

    it('rekanan nonaktif tidak dapat dikontrakkan; kontrak DRAFT tidak dapat diaktifkan setelah rekanan nonaktif', async () => {
      const ops = await pegawai(['MANAGER_OPERASIONAL', 'MARKETING'], [perusahaanA]);
      const dir = await pegawai('DIREKTUR', [perusahaanA]);
      const rek = await rekananDi(ops);
      const k = (await kontrak(ops, rek).expect(201)).body;
      await api(ops, 'post', `/partners/${rek}/deactivate`).expect(204);
      await kontrak(ops, rek).expect(409);
      expect((await api(dir, 'post', `/partner-contracts/${k.id}/activate`).expect(409)).body.kode).toBe('INDUK_NONAKTIF');
    });
  });

  describe('isolasi lintas perusahaan dan izin', () => {
    it('scope A tidak dapat membaca, mengubah, mengaktifkan, atau melampirkan kontrak B (404)', async () => {
      const mB = await pegawai('MARKETING', [perusahaanB]);
      const mA = await pegawai('MARKETING', [perusahaanA]);
      const dirA = await pegawai('DIREKTUR', [perusahaanA]);
      const kB = (await kontrak(mB, await rekananDi(mB)).expect(201)).body;
      const lamp = (await unggah(mB, kB.id, PDF).expect(201)).body;
      await kontrak(mA, kB.partnerId).expect(404); // rekanan B tidak terlihat
      await api(mA, 'get', `/partner-contracts/${kB.id}`).expect(404);
      await api(mA, 'patch', `/partner-contracts/${kB.id}`, { notes: 'x' }).expect(404);
      await api(dirA, 'post', `/partner-contracts/${kB.id}/activate`).expect(404);
      await api(dirA, 'post', `/partner-contracts/${kB.id}/end`).expect(404);
      await api(mA, 'post', `/partner-contracts/${kB.id}/cancel`).expect(404);
      await api(mA, 'get', `/partner-contracts/${kB.id}/documents`).expect(404);
      await unggah(mA, kB.id, PDF).expect(404);
      await http('get', `/partner-contracts/${kB.id}/documents/${lamp.id}/download`, { cookie: mA.cookie }).expect(404);
      await api(mA, 'delete', `/partner-contracts/${kB.id}/documents/${lamp.id}`).expect(404);
      expect(((await api(mA, 'get', '/partner-contracts').expect(200)).body.items as { id: string }[]).map((x) => x.id)).not.toContain(kB.id);
      expect((await api(mA, 'get', `/partner-contracts?partnerId=${kB.partnerId}`).expect(200)).body.items).toEqual([]);
      // kontrak B tetap utuh
      expect((await api(mB, 'get', `/partner-contracts/${kB.id}`).expect(200)).body.status).toBe('DRAFT');
    });

    // V, C/U, A per peran dari tabel "Kontrak layanan rekanan"
    const izin: Record<string, [boolean, boolean, boolean]> = {
      DIREKTUR: [true, false, true],
      MANAGER_OPERASIONAL: [true, false, false],
      IT_ADMIN: [false, false, false],
      HRD: [true, false, false],
      MARKETING: [true, true, false],
      STAFF_ADMINISTRASI: [true, false, false],
      STAFF_PAYROLL_ABSENSI_REKANAN: [false, false, false],
      STAFF_KEUANGAN: [true, false, false],
      STAFF_PAYROLL_INTERNAL: [false, false, false],
    };
    it.each(Object.entries(izin))('%s: lihat / buat-ubah / setujui', async (peranKode, [v, cu, ap]) => {
      const pemilik = await pegawai('MARKETING', [perusahaanA]);
      const k = (await kontrak(pemilik, await rekananDi(pemilik)).expect(201)).body;
      const s = await pegawai(peranKode, [perusahaanA]);
      const cek = async (boleh: boolean, res: request.Test) => {
        const r = await res;
        if (boleh) expect(r.status).not.toBe(403);
        else expect(r.status).toBe(403);
      };
      await cek(v, api(s, 'get', '/partner-contracts'));
      await cek(v, api(s, 'get', `/partner-contracts/${k.id}`));
      await cek(v, api(s, 'get', `/partner-contracts/${k.id}/documents`));
      await cek(cu, kontrak(s, k.partnerId));
      await cek(cu, api(s, 'patch', `/partner-contracts/${k.id}`, { notes: 'u' }));
      await cek(cu, unggah(s, k.id, PDF));
      await cek(ap, api(s, 'post', `/partner-contracts/${k.id}/activate`));
      await cek(ap, api(s, 'post', `/partner-contracts/${k.id}/end`));
    });
  });

  describe('lampiran kontrak', () => {
    it('unggah sah, daftar, unduh terkontrol, hapus lunak; berkas palsu ditolak; kontrak batal tidak menerima lampiran', async () => {
      const m = await pegawai('MARKETING', [perusahaanA]);
      const k = (await kontrak(m, await rekananDi(m)).expect(201)).body;
      const up = await unggah(m, k.id, PDF).expect(201);
      expect(JSON.stringify(up.body)).not.toMatch(/object_key|objectKey|STORAGE|\/tmp/);
      const dl = await http('get', `/partner-contracts/${k.id}/documents/${up.body.id}/download`, { cookie: m.cookie }).buffer(true).parse((r, cb) => { const b: Buffer[] = []; r.on('data', (d) => b.push(d)); r.on('end', () => cb(null, Buffer.concat(b))); }).expect(200);
      expect(Buffer.compare(dl.body as Buffer, PDF)).toBe(0);
      expect(dl.headers['content-disposition']).toMatch(/^attachment/);
      expect(dl.headers['x-content-type-options']).toBe('nosniff');
      expect((await bacaAuditSql('master.partner_contract_document.downloaded', m.userId)).length).toBeGreaterThan(0);
      expect(((await api(m, 'get', `/partner-contracts/${k.id}/documents`).expect(200)).body.items as unknown[]).length).toBe(1);
      await unggah(m, k.id, Buffer.from('MZ\x90\x00\x03' + 'x'.repeat(40))).expect(415);
      await unggah(m, k.id, Buffer.alloc(0)).expect(400);
      await api(m, 'delete', `/partner-contracts/${k.id}/documents/${up.body.id}`).expect(204);
      await http('get', `/partner-contracts/${k.id}/documents/${up.body.id}/download`, { cookie: m.cookie }).expect(404);
      await api(m, 'post', `/partner-contracts/${k.id}/cancel`).expect(200);
      expect((await unggah(m, k.id, PDF).expect(409)).body.kode).toBe('KONTRAK_DIBATALKAN');
    });

    it('lampiran kontrak aktif tetap dapat ditambahkan (mis. salinan bertanda tangan basah); CSRF ditegakkan', async () => {
      const m = await pegawai('MARKETING', [perusahaanA]);
      const dir = await pegawai('DIREKTUR', [perusahaanA]);
      const k = (await kontrak(m, await rekananDi(m)).expect(201)).body;
      await api(dir, 'post', `/partner-contracts/${k.id}/activate`).expect(200);
      await unggah(m, k.id, PDF).expect(201);
      await http('post', `/partner-contracts/${k.id}/documents`, { cookie: m.cookie }).field('title', 'x').attach('berkas', PDF, 'a.pdf').expect(403);
    });
  });
});
