import 'reflect-metadata';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { generateSync } from 'otplib';
import { Pool } from 'pg';
import request from 'supertest';
import type { PesanEmail } from '../src/notifications/templates';

const URL = process.env.TEST_DATABASE_URL;
const jalan = URL ? describe : describe.skip;

// Konfigurasi sintetis acak per proses tes; tidak ada rahasia nyata.
const ORIGIN = 'https://hris.contoh.invalid';
process.env.APP_BASE_URL = ORIGIN;
process.env.AUTH_HMAC_KEY = randomBytes(32).toString('base64');
process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString('base64');
process.env.TRUST_PROXY = '1'; // agar tes dapat memakai IP berbeda lewat X-Forwarded-For

const PASSWORD = 'kuda lari malam hari di sawah';
const sha = (s: string) => createHash('sha256').update(s).digest();

jalan('autentikasi staff (PostgreSQL asli)', () => {
  let app: INestApplication;
  let pool: Pool;
  let invitations: import('../src/auth/invitation.service').InvitationService;
  let worker: import('../src/notifications/outbox.worker').OutboxWorker;
  const terkirim: PesanEmail[] = [];
  let kanalGagal = false;
  let nomorIp = 1;
  let nomorUser = 1;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    execFileSync('node', ['scripts/migrate.js', 'up'], { env: { ...process.env, DATABASE_URL: URL } });
    const { AppModule } = await import('../src/app.module');
    const { konfigurasiApp } = await import('../src/app.factory');
    const { EMAIL_CHANNEL } = await import('../src/notifications/email.channel');
    const { InvitationService } = await import('../src/auth/invitation.service');
    const { OutboxWorker } = await import('../src/notifications/outbox.worker');
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EMAIL_CHANNEL)
      .useValue({
        tersedia: () => true,
        kirim: async (p: PesanEmail) => {
          if (kanalGagal) throw new Error('smtp mati');
          terkirim.push(p);
        },
      })
      .compile();
    app = mod.createNestApplication();
    konfigurasiApp(app);
    await app.init();
    invitations = app.get(InvitationService);
    worker = app.get(OutboxWorker);
    pool = new Pool({ connectionString: URL, max: 3 });
  });
  afterAll(async () => {
    await pool?.end();
    await app?.close();
  });
  beforeEach(() => {
    terkirim.length = 0;
    kanalGagal = false;
  });

  // ---------- helper ----------
  const ipBaru = () => `10.20.${Math.floor(nomorIp / 250)}.${(nomorIp++ % 250) + 1}`;
  const http = (metode: 'get' | 'post', path: string, o: { cookie?: string; csrf?: string; origin?: string | null; ip?: string } = {}) => {
    let r = request(app.getHttpServer())[metode](path).set('X-Forwarded-For', o.ip ?? ipBaru());
    if (o.origin !== null) r = r.set('Origin', o.origin ?? ORIGIN);
    if (o.cookie) r = r.set('Cookie', o.cookie);
    if (o.csrf) r = r.set('X-CSRF-Token', o.csrf);
    return r;
  };
  const cookieDari = (res: request.Response): string => {
    const h = (res.headers['set-cookie'] as unknown as string[] | undefined)?.find((x) => x.startsWith('__Host-sid=')) ?? '';
    return h.split(';')[0];
  };
  const tokenDariEmail = (p: PesanEmail) => /token=([A-Za-z0-9_-]+)/.exec(p.text)![1];
  const kodeSekarang = (secret: string) => generateSync({ secret });
  /** Kode untuk time-step berikutnya: valid (toleransi ±30 dtk) dan berbeda dari kode pendaftaran. */
  const kodeBerikut = (secret: string) => generateSync({ secret, epoch: Math.floor(Date.now() / 1000) + 30 });
  const emailBaru = () => `staff${nomorUser++}-${randomBytes(3).toString('hex')}@contoh.invalid`;

  interface Staff {
    email: string;
    userId: string;
    secret: string;
    recoveryCodes: string[];
    cookie: string; // sesi PENUH hasil pendaftaran
    csrf: string;
  }
  /** Undang -> terima -> daftar MFA -> sesi penuh. */
  async function buatStaffAktif(): Promise<Staff> {
    const email = emailBaru();
    const u = await invitations.undang({ email, namaTampilan: 'SINTETIS Staff', diundangOleh: null });
    await worker.prosesBatch();
    const mail = terkirim.find((m) => m.to === email)!;
    const acc = await http('post', '/auth/staff/invitation/accept').send({ token: tokenDariEmail(mail), password: PASSWORD }).expect(200);
    const c1 = cookieDari(acc);
    const st = await http('post', '/auth/staff/mfa/enroll/start', { cookie: c1, csrf: acc.body.csrfToken }).expect(200);
    const secret: string = st.body.secret;
    const conf = await http('post', '/auth/staff/mfa/enroll/confirm', { cookie: c1, csrf: acc.body.csrfToken }).send({ code: kodeSekarang(secret) }).expect(200);
    return { email, userId: u.userId, secret, recoveryCodes: conf.body.recoveryCodes, cookie: cookieDari(conf), csrf: conf.body.csrfToken };
  }
  async function loginHinggaMfa(s: Staff, password = PASSWORD) {
    const r = await http('post', '/auth/staff/login').send({ email: s.email, password });
    return { res: r, cookie: cookieDari(r), csrf: r.body?.csrfToken as string };
  }
  const bacaAudit = async (aksi: string) => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.audit_global', 'on', true)`);
      const r = await c.query(`SELECT detail::text AS d, actor_id FROM audit_logs WHERE action = $1`, [aksi]);
      await c.query('ROLLBACK');
      return r.rows as { d: string; actor_id: string | null }[];
    } finally {
      c.release();
    }
  };

  // ---------- undangan & pendaftaran MFA ----------
  describe('undangan dan pendaftaran verifikasi dua langkah', () => {
    it('alur lengkap: undangan -> kata sandi -> TOTP -> sesi penuh; kode pemulihan 10 buah', async () => {
      const s = await buatStaffAktif();
      expect(s.recoveryCodes).toHaveLength(10);
      expect(new Set(s.recoveryCodes).size).toBe(10);
      s.recoveryCodes.forEach((k) => expect(k).toMatch(/^[A-HJKMNP-Z2-9]{5}-[A-HJKMNP-Z2-9]{5}$/));
      const me = await http('get', '/auth/me', { cookie: s.cookie }).expect(200);
      expect(me.body.state).toBe('PENUH');
      const u = await pool.query(`SELECT status FROM users WHERE id = $1`, [s.userId]);
      expect(u.rows[0].status).toBe('AKTIF');
    });

    it('cookie sesi memakai awalan __Host-, HttpOnly, Secure, Path=/, SameSite=Lax, tanpa Domain', async () => {
      const email = emailBaru();
      await invitations.undang({ email, namaTampilan: 'SINTETIS', diundangOleh: null });
      await worker.prosesBatch();
      const acc = await http('post', '/auth/staff/invitation/accept').send({ token: tokenDariEmail(terkirim[0]), password: PASSWORD }).expect(200);
      const h = (acc.headers['set-cookie'] as unknown as string[]).find((x) => x.startsWith('__Host-sid='))!;
      expect(h).toMatch(/HttpOnly/i);
      expect(h).toMatch(/Secure/i);
      expect(h).toMatch(/Path=\//);
      expect(h).toMatch(/SameSite=Lax/i);
      expect(h).not.toMatch(/Domain=/i);
    });

    it('kata sandi lemah ditolak dengan pesan Indonesia dan undangan tidak terpakai', async () => {
      const email = emailBaru();
      await invitations.undang({ email, namaTampilan: 'SINTETIS', diundangOleh: null });
      await worker.prosesBatch();
      const token = tokenDariEmail(terkirim[0]);
      const r = await http('post', '/auth/staff/invitation/accept').send({ token, password: 'pendek' }).expect(400);
      expect(r.body.kode).toBe('PASSWORD_LEMAH');
      expect(r.body.pesan).toMatch(/minimal 12 karakter/);
      await http('post', '/auth/staff/invitation/accept').send({ token, password: PASSWORD }).expect(200); // masih bisa dipakai
    });

    it('undangan hanya sekali pakai; kedaluwarsa dan token acak ditolak', async () => {
      const email = emailBaru();
      await invitations.undang({ email, namaTampilan: 'SINTETIS', diundangOleh: null });
      await worker.prosesBatch();
      const token = tokenDariEmail(terkirim[0]);
      await http('post', '/auth/staff/invitation/accept').send({ token, password: PASSWORD }).expect(200);
      const lagi = await http('post', '/auth/staff/invitation/accept').send({ token, password: PASSWORD }).expect(400);
      expect(lagi.body.kode).toBe('UNDANGAN_TIDAK_VALID');

      const email2 = emailBaru();
      await invitations.undang({ email: email2, namaTampilan: 'SINTETIS', diundangOleh: null });
      await worker.prosesBatch();
      const token2 = tokenDariEmail(terkirim[terkirim.length - 1]);
      await pool.query(`UPDATE staff_invitations SET expires_at = now() - interval '1 minute' WHERE token_hash = $1`, [sha(token2)]);
      await http('post', '/auth/staff/invitation/accept').send({ token: token2, password: PASSWORD }).expect(400);
      await http('post', '/auth/staff/invitation/accept').send({ token: randomBytes(32).toString('base64url'), password: PASSWORD }).expect(400);
    });

    it('mengundang ulang email yang sudah berkredensial ditolak (409); undangan lama dicabut saat dikirim ulang', async () => {
      const s = await buatStaffAktif();
      await expect(invitations.undang({ email: s.email, namaTampilan: 'X', diundangOleh: null })).rejects.toMatchObject({ status: 409 });
      const email = emailBaru();
      await invitations.undang({ email, namaTampilan: 'SINTETIS', diundangOleh: null });
      await invitations.undang({ email, namaTampilan: 'SINTETIS', diundangOleh: null });
      await worker.prosesBatch();
      const [lama, baru] = terkirim.filter((m) => m.to === email).map(tokenDariEmail);
      await http('post', '/auth/staff/invitation/accept').send({ token: lama, password: PASSWORD }).expect(400);
      await http('post', '/auth/staff/invitation/accept').send({ token: baru, password: PASSWORD }).expect(200);
    });

    it('tidak ada pendaftaran publik staff', async () => {
      await http('post', '/auth/staff/register').send({ email: emailBaru(), password: PASSWORD }).expect(404);
    });

    it('sesi pendaftaran MFA tidak dapat mengakses endpoint sesi penuh maupun verifikasi MFA', async () => {
      const email = emailBaru();
      await invitations.undang({ email, namaTampilan: 'SINTETIS', diundangOleh: null });
      await worker.prosesBatch();
      const acc = await http('post', '/auth/staff/invitation/accept').send({ token: tokenDariEmail(terkirim[0]), password: PASSWORD }).expect(200);
      const c = cookieDari(acc);
      const me = await http('get', '/auth/me', { cookie: c }).expect(403);
      expect(me.body.kode).toBe('DAFTAR_MFA_DIPERLUKAN');
      await http('post', '/auth/staff/mfa/verify', { cookie: c, csrf: acc.body.csrfToken }).send({ code: '123456' }).expect(403);
      const info = await http('get', '/auth/session', { cookie: c }).expect(200);
      expect(info.body.state).toBe('MENUNGGU_ENROLL_MFA');
    });

    it('kode pendaftaran MFA salah ditolak dan akun belum aktif', async () => {
      const email = emailBaru();
      const { userId } = await invitations.undang({ email, namaTampilan: 'SINTETIS', diundangOleh: null });
      await worker.prosesBatch();
      const acc = await http('post', '/auth/staff/invitation/accept').send({ token: tokenDariEmail(terkirim[0]), password: PASSWORD }).expect(200);
      const c = cookieDari(acc);
      await http('post', '/auth/staff/mfa/enroll/start', { cookie: c, csrf: acc.body.csrfToken }).expect(200);
      await http('post', '/auth/staff/mfa/enroll/confirm', { cookie: c, csrf: acc.body.csrfToken }).send({ code: '000000' }).expect(401);
      const u = await pool.query(`SELECT status FROM users WHERE id = $1`, [userId]);
      expect(u.rows[0].status).toBe('DIUNDANG');
    });
  });

  // ---------- login ----------
  describe('login dengan verifikasi dua langkah', () => {
    it('kata sandi benar saja TIDAK memberi akses; setelah TOTP sesi dirotasi dan penuh', async () => {
      const s = await buatStaffAktif();
      const { res, cookie, csrf } = await loginHinggaMfa(s);
      expect(res.status).toBe(200);
      expect(res.body.nextStep).toBe('MFA');
      const sebelum = await http('get', '/auth/me', { cookie }).expect(403);
      expect(sebelum.body.kode).toBe('MFA_DIPERLUKAN');
      const v = await http('post', '/auth/staff/mfa/verify', { cookie, csrf }).send({ code: kodeBerikut(s.secret) }).expect(200);
      const cookieBaru = cookieDari(v);
      expect(cookieBaru).not.toBe(cookie); // rotasi: cegah session fixation
      await http('get', '/auth/me', { cookie }).expect(401); // token lama mati
      const me = await http('get', '/auth/me', { cookie: cookieBaru }).expect(200);
      expect(me.body.user.email).toBe(s.email);
    });

    it('respons gagal SERAGAM: salah kata sandi, email tak dikenal, dan akun terkunci', async () => {
      const s = await buatStaffAktif();
      const salah = await http('post', '/auth/staff/login').send({ email: s.email, password: 'salah-salah-salah' });
      const takDikenal = await http('post', '/auth/staff/login').send({ email: emailBaru(), password: 'salah-salah-salah' });
      expect(salah.status).toBe(401);
      expect(takDikenal.status).toBe(401);
      expect(salah.body).toEqual(takDikenal.body);
      expect(salah.body.kode).toBe('LOGIN_GAGAL');
      expect(salah.headers['set-cookie']).toBeUndefined();
    });

    it('5 gagal berturut-turut mengunci 15 menit (juga untuk email tak dikenal); pulih setelah masa kunci', async () => {
      const s = await buatStaffAktif();
      for (let i = 0; i < 5; i++) await http('post', '/auth/staff/login').send({ email: s.email, password: 'salah-salah-salah' }).expect(401);
      const terkunci = await http('post', '/auth/staff/login').send({ email: s.email, password: PASSWORD });
      expect(terkunci.status).toBe(401); // kata sandi BENAR tetap ditolak saat terkunci
      expect(terkunci.body.kode).toBe('LOGIN_GAGAL');

      const hantu = emailBaru();
      for (let i = 0; i < 5; i++) await http('post', '/auth/staff/login').send({ email: hantu, password: 'x-x-x-x-x-x-x-x-x' }).expect(401);
      const r = await http('post', '/auth/staff/login').send({ email: hantu, password: 'x-x-x-x-x-x-x-x-x' });
      expect(r.status).toBe(401);
      expect(r.body).toEqual(terkunci.body);

      await pool.query(`UPDATE login_attempts SET occurred_at = now() - interval '16 minutes' WHERE reason = 'TERKUNCI' AND user_id = $1`, [s.userId]);
      await http('post', '/auth/staff/login').send({ email: s.email, password: PASSWORD }).expect(200);
    });

    it('kegagalan MFA ikut menghitung ke kunci akun dan mencabut sesi tertunda', async () => {
      const s = await buatStaffAktif();
      const { cookie, csrf } = await loginHinggaMfa(s);
      for (let i = 0; i < 5; i++) await http('post', '/auth/staff/mfa/verify', { cookie, csrf }).send({ code: '000000' }).expect(401);
      await http('get', '/auth/session', { cookie }).expect(401); // sesi dicabut saat terkunci
      await http('post', '/auth/staff/login').send({ email: s.email, password: PASSWORD }).expect(401);
    });

    it('kode TOTP tidak dapat dipakai ulang (replay) dan kode kedaluwarsa ditolak', async () => {
      const s = await buatStaffAktif();
      const kode = kodeBerikut(s.secret);
      const a = await loginHinggaMfa(s);
      await http('post', '/auth/staff/mfa/verify', { cookie: a.cookie, csrf: a.csrf }).send({ code: kode }).expect(200);
      const b = await loginHinggaMfa(s);
      const ulang = await http('post', '/auth/staff/mfa/verify', { cookie: b.cookie, csrf: b.csrf }).send({ code: kode });
      expect(ulang.status).toBe(401);
      expect(ulang.body.kode).toBe('MFA_GAGAL');
      const lama = generateSync({ secret: s.secret, epoch: Math.floor(Date.now() / 1000) - 120 });
      await http('post', '/auth/staff/mfa/verify', { cookie: b.cookie, csrf: b.csrf }).send({ code: lama }).expect(401);
    });

    it('kode pemulihan berlaku sekali pakai', async () => {
      const s = await buatStaffAktif();
      const kode = s.recoveryCodes[0];
      const a = await loginHinggaMfa(s);
      await http('post', '/auth/staff/mfa/verify', { cookie: a.cookie, csrf: a.csrf }).send({ code: kode.toLowerCase() }).expect(200);
      const b = await loginHinggaMfa(s);
      await http('post', '/auth/staff/mfa/verify', { cookie: b.cookie, csrf: b.csrf }).send({ code: kode }).expect(401);
      const c = await loginHinggaMfa(s);
      await http('post', '/auth/staff/mfa/verify', { cookie: c.cookie, csrf: c.csrf }).send({ code: s.recoveryCodes[1] }).expect(200);
    });

    it('akun NONAKTIF tidak dapat masuk dan sesi yang ada langsung tidak berlaku', async () => {
      const s = await buatStaffAktif();
      await http('get', '/auth/me', { cookie: s.cookie }).expect(200);
      await pool.query(`UPDATE users SET status = 'NONAKTIF' WHERE id = $1`, [s.userId]);
      await http('get', '/auth/me', { cookie: s.cookie }).expect(401);
      const r = await http('post', '/auth/staff/login').send({ email: s.email, password: PASSWORD });
      expect(r.status).toBe(401);
      expect(r.body.kode).toBe('LOGIN_GAGAL');
    });
  });

  // ---------- sesi & CSRF ----------
  describe('sesi dan CSRF', () => {
    it('rute tanpa sesi ditolak (deny-by-default); /health tetap publik', async () => {
      const r = await http('get', '/auth/session').expect(401);
      expect(r.body.kode).toBe('BELUM_MASUK');
      await http('get', '/auth/me').expect(401);
      await http('get', '/health').expect(200);
    });

    it('batas tidak aktif 30 menit dan batas mutlak sesi ditegakkan', async () => {
      const s = await buatStaffAktif();
      const token = s.cookie.split('=')[1];
      await pool.query(`UPDATE sessions SET last_seen_at = now() - interval '31 minutes' WHERE token_hash = $1`, [sha(token)]);
      await http('get', '/auth/me', { cookie: s.cookie }).expect(401);

      const t = await buatStaffAktif();
      const token2 = t.cookie.split('=')[1];
      await pool.query(`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE token_hash = $1`, [sha(token2)]);
      await http('get', '/auth/me', { cookie: t.cookie }).expect(401);
    });

    it('CSRF: method tulis tanpa/dengan token salah ditolak; Origin salah atau hilang ditolak', async () => {
      const s = await buatStaffAktif();
      const tanpa = await http('post', '/auth/logout', { cookie: s.cookie }).expect(403);
      expect(tanpa.body.kode).toBe('CSRF_TIDAK_VALID');
      await http('post', '/auth/logout', { cookie: s.cookie, csrf: 'salah' }).expect(403);
      const origin = await http('post', '/auth/logout', { cookie: s.cookie, csrf: s.csrf, origin: 'https://jahat.contoh.invalid' }).expect(403);
      expect(origin.body.kode).toBe('ASAL_TIDAK_VALID');
      await http('post', '/auth/logout', { cookie: s.cookie, csrf: s.csrf, origin: null }).expect(403);
      await http('post', '/auth/logout', { cookie: s.cookie, csrf: s.csrf }).expect(200);
      await http('get', '/auth/me', { cookie: s.cookie }).expect(401); // logout mencabut sesi
    });

    it('Origin juga diperiksa untuk endpoint publik (login CSRF)', async () => {
      const r = await http('post', '/auth/staff/login', { origin: 'https://jahat.contoh.invalid' }).send({ email: emailBaru(), password: PASSWORD }).expect(403);
      expect(r.body.kode).toBe('ASAL_TIDAK_VALID');
    });

    it('token CSRF terikat sesi: token sesi lain tidak berlaku', async () => {
      const a = await buatStaffAktif();
      const b = await buatStaffAktif();
      await http('post', '/auth/logout', { cookie: a.cookie, csrf: b.csrf }).expect(403);
    });
  });

  // ---------- reset password ----------
  describe('lupa dan reset kata sandi', () => {
    it('respons lupa kata sandi sama untuk email terdaftar dan tidak; email hanya terkirim untuk yang terdaftar', async () => {
      const s = await buatStaffAktif();
      const a = await http('post', '/auth/staff/password/forgot').send({ email: s.email }).expect(202);
      const b = await http('post', '/auth/staff/password/forgot').send({ email: emailBaru() }).expect(202);
      expect(a.body).toEqual(b.body);
      await worker.prosesBatch();
      expect(terkirim.filter((m) => m.subject.includes('Atur ulang'))).toHaveLength(1);
    });

    it('reset: sesi lama dicabut, kata sandi lama mati, token sekali pakai, MFA tetap wajib', async () => {
      const s = await buatStaffAktif();
      await http('post', '/auth/staff/password/forgot').send({ email: s.email }).expect(202);
      await worker.prosesBatch();
      const token = tokenDariEmail(terkirim.find((m) => m.subject.includes('Atur ulang'))!);
      const lemah = await http('post', '/auth/staff/password/reset').send({ token, password: 'pendek' }).expect(400);
      expect(lemah.body.kode).toBe('PASSWORD_LEMAH');
      const baru = 'sawah hijau di lembah subur';
      await http('post', '/auth/staff/password/reset').send({ token, password: baru }).expect(200);
      await http('post', '/auth/staff/password/reset').send({ token, password: baru }).expect(400); // sekali pakai
      await http('get', '/auth/me', { cookie: s.cookie }).expect(401); // sesi lama dicabut
      await http('post', '/auth/staff/login').send({ email: s.email, password: PASSWORD }).expect(401);
      const l = await http('post', '/auth/staff/login').send({ email: s.email, password: baru }).expect(200);
      expect(l.body.nextStep).toBe('MFA'); // reset tidak menghapus MFA
    });

    it('token reset kedaluwarsa ditolak dan permintaan dibatasi 3 per jam per akun', async () => {
      const s = await buatStaffAktif();
      for (let i = 0; i < 4; i++) await http('post', '/auth/staff/password/forgot').send({ email: s.email }).expect(202);
      await worker.prosesBatch(20);
      const surat = terkirim.filter((m) => m.subject.includes('Atur ulang'));
      expect(surat).toHaveLength(3);
      const token = tokenDariEmail(surat[2]);
      await pool.query(`UPDATE password_reset_tokens SET expires_at = now() - interval '1 minute' WHERE token_hash = $1`, [sha(token)]);
      await http('post', '/auth/staff/password/reset').send({ token, password: 'sawah hijau di lembah subur' }).expect(400);
    });
  });

  // ---------- rate limit ----------
  describe('pembatas laju', () => {
    it('login lebih dari batas per menit dari satu IP menghasilkan 429 berbahasa Indonesia', async () => {
      const ip = ipBaru();
      const hasil: request.Response[] = [];
      for (let i = 0; i < 12; i++) hasil.push(await http('post', '/auth/staff/login', { ip }).send({ email: emailBaru(), password: 'x-x-x-x-x-x-x-x-x' }));
      const tertolak = hasil.filter((r) => r.status === 429);
      expect(tertolak.length).toBeGreaterThan(0);
      expect(tertolak[0].body.pesan).toMatch(/Terlalu banyak permintaan/);
    });
  });

  // ---------- penyimpanan & audit ----------
  describe('penyimpanan aman dan audit', () => {
    it('hanya hash token yang disimpan; secret MFA terenkripsi; kode pemulihan di-hash', async () => {
      const s = await buatStaffAktif();
      const token = s.cookie.split('=')[1];
      const sesi = await pool.query(`SELECT token_hash FROM sessions WHERE user_id = $1`, [s.userId]);
      for (const r of sesi.rows) expect((r.token_hash as Buffer).includes(Buffer.from(token))).toBe(false);
      expect(sesi.rows.some((r) => (r.token_hash as Buffer).equals(sha(token)))).toBe(true);
      const f = await pool.query(`SELECT secret_enc FROM staff_mfa_factors WHERE user_id = $1 AND status = 'AKTIF'`, [s.userId]);
      expect((f.rows[0].secret_enc as Buffer).includes(Buffer.from(s.secret))).toBe(false);
      const rc = await pool.query(`SELECT code_hash FROM mfa_recovery_codes WHERE user_id = $1`, [s.userId]);
      expect(rc.rowCount).toBe(10);
      for (const r of rc.rows) for (const k of s.recoveryCodes) expect((r.code_hash as Buffer).includes(Buffer.from(k.replace('-', '')))).toBe(false);
      const cred = await pool.query(`SELECT password_hash FROM staff_credentials WHERE user_id = $1`, [s.userId]);
      expect(cred.rows[0].password_hash).toMatch(/^\$argon2id\$/);
    });

    it('outbox: payload terenkripsi (tanpa tautan mentah) dan dikosongkan setelah terkirim', async () => {
      const email = emailBaru();
      await invitations.undang({ email, namaTampilan: 'SINTETIS', diundangOleh: null });
      const sebelum = await pool.query(`SELECT payload_enc, status FROM notification_outbox WHERE recipient = $1`, [email]);
      expect(sebelum.rows[0].status).toBe('MENUNGGU');
      expect((sebelum.rows[0].payload_enc as Buffer).includes(Buffer.from('/undangan?token='))).toBe(false);
      await worker.prosesBatch();
      const sesudah = await pool.query(`SELECT payload_enc, status FROM notification_outbox WHERE recipient = $1`, [email]);
      expect(sesudah.rows[0]).toMatchObject({ status: 'TERKIRIM', payload_enc: null });
    });

    it('outbox: pengiriman gagal dicoba ulang dengan backoff; hanya nama error disimpan', async () => {
      const email = emailBaru();
      await invitations.undang({ email, namaTampilan: 'SINTETIS', diundangOleh: null });
      kanalGagal = true;
      await worker.prosesBatch();
      const r = await pool.query(`SELECT status, attempts, last_error, next_attempt_at > now() AS ditunda FROM notification_outbox WHERE recipient = $1`, [email]);
      expect(r.rows[0]).toMatchObject({ status: 'MENUNGGU', attempts: 1, last_error: 'Error', ditunda: true });
      expect(terkirim).toHaveLength(0);
    });

    it('audit mencatat login, kegagalan, dan pendaftaran tanpa email atau kata sandi', async () => {
      const s = await buatStaffAktif();
      await http('post', '/auth/staff/login').send({ email: s.email, password: 'salah-salah-salah' }).expect(401);
      const gagal = await bacaAudit('auth.login.failed');
      const sukses = await bacaAudit('auth.login.success');
      const daftar = await bacaAudit('auth.mfa.enrolled');
      expect(gagal.length).toBeGreaterThan(0);
      expect(sukses.length).toBeGreaterThan(0);
      expect(daftar.some((r) => r.actor_id === s.userId)).toBe(true);
      for (const r of [...gagal, ...sukses, ...daftar]) {
        expect(r.d).not.toContain(s.email);
        expect(r.d).not.toContain('salah-salah');
        expect(r.d).not.toContain(PASSWORD);
      }
    });
  });
});
