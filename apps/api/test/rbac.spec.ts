import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Controller, Get, INestApplication } from '@nestjs/common';
import { ModulesContainer, Reflector } from '@nestjs/core';
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
const PASSWORD_BARU = 'sawah hijau di lembah subur';
const ROLES = ['DIREKTUR', 'MANAGER_OPERASIONAL', 'IT_ADMIN', 'HRD', 'MARKETING', 'STAFF_ADMINISTRASI', 'STAFF_PAYROLL_ABSENSI_REKANAN', 'STAFF_KEUANGAN', 'STAFF_PAYROLL_INTERNAL'];

/** Controller uji TANPA dekorator apa pun: harus ditolak guard dan terdeteksi enumerator rute. */
@Controller('uji-tanpa-dekorator')
class ControllerUjiTanpaDekorator {
  @Get()
  ping() {
    return { ok: true };
  }
}

interface Sesi {
  cookie: string;
  csrf: string;
}
interface Staff extends Sesi {
  userId: string;
  email: string;
  secret: string;
}

jalan('RBAC, scope, persetujuan ganda, dan penampil audit (PostgreSQL asli)', () => {
  let app: INestApplication;
  let pool: Pool;
  let passwordHash: string;
  let encKey: Buffer;
  let perusahaanA: string;
  let perusahaanB: string;
  const terkirim: PesanEmail[] = [];
  let worker: import('../src/notifications/outbox.worker').OutboxWorker;
  let sessions: import('../src/auth/session.service').SessionService;
  const sesiPeran = new Map<string, Staff>();
  let nomorIp = 1;

  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    execFileSync('node', ['scripts/migrate.js', 'up'], { env: { ...process.env, DATABASE_URL: DB_URL } });
    const { AppModule } = await import('../src/app.module');
    const { konfigurasiApp } = await import('../src/app.factory');
    const { EMAIL_CHANNEL } = await import('../src/notifications/email.channel');
    const { OutboxWorker } = await import('../src/notifications/outbox.worker');
    const { PasswordService } = await import('../src/auth/password.service');
    const { SessionService } = await import('../src/auth/session.service');
    const mod = await Test.createTestingModule({ imports: [AppModule], controllers: [ControllerUjiTanpaDekorator] })
      .overrideProvider(EMAIL_CHANNEL)
      .useValue({ tersedia: () => true, kirim: async (p: PesanEmail) => void terkirim.push(p) })
      .compile();
    app = mod.createNestApplication();
    konfigurasiApp(app);
    await app.init();
    worker = app.get(OutboxWorker);
    sessions = app.get(SessionService);
    passwordHash = await app.get(PasswordService).hash(PASSWORD);
    encKey = Buffer.from(process.env.APP_ENCRYPTION_KEY!, 'base64');
    pool = new Pool({ connectionString: DB_URL, max: 4 });
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
  /** Mengosongkan outbox sepenuhnya (prosesBatch hanya mengambil sejumlah terbatas per panggilan). */
  const kirimEmail = async () => {
    for (let i = 0; i < 50 && (await worker.prosesBatch(100)) > 0; i++);
  };
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
  const http = (metode: 'get' | 'post' | 'delete', path: string, o: { cookie?: string; csrf?: string; origin?: string | null } = {}) => {
    let r = request(app.getHttpServer())[metode](path).set('X-Forwarded-For', ipBaru());
    if (o.origin !== null) r = r.set('Origin', o.origin ?? ORIGIN);
    if (o.cookie) r = r.set('Cookie', o.cookie);
    if (o.csrf) r = r.set('X-CSRF-Token', o.csrf);
    return r;
  };
  const api = (s: Sesi, metode: 'get' | 'post' | 'delete', path: string, body?: unknown) => {
    const r = http(metode, path, { cookie: s.cookie, csrf: s.csrf });
    return body === undefined ? r : r.send(body as object);
  };
  const peran = (r: string) => sesiPeran.get(r)!;
  const tokenDariEmail = (p: PesanEmail) => /token=([A-Za-z0-9_-]+)/.exec(p.text)![1];
  const peranAktif = async (userId: string) => (await pool.query(`SELECT role_code FROM user_roles WHERE user_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) ORDER BY 1`, [userId])).rows.map((x) => x.role_code as string);
  const bacaAuditSql = async (aksi: string, userId?: string) => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.audit_global', 'on', true)`);
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

  // ---------- deny-by-default ----------
  describe('deny-by-default', () => {
    it('enumerator rute: setiap handler wajib @Public(), @Sesi(), atau @RequirePermission() (hanya controller uji yang melanggar)', async () => {
      const { PATH_METADATA } = await import('@nestjs/common/constants');
      const { PUBLIK, OPSI_SESI } = await import('../src/auth/decorators');
      const { IZIN } = await import('../src/rbac/rbac.decorators');
      const reflector = app.get(Reflector);
      const tanpa: string[] = [];
      let jumlah = 0;
      const wrappers = [...app.get(ModulesContainer, { strict: false }).values()].flatMap((m) => [...m.controllers.values()]);
      for (const w of wrappers) {
        const proto = w.metatype?.prototype as Record<string, unknown> | undefined;
        if (!proto || !w.metatype) continue;
        for (const nama of Object.getOwnPropertyNames(proto)) {
          const fn = proto[nama];
          if (nama === 'constructor' || typeof fn !== 'function' || Reflect.getMetadata(PATH_METADATA, fn) === undefined) continue;
          jumlah++;
          const ada = [PUBLIK, OPSI_SESI, IZIN].some((k) => reflector.getAllAndOverride(k, [fn as () => void, w.metatype!]) !== undefined);
          if (!ada) tanpa.push(`${w.metatype.name}.${nama}`);
        }
      }
      expect(jumlah).toBeGreaterThan(25);
      expect(tanpa).toEqual(['ControllerUjiTanpaDekorator.ping']);
    });

    it('rute tanpa dekorator ditolak guard walau pengguna sudah masuk penuh', async () => {
      const r = await api(peran('DIREKTUR'), 'get', '/uji-tanpa-dekorator').expect(403);
      expect(r.body.kode).toBe('RUTE_TANPA_IZIN');
      const anon = await http('get', '/uji-tanpa-dekorator').expect(401);
      expect(anon.body.kode).toBe('BELUM_MASUK');
    });
  });

  // ---------- matriks peran x endpoint ----------
  describe('penegakan permission per peran (dari seed database = docs/rbac.md)', () => {
    const id = () => randomUUID();
    const ENDPOINTS: { izin: string; metode: 'get' | 'post' | 'delete'; path: () => string; body?: unknown }[] = [
      { izin: 'user_role.view', metode: 'get', path: () => '/roles' },
      { izin: 'user_role.view', metode: 'get', path: () => '/staff' },
      { izin: 'user_role.view', metode: 'get', path: () => '/approvals' },
      { izin: 'user_role.create', metode: 'post', path: () => '/staff/invitations', body: {} },
      { izin: 'user_role.create', metode: 'post', path: () => `/staff/${id()}/roles`, body: { roleCode: 'HRD' } },
      { izin: 'user_role.deactivate', metode: 'delete', path: () => `/staff/${id()}/roles/HRD` },
      { izin: 'user_role.deactivate', metode: 'post', path: () => `/staff/${id()}/deactivate` },
      { izin: 'user_role.update', metode: 'post', path: () => `/staff/${id()}/companies`, body: { companyId: id() } },
      { izin: 'user_role.update', metode: 'delete', path: () => `/staff/${id()}/companies/${id()}` },
      { izin: 'user_role.update', metode: 'post', path: () => `/staff/${id()}/all-companies` },
      { izin: 'user_role.update', metode: 'delete', path: () => `/staff/${id()}/all-companies` },
      { izin: 'user_role.update', metode: 'post', path: () => `/staff/${id()}/mfa-reset` },
      { izin: 'user_role.approve', metode: 'post', path: () => `/approvals/${id()}/approve`, body: {} },
      { izin: 'user_role.approve', metode: 'post', path: () => `/approvals/${id()}/reject`, body: {} },
      { izin: 'audit_log.view', metode: 'get', path: () => '/audit-logs' },
    ];
    let izinPeran: Map<string, Set<string>>;
    beforeAll(async () => {
      const r = await pool.query(`SELECT role_code, permission_code FROM role_permissions`);
      izinPeran = new Map();
      for (const x of r.rows) (izinPeran.get(x.role_code) ?? izinPeran.set(x.role_code, new Set()).get(x.role_code)!).add(x.permission_code);
    });

    it.each(ROLES)('peran %s: diizinkan persis sesuai permission-nya, selain itu 403 IZIN_DITOLAK', async (role) => {
      const boleh = izinPeran.get(role) ?? new Set<string>();
      const salah: string[] = [];
      for (const e of ENDPOINTS) {
        const r = await api(peran(role), e.metode, e.path(), e.body);
        const ditolak = r.status === 403 && r.body.kode === 'IZIN_DITOLAK';
        if (boleh.has(e.izin) === ditolak) salah.push(`${e.metode.toUpperCase()} ${e.izin} -> ${r.status} ${r.body?.kode ?? ''}`);
      }
      expect(salah).toEqual([]);
    });

    it('sesi member dan sesi tertunda MFA tidak dapat mengakses endpoint admin; tanpa sesi 401', async () => {
      const m = await pool.query(`INSERT INTO users (realm, email, status) VALUES ('member', $1, 'AKTIF') RETURNING id`, [emailBaru()]);
      const sm = await sessions.buat({ userId: m.rows[0].id, realm: 'member', state: 'PENUH' });
      const member = { cookie: `__Host-sid=${sm.token}`, csrf: sm.csrfToken };
      for (const e of ENDPOINTS) {
        const r = await api(member, e.metode, e.path(), e.body);
        expect({ e: e.path(), s: r.status, k: r.body.kode }).toMatchObject({ s: 403, k: 'REALM_TIDAK_SESUAI' });
      }
      const s = await buatStaffSql(['DIREKTUR']);
      const l = await http('post', '/auth/staff/login').send({ email: s.email, password: PASSWORD }).expect(200);
      const tertunda = await http('get', '/staff', { cookie: cookieNamed(l, '__Host-sid') }).expect(403);
      expect(tertunda.body.kode).toBe('MFA_DIPERLUKAN');
      await http('get', '/staff').expect(401);
      await http('get', '/audit-logs').expect(401);
    });

    it('CSRF tetap wajib pada endpoint admin walau izin dimiliki', async () => {
      const r = await http('post', '/staff/invitations', { cookie: peran('IT_ADMIN').cookie }).send({}).expect(403);
      expect(r.body.kode).toBe('CSRF_TIDAK_VALID');
    });
  });

  // ---------- peran berumur terbatas & pencabutan ----------
  describe('masa berlaku dan pencabutan peran', () => {
    it('peran kedaluwarsa atau dicabut langsung kehilangan akses', async () => {
      const s = await buatStaffMasuk(['IT_ADMIN'], { expiresAt: new Date(Date.now() + 3600_000).toISOString() });
      await api(s, 'get', '/staff').expect(200);
      await pool.query(`UPDATE user_roles SET expires_at = now() - interval '1 second' WHERE user_id = $1`, [s.userId]);
      const r = await api(s, 'get', '/staff').expect(403);
      expect(r.body.kode).toBe('IZIN_DITOLAK');

      const t = await buatStaffMasuk(['IT_ADMIN']);
      await api(t, 'get', '/staff').expect(200);
      await pool.query(`UPDATE user_roles SET revoked_at = now() WHERE user_id = $1`, [t.userId]);
      await api(t, 'get', '/staff').expect(403);
    });

    it('/auth/me menampilkan peran, permission, dan scope yang berlaku', async () => {
      const s = await buatStaffMasuk(['HRD', 'MARKETING'], { companyIds: [perusahaanA] });
      const me = await http('get', '/auth/me', { cookie: s.cookie }).expect(200);
      expect(me.body.roles).toEqual(['HRD', 'MARKETING']);
      expect(me.body.permissions).toContain('member.verify'.replace('verify', 'review'));
      expect(me.body.companyIds).toEqual([perusahaanA]);
      expect(me.body.allCompanies).toBe(false);
    });

    it('perusahaan nonaktif dikeluarkan dari scope', async () => {
      const c = await pool.query(`INSERT INTO companies (name) VALUES ($1) RETURNING id`, [`PT SINTETIS NONAKTIF ${randomBytes(3).toString('hex')}`]);
      const s = await buatStaffMasuk(['HRD'], { companyIds: [c.rows[0].id] });
      expect((await http('get', '/auth/me', { cookie: s.cookie })).body.companyIds).toEqual([c.rows[0].id]);
      await pool.query(`UPDATE companies SET active = false WHERE id = $1`, [c.rows[0].id]);
      expect((await http('get', '/auth/me', { cookie: s.cookie })).body.companyIds).toEqual([]);
    });
  });

  // ---------- undangan + peran ----------
  describe('mengundang staff dengan peran dan scope', () => {
    it('peran biasa langsung berlaku; token tidak pernah dikembalikan; alur sampai login berfungsi', async () => {
      const email = emailBaru();
      const r = await api(peran('IT_ADMIN'), 'post', '/staff/invitations', { email, displayName: 'SINTETIS Baru', roles: ['HRD'], companyIds: [perusahaanA] }).expect(201);
      expect(r.body.roles).toEqual([{ roleCode: 'HRD', status: 'DIBERIKAN' }]);
      expect(JSON.stringify(r.body)).not.toMatch(/token|link/i);
      await kirimEmail();
      const mail = terkirim.find((m) => m.to === email)!;
      expect(mail.text).toContain('/undangan?token=');
      expect(await peranAktif(r.body.userId)).toEqual(['HRD']);

      const acc = await http('post', '/auth/staff/invitation/accept').send({ token: tokenDariEmail(mail), password: PASSWORD }).expect(200);
      const c1 = cookieNamed(acc, '__Host-sid');
      const st = await http('post', '/auth/staff/mfa/enroll/start', { cookie: c1, csrf: acc.body.csrfToken }).expect(200);
      await http('post', '/auth/staff/mfa/enroll/confirm', { cookie: c1, csrf: acc.body.csrfToken }).send({ code: generateSync({ secret: st.body.secret }) }).expect(200);
      const sesi = await masuk(email, st.body.secret);
      const me = await http('get', '/auth/me', { cookie: sesi.cookie }).expect(200);
      expect(me.body.roles).toEqual(['HRD']);
      expect(me.body.companyIds).toEqual([perusahaanA]);
      expect((await bacaAuditSql('auth.invitation.created', r.body.userId)).length).toBeGreaterThan(0);
      expect((await bacaAuditSql('auth.role.granted', r.body.userId)).length).toBeGreaterThan(0);
      expect((await bacaAuditSql('auth.scope.granted', r.body.userId)).length).toBeGreaterThan(0);
    });

    it('atomik: peran tidak dikenal membatalkan seluruh undangan (tanpa user dan tanpa email)', async () => {
      const email = emailBaru();
      const r = await api(peran('IT_ADMIN'), 'post', '/staff/invitations', { email, displayName: 'SINTETIS', roles: ['HRD', 'PERAN_KARANGAN'] }).expect(400);
      expect(r.body).toMatchObject({ kode: 'PERAN_TIDAK_DIKENAL', pesan: 'Peran tidak dikenal: PERAN_KARANGAN' });
      expect((await pool.query(`SELECT 1 FROM users WHERE email = $1`, [email])).rowCount).toBe(0);
      expect((await pool.query(`SELECT 1 FROM notification_outbox WHERE recipient = $1`, [email])).rowCount).toBe(0);
    });

    it('perusahaan tidak dikenal ditolak; email sudah terdaftar 409; validasi berbahasa Indonesia', async () => {
      const salah = await api(peran('IT_ADMIN'), 'post', '/staff/invitations', { email: emailBaru(), displayName: 'SINTETIS', companyIds: [randomUUID()] }).expect(400);
      expect(salah.body.kode).toBe('PERUSAHAAN_TIDAK_VALID');
      const ada = await buatStaffSql(['HRD']);
      const dup = await api(peran('IT_ADMIN'), 'post', '/staff/invitations', { email: ada.email, displayName: 'SINTETIS' }).expect(409);
      expect(dup.body.kode).toBe('EMAIL_SUDAH_TERDAFTAR');
      const v = await api(peran('IT_ADMIN'), 'post', '/staff/invitations', { email: 'bukan-email', displayName: '' }).expect(400);
      expect(v.body.kode).toBe('VALIDASI_GAGAL');
      expect(v.body.pesan).toMatch(/Format email tidak valid/);
    });

    it('tidak dapat mengubah akses diri sendiri', async () => {
      const it = await buatStaffMasuk(['IT_ADMIN']);
      const a = await api(it, 'post', `/staff/${it.userId}/roles`, { roleCode: 'HRD' }).expect(403);
      expect(a.body.kode).toBe('TIDAK_BOLEH_UBAH_DIRI_SENDIRI');
      await api(it, 'delete', `/staff/${it.userId}/roles/IT_ADMIN`).expect(403);
      await api(it, 'post', `/staff/${it.userId}/companies`, { companyId: perusahaanA }).expect(403);
      await api(it, 'post', `/staff/${it.userId}/deactivate`).expect(403);
      await api(it, 'post', `/staff/${it.userId}/mfa-reset`).expect(403);
    });
  });

  // ---------- persetujuan ganda ----------
  describe('persetujuan ganda untuk peran berhak tinggi', () => {
    async function mintaPeranTinggi(roleCode: string) {
      const target = await buatStaffSql(['HRD']);
      const r = await api(peran('IT_ADMIN'), 'post', `/staff/${target.userId}/roles`, { roleCode }).expect(200);
      return { target, approvalId: r.body.approvalId as string, hasil: r.body };
    }

    it('IT hanya dapat MEMINTA; peran belum berlaku; IT tidak dapat menyetujui; Direktur menyetujui', async () => {
      const { target, approvalId, hasil } = await mintaPeranTinggi('IT_ADMIN');
      expect(hasil.status).toBe('MENUNGGU_PERSETUJUAN');
      expect(await peranAktif(target.userId)).toEqual(['HRD']);
      const ditolakIt = await api(peran('IT_ADMIN'), 'post', `/approvals/${approvalId}/approve`, {}).expect(403);
      expect(ditolakIt.body.kode).toBe('IZIN_DITOLAK');
      const daftar = await api(peran('DIREKTUR'), 'get', '/approvals').expect(200);
      expect(daftar.body.find((x: { id: string }) => x.id === approvalId)).toMatchObject({ type: 'BERI_PERAN_TINGGI', status: 'MENUNGGU', payload: { roleCode: 'IT_ADMIN' } });
      await api(peran('DIREKTUR'), 'post', `/approvals/${approvalId}/approve`, { note: 'sesuai kebutuhan' }).expect(200);
      expect(await peranAktif(target.userId)).toEqual(['HRD', 'IT_ADMIN']);
      const lagi = await api(peran('DIREKTUR'), 'post', `/approvals/${approvalId}/approve`, {}).expect(409);
      expect(lagi.body.kode).toBe('PERSETUJUAN_SUDAH_DIPUTUSKAN');
      expect((await bacaAuditSql('auth.approval.requested')).length).toBeGreaterThan(0);
      expect((await bacaAuditSql('auth.approval.approved')).length).toBeGreaterThan(0);
    });

    it('permintaan ganda identik tidak menggandakan antrean; penolakan tidak memberi peran', async () => {
      const target = await buatStaffSql(['HRD']);
      const a = await api(peran('IT_ADMIN'), 'post', `/staff/${target.userId}/roles`, { roleCode: 'DIREKTUR' }).expect(200);
      const b = await api(peran('IT_ADMIN'), 'post', `/staff/${target.userId}/roles`, { roleCode: 'DIREKTUR' }).expect(200);
      expect(b.body.approvalId).toBe(a.body.approvalId);
      await api(peran('DIREKTUR'), 'post', `/approvals/${a.body.approvalId}/reject`, { note: 'tidak sesuai' }).expect(200);
      expect(await peranAktif(target.userId)).toEqual(['HRD']);
      const s = await pool.query(`SELECT status, decision_note FROM approval_requests WHERE id = $1`, [a.body.approvalId]);
      expect(s.rows[0]).toEqual({ status: 'DITOLAK', decision_note: 'tidak sesuai' });
    });

    it('permintaan kedaluwarsa tidak dapat disetujui', async () => {
      const { target, approvalId } = await mintaPeranTinggi('IT_ADMIN');
      await pool.query(`UPDATE approval_requests SET expires_at = now() - interval '1 minute' WHERE id = $1`, [approvalId]);
      const r = await api(peran('DIREKTUR'), 'post', `/approvals/${approvalId}/approve`, {}).expect(409);
      expect(r.body.kode).toBe('PERSETUJUAN_KEDALUWARSA');
      expect(await peranAktif(target.userId)).toEqual(['HRD']);
      expect((await pool.query(`SELECT status FROM approval_requests WHERE id = $1`, [approvalId])).rows[0].status).toBe('KEDALUWARSA');
    });

    it('pemisahan tugas: pemohon tidak dapat menyetujui permintaannya sendiri', async () => {
      const ganda = await buatStaffMasuk(['IT_ADMIN', 'DIREKTUR']); // peran gabungan hanya untuk menguji aturan
      const target = await buatStaffSql(['HRD']);
      const a = await api(ganda, 'post', `/staff/${target.userId}/roles`, { roleCode: 'IT_ADMIN' }).expect(200);
      const r = await api(ganda, 'post', `/approvals/${a.body.approvalId}/approve`, {}).expect(403);
      expect(r.body.kode).toBe('PENYETUJU_SAMA_DENGAN_PEMOHON');
      expect(await peranAktif(target.userId)).toEqual(['HRD']);
      await api(peran('DIREKTUR'), 'post', `/approvals/${a.body.approvalId}/approve`, {}).expect(200); // pihak lain boleh
    });

    it('subjek yang sudah dinonaktifkan: permintaan dibatalkan dan tidak dapat diterapkan', async () => {
      const { target, approvalId } = await mintaPeranTinggi('IT_ADMIN');
      await api(peran('IT_ADMIN'), 'post', `/staff/${target.userId}/deactivate`).expect(204);
      expect((await pool.query(`SELECT status FROM approval_requests WHERE id = $1`, [approvalId])).rows[0].status).toBe('DIBATALKAN');
      await api(peran('DIREKTUR'), 'post', `/approvals/${approvalId}/approve`, {}).expect(409);
      expect(await peranAktif(target.userId)).toEqual([]);
    });

    it('akses seluruh perusahaan memerlukan persetujuan; pencabutan langsung', async () => {
      const target = await buatStaffMasuk(['HRD']);
      const a = await api(peran('IT_ADMIN'), 'post', `/staff/${target.userId}/all-companies`).expect(202);
      expect((await http('get', '/auth/me', { cookie: target.cookie })).body.allCompanies).toBe(false);
      await api(peran('DIREKTUR'), 'post', `/approvals/${a.body.approvalId}/approve`, {}).expect(200);
      const me = (await http('get', '/auth/me', { cookie: target.cookie })).body;
      expect(me.allCompanies).toBe(true);
      expect(me.companyIds).toEqual(expect.arrayContaining([perusahaanA, perusahaanB]));
      await api(peran('IT_ADMIN'), 'delete', `/staff/${target.userId}/all-companies`).expect(204);
      expect((await http('get', '/auth/me', { cookie: target.cookie })).body.allCompanies).toBe(false);
    });
  });

  // ---------- Direktur pertama ----------
  describe('pengecualian Direktur pertama (admin bootstrap)', () => {
    /** Menjalankan fn dengan SEMUA peran Direktur yang ada dicabut sementara, lalu memulihkannya. */
    async function tanpaDirektur<T>(fn: () => Promise<T>): Promise<T> {
      const ada = await pool.query(`UPDATE user_roles SET revoked_at = now() WHERE role_code = 'DIREKTUR' AND revoked_at IS NULL RETURNING id`);
      try {
        return await fn();
      } finally {
        await pool.query(`UPDATE user_roles SET revoked_at = now() WHERE role_code = 'DIREKTUR' AND revoked_at IS NULL AND id <> ALL($1)`, [ada.rows.map((x) => x.id)]);
        await pool.query(`UPDATE user_roles SET revoked_at = NULL WHERE id = ANY($1)`, [ada.rows.map((x) => x.id)]);
      }
    }

    it('admin bootstrap menunjuk Direktur pertama langsung (sekali, teraudit); berikutnya wajib persetujuan', async () => {
      await tanpaDirektur(async () => {
        const boot = await buatStaffMasuk(['IT_ADMIN'], { bootstrap: true });
        const pertama = await api(boot, 'post', '/staff/invitations', { email: emailBaru(), displayName: 'SINTETIS Direktur', roles: ['DIREKTUR'] }).expect(201);
        expect(pertama.body.roles[0]).toMatchObject({ roleCode: 'DIREKTUR', status: 'DIBERIKAN', pengecualian: 'DIREKTUR_PERTAMA' });
        expect((await bacaAuditSql('auth.first_director.exception', boot.userId)).length).toBeGreaterThan(0);
        const kedua = await api(boot, 'post', '/staff/invitations', { email: emailBaru(), displayName: 'SINTETIS Direktur 2', roles: ['DIREKTUR'] }).expect(201);
        expect(kedua.body.roles[0].status).toBe('MENUNGGU_PERSETUJUAN');
      });
    });

    it('IT Administrator biasa (bukan bootstrap) tidak pernah mendapat pengecualian', async () => {
      await tanpaDirektur(async () => {
        const biasa = await buatStaffMasuk(['IT_ADMIN']);
        const r = await api(biasa, 'post', '/staff/invitations', { email: emailBaru(), displayName: 'SINTETIS Direktur', roles: ['DIREKTUR'] }).expect(201);
        expect(r.body.roles[0].status).toBe('MENUNGGU_PERSETUJUAN');
      });
    });

    it('pengecualian tertutup begitu ada Direktur: admin bootstrap pun wajib persetujuan', async () => {
      const boot = await buatStaffMasuk(['IT_ADMIN'], { bootstrap: true });
      const r = await api(boot, 'post', '/staff/invitations', { email: emailBaru(), displayName: 'SINTETIS Direktur', roles: ['DIREKTUR'] }).expect(201);
      expect(r.body.roles[0].status).toBe('MENUNGGU_PERSETUJUAN'); // Direktur dari beforeAll sudah ada
    });

    it('pengecualian hanya untuk peran DIREKTUR, bukan IT Administrator', async () => {
      await tanpaDirektur(async () => {
        const boot = await buatStaffMasuk(['IT_ADMIN'], { bootstrap: true });
        const r = await api(boot, 'post', '/staff/invitations', { email: emailBaru(), displayName: 'SINTETIS', roles: ['IT_ADMIN'] }).expect(201);
        expect(r.body.roles[0].status).toBe('MENUNGGU_PERSETUJUAN');
      });
    });
  });

  // ---------- pencabutan, nonaktif, reset MFA ----------
  describe('pencabutan, penonaktifan, dan reset MFA', () => {
    it('cabut peran: akses hilang; 404 untuk peran yang tidak dimiliki', async () => {
      const t = await buatStaffMasuk(['IT_ADMIN', 'HRD']);
      await api(t, 'get', '/staff').expect(200);
      await api(peran('IT_ADMIN'), 'delete', `/staff/${t.userId}/roles/IT_ADMIN`).expect(204);
      await api(t, 'get', '/staff').expect(403);
      const r = await api(peran('IT_ADMIN'), 'delete', `/staff/${t.userId}/roles/IT_ADMIN`).expect(404);
      expect(r.body.kode).toBe('PERAN_TIDAK_DITEMUKAN');
      expect(await peranAktif(t.userId)).toEqual(['HRD']);
    });

    it('nonaktifkan: sesi mati, tidak bisa login, peran dicabut; ulang 409; tidak ada 404', async () => {
      const t = await buatStaffMasuk(['HRD']);
      await api(peran('IT_ADMIN'), 'post', `/staff/${t.userId}/deactivate`).expect(204);
      await http('get', '/auth/me', { cookie: t.cookie }).expect(401);
      await http('post', '/auth/staff/login').send({ email: t.email, password: PASSWORD }).expect(401);
      expect(await peranAktif(t.userId)).toEqual([]);
      const lagi = await api(peran('IT_ADMIN'), 'post', `/staff/${t.userId}/deactivate`).expect(409);
      expect(lagi.body.kode).toBe('STAFF_NONAKTIF');
      await api(peran('IT_ADMIN'), 'post', `/staff/${randomUUID()}/deactivate`).expect(404);
      expect((await bacaAuditSql('auth.user.deactivated', t.userId)).length).toBe(1);
    });

    it('reset MFA butuh persetujuan; setelahnya akun kembali ke undangan (kata sandi, TOTP, dan kode pemulihan lama mati)', async () => {
      const t = await buatStaffMasuk(['HRD']);
      const r = await api(peran('IT_ADMIN'), 'post', `/staff/${t.userId}/mfa-reset`).expect(202);
      await api(t, 'get', '/auth/me').expect(200); // belum berlaku sebelum disetujui
      const sendiri = await api(peran('IT_ADMIN'), 'post', `/approvals/${r.body.approvalId}/approve`, {}).expect(403);
      expect(sendiri.body.kode).toBe('IZIN_DITOLAK');
      await api(peran('DIREKTUR'), 'post', `/approvals/${r.body.approvalId}/approve`, {}).expect(200);

      await http('get', '/auth/me', { cookie: t.cookie }).expect(401); // sesi lama dicabut
      expect((await pool.query(`SELECT status FROM users WHERE id = $1`, [t.userId])).rows[0].status).toBe('DIUNDANG');
      expect((await pool.query(`SELECT 1 FROM staff_credentials WHERE user_id = $1`, [t.userId])).rowCount).toBe(0);
      expect((await pool.query(`SELECT 1 FROM mfa_recovery_codes WHERE user_id = $1`, [t.userId])).rowCount).toBe(0);
      expect((await pool.query(`SELECT 1 FROM staff_mfa_factors WHERE user_id = $1 AND status = 'AKTIF'`, [t.userId])).rowCount).toBe(0);
      await http('post', '/auth/staff/login').send({ email: t.email, password: PASSWORD }).expect(401); // kata sandi lama mati

      await kirimEmail();
      const mail = terkirim.find((m) => m.to === t.email && m.subject.includes('Undangan'))!;
      const acc = await http('post', '/auth/staff/invitation/accept').send({ token: tokenDariEmail(mail), password: PASSWORD_BARU }).expect(200);
      const c1 = cookieNamed(acc, '__Host-sid');
      const st = await http('post', '/auth/staff/mfa/enroll/start', { cookie: c1, csrf: acc.body.csrfToken }).expect(200);
      expect(st.body.secret).not.toBe(t.secret);
      await http('post', '/auth/staff/mfa/enroll/confirm', { cookie: c1, csrf: acc.body.csrfToken }).send({ code: generateSync({ secret: st.body.secret }) }).expect(200);
      await masuk(t.email, st.body.secret, PASSWORD_BARU); // login penuh dengan TOTP baru
      const baru = await http('post', '/auth/staff/login').send({ email: t.email, password: PASSWORD_BARU }).expect(200);
      const lama = await http('post', '/auth/staff/mfa/verify', { cookie: cookieNamed(baru, '__Host-sid'), csrf: baru.body.csrfToken }).send({ code: kodeBerikut(t.secret) });
      expect(lama.status).toBe(401); // TOTP lama tidak berlaku
      expect((await bacaAuditSql('auth.mfa.reset', t.userId)).length).toBe(1);
    });

    it('scope: beri dan cabut akses perusahaan; perusahaan tidak valid ditolak', async () => {
      const t = await buatStaffMasuk(['HRD']);
      await api(peran('IT_ADMIN'), 'post', `/staff/${t.userId}/companies`, { companyId: perusahaanA }).expect(204);
      expect((await http('get', '/auth/me', { cookie: t.cookie })).body.companyIds).toEqual([perusahaanA]);
      await api(peran('IT_ADMIN'), 'post', `/staff/${t.userId}/companies`, { companyId: perusahaanA }).expect(204); // idempoten
      await api(peran('IT_ADMIN'), 'delete', `/staff/${t.userId}/companies/${perusahaanA}`).expect(204);
      expect((await http('get', '/auth/me', { cookie: t.cookie })).body.companyIds).toEqual([]);
      await api(peran('IT_ADMIN'), 'delete', `/staff/${t.userId}/companies/${perusahaanA}`).expect(404);
      const salah = await api(peran('IT_ADMIN'), 'post', `/staff/${t.userId}/companies`, { companyId: randomUUID() }).expect(400);
      expect(salah.body.kode).toBe('PERUSAHAAN_TIDAK_VALID');
    });
  });

  // ---------- daftar ----------
  describe('daftar staff dan peran', () => {
    it('/roles memuat 9 peran, hanya Direktur dan IT berhak tinggi', async () => {
      const r = await api(peran('DIREKTUR'), 'get', '/roles').expect(200);
      expect(r.body).toHaveLength(9);
      expect(r.body.filter((x: { highPrivilege: boolean }) => x.highPrivilege).map((x: { code: string }) => x.code).sort()).toEqual(['DIREKTUR', 'IT_ADMIN']);
      const db = await pool.query(`SELECT permission_code FROM role_permissions WHERE role_code = 'IT_ADMIN' ORDER BY 1`);
      expect(r.body.find((x: { code: string }) => x.code === 'IT_ADMIN').permissions).toEqual(db.rows.map((x) => x.permission_code));
    });

    it('/staff: keyset pagination tanpa duplikat, tanpa data rahasia', async () => {
      const semua: string[] = [];
      let kursor: string | null = null;
      for (let i = 0; i < 50; i++) {
        const r: request.Response = await api(peran('IT_ADMIN'), 'get', `/staff?limit=3${kursor ? `&cursor=${kursor}` : ''}`).expect(200);
        expect(r.body.items.length).toBeLessThanOrEqual(3);
        semua.push(...r.body.items.map((x: { id: string }) => x.id));
        const teks = JSON.stringify(r.body);
        expect(teks).not.toMatch(/password|secret|token_hash|argon2/i);
        kursor = r.body.nextCursor;
        if (!kursor) break;
      }
      expect(semua.length).toBeGreaterThan(9);
      expect(new Set(semua).size).toBe(semua.length);
      await api(peran('IT_ADMIN'), 'get', '/staff?limit=1000').expect(400);
      const buruk = await api(peran('IT_ADMIN'), 'get', '/staff?cursor=bukan-kursor').expect(400);
      expect(buruk.body.kode).toBe('KURSOR_TIDAK_VALID');
    });
  });

  // ---------- audit ----------
  describe('penampil audit (scope ditegakkan RLS)', () => {
    const tag = `uji.audit.${randomBytes(4).toString('hex')}`;
    let sA: Staff, sB: Staff, sDirektur: Staff, sIt: Staff, sKeuangan: Staff, sSemua: Staff;

    beforeAll(async () => {
      const tulis = (companyId: string | null, n: number) => pool.query(`INSERT INTO audit_logs (action, company_id, detail) VALUES ($1, $2, $3)`, [`${tag}.${n}`, companyId, JSON.stringify({ label: 'SINTETIS' })]);
      await tulis(perusahaanA, 1);
      await tulis(perusahaanA, 2);
      await tulis(perusahaanB, 3);
      await tulis(null, 4);
      sA = await buatStaffMasuk(['MANAGER_OPERASIONAL'], { companyIds: [perusahaanA] });
      sB = await buatStaffMasuk(['MANAGER_OPERASIONAL'], { companyIds: [perusahaanB] });
      sDirektur = await buatStaffMasuk(['DIREKTUR'], { companyIds: [perusahaanA, perusahaanB] });
      sIt = await buatStaffMasuk(['IT_ADMIN']);
      sKeuangan = await buatStaffMasuk(['STAFF_KEUANGAN']);
      sSemua = await buatStaffMasuk(['MANAGER_OPERASIONAL'], { allCompanies: true });
    });
    const lihat = async (s: Sesi, q = '') => ((await api(s, 'get', `/audit-logs?action=${tag}${q}`).expect(200)).body.items as { action: string; companyId: string | null }[]).map((x) => x.action.replace(`${tag}.`, ''));

    it('Manager Operasional hanya melihat baris perusahaan dalam scope-nya (bukan perusahaan lain, bukan global)', async () => {
      expect((await lihat(sA)).sort()).toEqual(['1', '2']);
      expect(await lihat(sB)).toEqual(['3']);
    });
    it('Direktur (izin global) melihat perusahaan dalam scope dan baris global', async () => {
      expect((await lihat(sDirektur)).sort()).toEqual(['1', '2', '3', '4']);
    });
    it('IT Administrator tanpa scope hanya melihat baris global (teknis)', async () => {
      expect(await lihat(sIt)).toEqual(['4']);
    });
    it('Staff Keuangan tanpa scope dan tanpa izin global tidak melihat apa pun', async () => {
      expect(await lihat(sKeuangan)).toEqual([]);
    });
    it('akses seluruh perusahaan melihat semua perusahaan aktif, tetapi bukan baris global', async () => {
      expect((await lihat(sSemua)).sort()).toEqual(['1', '2', '3']);
    });
    it('keyset pagination berurutan tanpa duplikat; filter waktu; batas ukuran halaman', async () => {
      const halaman: string[] = [];
      let kursor: string | null = null;
      for (let i = 0; i < 10; i++) {
        const r: request.Response = await api(sDirektur, 'get', `/audit-logs?action=${tag}&limit=1${kursor ? `&cursor=${kursor}` : ''}`).expect(200);
        halaman.push(...r.body.items.map((x: { action: string }) => x.action));
        kursor = r.body.nextCursor;
        if (!kursor) break;
      }
      expect(halaman).toHaveLength(4);
      expect(new Set(halaman).size).toBe(4);
      expect(halaman).toEqual([...halaman].sort().reverse()); // terbaru lebih dulu (sisipan berurutan)
      expect(await lihat(sDirektur, '&to=2000-01-01T00:00:00Z')).toEqual([]);
      expect((await lihat(sDirektur, '&from=2000-01-01T00:00:00Z')).length).toBe(4);
      await api(sDirektur, 'get', '/audit-logs?limit=500').expect(400);
      await api(sDirektur, 'get', '/audit-logs?from=kemarin').expect(400);
    });
    it('filter action memperlakukan % dan _ sebagai teks biasa (bukan wildcard)', async () => {
      const r = await api(sDirektur, 'get', '/audit-logs?action=%25').expect(200);
      expect(r.body.items).toEqual([]);
    });
    it('keluaran audit admin tidak memuat email atau kata sandi', async () => {
      const email = emailBaru();
      await api(peran('IT_ADMIN'), 'post', '/staff/invitations', { email, displayName: 'SINTETIS Rahasia Nama', roles: ['HRD'] }).expect(201);
      const r = await api(peran('DIREKTUR'), 'get', '/audit-logs?action=auth.&limit=100').expect(200);
      const teks = JSON.stringify(r.body);
      expect(teks).not.toContain(email);
      expect(teks).not.toContain('Rahasia Nama');
      expect(teks).not.toContain(PASSWORD);
    });
  });
});
