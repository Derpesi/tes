import 'reflect-metadata';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { generateSync } from 'otplib';
import { Pool } from 'pg';
import request from 'supertest';
import type { BootstrapService } from '../src/auth/bootstrap.service';
import type { PesanEmail } from '../src/notifications/templates';

const DB_URL = process.env.TEST_DATABASE_URL;
const jalan = DB_URL ? describe : describe.skip;

const ORIGIN = 'https://hris.contoh.invalid';
const SKEMA = `boot_${randomBytes(4).toString('hex')}`; // skema terpisah: sistem "kosong" tanpa mengganggu tes lain
const SECRETS = { APP_BASE_URL: ORIGIN, AUTH_HMAC_KEY: randomBytes(32).toString('base64'), APP_ENCRYPTION_KEY: randomBytes(32).toString('base64'), TRUST_PROXY: '1' };
Object.assign(process.env, SECRETS);
const URL_APP = `${DB_URL}${DB_URL?.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${SKEMA}`)}`;

const PASSWORD = 'kuda lari malam hari di sawah';
const sha = (s: string) => createHash('sha256').update(s).digest();

jalan('bootstrap administrator awal (skema terisolasi)', () => {
  let app: INestApplication;
  let pool: Pool;
  let svc: BootstrapService;
  let worker: import('../src/notifications/outbox.worker').OutboxWorker;
  const terkirim: PesanEmail[] = [];
  let nomorIp = 1;
  let nomorEmail = 1;

  beforeAll(async () => {
    execFileSync('node', ['scripts/migrate.js', 'up'], { env: { ...process.env, DATABASE_URL: DB_URL, MIGRATE_SCHEMA: SKEMA } });
    process.env.DATABASE_URL = URL_APP;
    const { AppModule } = await import('../src/app.module');
    const { konfigurasiApp } = await import('../src/app.factory');
    const { EMAIL_CHANNEL } = await import('../src/notifications/email.channel');
    const { BootstrapService } = await import('../src/auth/bootstrap.service');
    const { OutboxWorker } = await import('../src/notifications/outbox.worker');
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EMAIL_CHANNEL)
      .useValue({ tersedia: () => true, kirim: async (p: PesanEmail) => void terkirim.push(p) })
      .compile();
    app = mod.createNestApplication();
    konfigurasiApp(app);
    await app.init();
    svc = app.get(BootstrapService);
    worker = app.get(OutboxWorker);
    pool = new Pool({ connectionString: URL_APP, max: 3 });
  });
  afterAll(async () => {
    await pool?.end();
    await app?.close();
    const admin = new Pool({ connectionString: DB_URL, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SKEMA} CASCADE`);
    await admin.end();
  });
  beforeEach(async () => {
    terkirim.length = 0;
    // Kembali ke keadaan "sistem baru": tanpa staff, bootstrap belum selesai.
    await pool.query(`TRUNCATE users, persons, notification_outbox RESTART IDENTITY CASCADE`);
    await pool.query(`UPDATE system_state SET value = 'false'::jsonb WHERE key = 'bootstrapped'`);
  });

  // ---------- helper ----------
  const emailBaru = () => `boot${nomorEmail++}-${randomBytes(3).toString('hex')}@contoh.invalid`;
  const ipBaru = () => `10.50.${Math.floor(nomorIp / 250)}.${(nomorIp++ % 250) + 1}`;
  const http = (metode: 'get' | 'post', path: string, o: { cookie?: string; csrf?: string } = {}) => {
    let r = request(app.getHttpServer())[metode](path).set('X-Forwarded-For', ipBaru()).set('Origin', ORIGIN);
    if (o.cookie) r = r.set('Cookie', o.cookie);
    if (o.csrf) r = r.set('X-CSRF-Token', o.csrf);
    return r;
  };
  const cookieDari = (res: request.Response) => ((res.headers['set-cookie'] as unknown as string[] | undefined)?.find((x) => x.startsWith('__Host-sid=')) ?? '').split(';')[0];
  const tokenDariLink = (link: string) => new URL(link).searchParams.get('token')!;
  const kirimEmail = async () => {
    for (let i = 0; i < 50 && (await worker.prosesBatch(100)) > 0; i++);
  };
  /** Menerima undangan + mendaftarkan TOTP -> sesi penuh. */
  async function aktifkan(token: string) {
    const acc = await http('post', '/auth/staff/invitation/accept').send({ token, password: PASSWORD }).expect(200);
    const c1 = cookieDari(acc);
    const st = await http('post', '/auth/staff/mfa/enroll/start', { cookie: c1, csrf: acc.body.csrfToken }).expect(200);
    const conf = await http('post', '/auth/staff/mfa/enroll/confirm', { cookie: c1, csrf: acc.body.csrfToken }).send({ code: generateSync({ secret: st.body.secret }) }).expect(200);
    return { cookie: cookieDari(conf), csrf: conf.body.csrfToken as string, secret: st.body.secret as string };
  }
  const bacaAudit = async (aksi: string) => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.audit_global', 'on', true)`);
      const r = await c.query(`SELECT detail::text AS d FROM audit_logs WHERE action = $1`, [aksi]);
      await c.query('ROLLBACK');
      return r.rows.map((x) => x.d as string);
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  };
  const status = async () => (await pool.query(`SELECT value FROM system_state WHERE key = 'bootstrapped'`)).rows[0].value as boolean;

  // ---------- bootstrap pertama ----------
  describe('bootstrap pertama', () => {
    it('membuat admin awal tanpa kredensial default; tautan hanya dikembalikan sekali dan tidak tersimpan mentah di mana pun', async () => {
      const email = emailBaru();
      const h = await svc.jalankan({ email: email.toUpperCase(), namaTampilan: 'SINTETIS Admin' });
      expect(h.mode).toBe('BARU');
      expect(h.link).toMatch(new RegExp(`^${ORIGIN}/undangan\\?token=[A-Za-z0-9_-]{43}$`));
      const token = tokenDariLink(h.link!);

      const u = await pool.query(`SELECT id, email, status FROM users WHERE realm = 'staff'`);
      expect(u.rows).toEqual([{ id: h.userId, email: email.toLowerCase(), status: 'DIUNDANG' }]);
      expect((await pool.query(`SELECT 1 FROM staff_credentials`)).rowCount).toBe(0); // tanpa kata sandi bawaan
      expect((await pool.query(`SELECT 1 FROM staff_mfa_factors`)).rowCount).toBe(0); // tanpa MFA/OTP bawaan
      const peran = await pool.query(`SELECT role_code, grant_source, granted_by, extract(epoch FROM (expires_at - now())) / 86400 AS hari FROM user_roles WHERE user_id = $1`, [h.userId]);
      expect(peran.rows[0]).toMatchObject({ role_code: 'IT_ADMIN', grant_source: 'BOOTSTRAP', granted_by: null });
      expect(Number(peran.rows[0].hari)).toBeGreaterThan(6.9);
      expect(Number(peran.rows[0].hari)).toBeLessThan(7.1);
      const inv = await pool.query(`SELECT token_hash, extract(epoch FROM (expires_at - now())) / 3600 AS jam FROM staff_invitations WHERE user_id = $1`, [h.userId]);
      expect((inv.rows[0].token_hash as Buffer).equals(sha(token))).toBe(true);
      expect(Number(inv.rows[0].jam)).toBeGreaterThan(23.9);
      expect(Number(inv.rows[0].jam)).toBeLessThan(24.1);

      // Tautan tidak dikirim lewat email/outbox dan tidak ada di audit.
      expect((await pool.query(`SELECT 1 FROM notification_outbox`)).rowCount).toBe(0);
      const audit = await bacaAudit('auth.bootstrap.started');
      expect(audit).toHaveLength(1);
      expect(audit[0]).not.toContain(token);
      expect(audit[0]).not.toContain(email.toLowerCase());
      expect(h.tautanBerlakuSampai!.getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);
    });

    it('tidak ada kata sandi/OTP bawaan yang dapat dipakai masuk', async () => {
      const email = emailBaru();
      await svc.jalankan({ email });
      for (const p of ['admin', 'password', 'bootstrap', 'Administrator Awal', 'kuda lari malam hari di sawah']) {
        await http('post', '/auth/staff/login').send({ email, password: p }).expect(401);
      }
    });

    it('format email tidak valid ditolak tanpa membuat akun', async () => {
      await expect(svc.jalankan({ email: 'bukan-email' })).rejects.toMatchObject({ response: { kode: 'EMAIL_TIDAK_VALID' } });
      expect((await pool.query(`SELECT 1 FROM users`)).rowCount).toBe(0);
    });

    it('menjalankan lagi tanpa --regenerate ditolak (staff sudah ada) dan tercatat', async () => {
      await svc.jalankan({ email: emailBaru() });
      await expect(svc.jalankan({ email: emailBaru() })).rejects.toMatchObject({ response: { kode: 'STAFF_SUDAH_ADA' } });
      expect((await pool.query(`SELECT 1 FROM users WHERE realm = 'staff'`)).rowCount).toBe(1);
      expect((await bacaAudit('auth.bootstrap.refused')).length).toBe(1);
    });

    it('dua bootstrap bersamaan: tepat satu berhasil', async () => {
      const hasil = await Promise.allSettled([svc.jalankan({ email: emailBaru() }), svc.jalankan({ email: emailBaru() })]);
      expect(hasil.filter((h) => h.status === 'fulfilled')).toHaveLength(1);
      expect((await pool.query(`SELECT 1 FROM users WHERE realm = 'staff'`)).rowCount).toBe(1);
    });
  });

  // ---------- aktivasi dan penutupan ----------
  describe('aktivasi admin dan penutupan bootstrap', () => {
    it('admin menyelesaikan kata sandi + TOTP; peran berlaku; undangan sekali pakai', async () => {
      const h = await svc.jalankan({ email: emailBaru() });
      const token = tokenDariLink(h.link!);
      const admin = await aktifkan(token);
      const me = await http('get', '/auth/me', { cookie: admin.cookie }).expect(200);
      expect(me.body.roles).toEqual(['IT_ADMIN']);
      expect(me.body.permissions).toContain('user_role.create');
      expect(await status()).toBe(false); // belum ada Direktur
      await http('post', '/auth/staff/invitation/accept').send({ token, password: PASSWORD }).expect(400);
      const peran = await pool.query(`SELECT extract(epoch FROM (expires_at - now())) / 86400 AS hari FROM user_roles WHERE user_id = $1`, [h.userId]);
      expect(Number(peran.rows[0].hari)).toBeGreaterThan(6.9); // 7 hari dihitung sejak aktivasi
    });

    it('alur penuh: admin menunjuk Direktur pertama; saat Direktur aktif bootstrap ditutup dan peran bootstrap dicabut', async () => {
      const h = await svc.jalankan({ email: emailBaru() });
      const admin = await aktifkan(tokenDariLink(h.link!));
      const emailDirektur = emailBaru();
      const r = await http('post', '/staff/invitations', { cookie: admin.cookie, csrf: admin.csrf }).send({ email: emailDirektur, displayName: 'SINTETIS Direktur', roles: ['DIREKTUR'] }).expect(201);
      expect(r.body.roles[0]).toMatchObject({ roleCode: 'DIREKTUR', status: 'DIBERIKAN', pengecualian: 'DIREKTUR_PERTAMA' });
      await kirimEmail();
      const tokenDirektur = /token=([A-Za-z0-9_-]+)/.exec(terkirim.find((m) => m.to === emailDirektur)!.text)![1];
      expect(await status()).toBe(false); // diundang belum berarti aktif

      const direktur = await aktifkan(tokenDirektur);
      expect(await status()).toBe(true);
      expect((await bacaAudit('auth.bootstrap.completed')).length).toBe(1);
      const aktif = await pool.query(`SELECT revoked_at FROM user_roles WHERE user_id = $1 AND grant_source = 'BOOTSTRAP'`, [h.userId]);
      expect(aktif.rows[0].revoked_at).not.toBeNull();
      await http('get', '/staff', { cookie: admin.cookie }).expect(403); // admin bootstrap kehilangan hak seketika
      const dir = await http('get', '/auth/me', { cookie: direktur.cookie }).expect(200);
      expect(dir.body.roles).toEqual(['DIREKTUR']);
      expect(dir.body.permissions).toContain('user_role.approve');

      await expect(svc.jalankan({ email: emailBaru(), regenerate: true })).rejects.toMatchObject({ response: { kode: 'BOOTSTRAP_SUDAH_SELESAI' } });
      await expect(svc.jalankan({ email: emailBaru() })).rejects.toMatchObject({ response: { kode: 'BOOTSTRAP_SUDAH_SELESAI' } });
    });

    it('peran bootstrap kedaluwarsa otomatis setelah 7 hari', async () => {
      const h = await svc.jalankan({ email: emailBaru() });
      const admin = await aktifkan(tokenDariLink(h.link!));
      await http('get', '/staff', { cookie: admin.cookie }).expect(200);
      await pool.query(`UPDATE user_roles SET expires_at = now() - interval '1 second' WHERE user_id = $1`, [h.userId]);
      await http('get', '/staff', { cookie: admin.cookie }).expect(403);
    });
  });

  // ---------- regenerate ----------
  describe('--regenerate (selama belum ada Direktur aktif)', () => {
    it('email sama dengan akun belum aktif: undangan baru, tautan lama mati', async () => {
      const email = emailBaru();
      const a = await svc.jalankan({ email });
      const b = await svc.jalankan({ email, regenerate: true });
      expect(b.mode).toBe('UNDANGAN_ULANG');
      expect(b.userId).toBe(a.userId);
      await http('post', '/auth/staff/invitation/accept').send({ token: tokenDariLink(a.link!), password: PASSWORD }).expect(400);
      await aktifkan(tokenDariLink(b.link!));
      expect((await bacaAudit('auth.bootstrap.regenerated')).length).toBe(1);
    });

    it('email berbeda: akun lama yang belum aktif dinonaktifkan dan tautannya mati', async () => {
      const a = await svc.jalankan({ email: emailBaru() });
      const b = await svc.jalankan({ email: emailBaru(), regenerate: true });
      expect(b.userId).not.toBe(a.userId);
      expect((await pool.query(`SELECT status FROM users WHERE id = $1`, [a.userId])).rows[0].status).toBe('NONAKTIF');
      expect((await pool.query(`SELECT 1 FROM user_roles WHERE user_id = $1 AND revoked_at IS NULL`, [a.userId])).rowCount).toBe(0);
      await http('post', '/auth/staff/invitation/accept').send({ token: tokenDariLink(a.link!), password: PASSWORD }).expect(400);
      await aktifkan(tokenDariLink(b.link!));
    });

    it('admin aktif yang perannya habis: peran diberikan ulang tanpa tautan baru', async () => {
      const email = emailBaru();
      const a = await svc.jalankan({ email });
      const admin = await aktifkan(tokenDariLink(a.link!));
      await pool.query(`UPDATE user_roles SET expires_at = now() - interval '1 second' WHERE user_id = $1`, [a.userId]);
      await http('get', '/staff', { cookie: admin.cookie }).expect(403);
      const b = await svc.jalankan({ email, regenerate: true });
      expect(b).toMatchObject({ mode: 'BERI_ULANG_PERAN', userId: a.userId });
      expect(b.link).toBeUndefined();
      await http('get', '/staff', { cookie: admin.cookie }).expect(200);
    });

    it('email milik akun nonaktif ditolak', async () => {
      const a = await svc.jalankan({ email: emailBaru() });
      const b = await svc.jalankan({ email: emailBaru(), regenerate: true });
      const email = (await pool.query(`SELECT email FROM users WHERE id = $1`, [a.userId])).rows[0].email;
      await expect(svc.jalankan({ email, regenerate: true })).rejects.toMatchObject({ response: { kode: 'STAFF_NONAKTIF' } });
      expect(b.mode).toBe('BARU');
    });
  });

  // ---------- CLI ----------
  describe('CLI', () => {
    const jalankanCli = (args: string[]) =>
      spawnSync(process.execPath, [require.resolve('ts-node/dist/bin.js'), '--transpile-only', 'scripts/bootstrap.ts', ...args], {
        env: { ...process.env, DATABASE_URL: URL_APP, NODE_ENV: 'production', ...SECRETS },
        encoding: 'utf8',
        timeout: 60_000,
      });

    it('menolak dijalankan tanpa terminal interaktif: tautan tidak pernah tercetak dan tidak ada akun dibuat', async () => {
      const r = jalankanCli(['--email', emailBaru()]);
      expect(r.status).toBe(3);
      expect(r.stderr).toMatch(/terminal interaktif/);
      expect(r.stdout + r.stderr).not.toMatch(/undangan\?token=/);
      expect((await pool.query(`SELECT 1 FROM users`)).rowCount).toBe(0);
    });

    it('tanpa --email menampilkan petunjuk pemakaian dan keluar bukan nol', () => {
      const r = jalankanCli([]);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/Pemakaian/);
    });
  });
});
