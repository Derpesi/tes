import 'reflect-metadata';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { generateSync } from 'otplib';
import { Pool } from 'pg';
import request from 'supertest';
import { returnToAman } from '../src/auth/member-auth.service';
import type { PesanEmail } from '../src/notifications/templates';
import { IdpPalsu, KlaimUji, OpsiToken, mulaiIdpPalsu } from './helpers/idp-palsu';

const DB_URL = process.env.TEST_DATABASE_URL;
const jalan = DB_URL ? describe : describe.skip;

// Konfigurasi sintetis acak; tidak ada rahasia nyata.
const ORIGIN = 'https://hris.contoh.invalid';
process.env.APP_BASE_URL = ORIGIN;
process.env.AUTH_HMAC_KEY = randomBytes(32).toString('base64');
process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString('base64');
process.env.TRUST_PROXY = '1';

const PASSWORD = 'kuda lari malam hari di sawah';
const sha = (s: string) => createHash('sha256').update(s).digest();

jalan('login member via Google OIDC (IdP palsu lokal)', () => {
  let idp: IdpPalsu;
  let app: INestApplication;
  let pool: Pool;
  let invitations: import('../src/auth/invitation.service').InvitationService;
  let worker: import('../src/notifications/outbox.worker').OutboxWorker;
  const terkirim: PesanEmail[] = [];
  let nomorIp = 1;

  beforeAll(async () => {
    idp = await mulaiIdpPalsu();
    process.env.GOOGLE_ISSUER = idp.issuer;
    process.env.GOOGLE_CLIENT_ID = idp.clientId;
    process.env.GOOGLE_CLIENT_SECRET = idp.clientSecret;
    process.env.DATABASE_URL = DB_URL;
    execFileSync('node', ['scripts/migrate.js', 'up'], { env: { ...process.env, DATABASE_URL: DB_URL } });
    const { AppModule } = await import('../src/app.module');
    const { konfigurasiApp } = await import('../src/app.factory');
    const { EMAIL_CHANNEL } = await import('../src/notifications/email.channel');
    const { InvitationService } = await import('../src/auth/invitation.service');
    const { OutboxWorker } = await import('../src/notifications/outbox.worker');
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EMAIL_CHANNEL)
      .useValue({ tersedia: () => true, kirim: async (p: PesanEmail) => void terkirim.push(p) })
      .compile();
    app = mod.createNestApplication();
    konfigurasiApp(app);
    await app.init();
    invitations = app.get(InvitationService);
    worker = app.get(OutboxWorker);
    pool = new Pool({ connectionString: DB_URL, max: 3 });
  });
  afterAll(async () => {
    await pool?.end();
    await app?.close();
    await idp?.berhenti();
  });
  beforeEach(() => {
    terkirim.length = 0;
  });

  // ---------- helper ----------
  const ipBaru = () => `10.30.${Math.floor(nomorIp / 250)}.${(nomorIp++ % 250) + 1}`;
  const get = (path: string, o: { cookie?: string } = {}) => {
    let r = request(app.getHttpServer()).get(path).set('X-Forwarded-For', ipBaru());
    if (o.cookie) r = r.set('Cookie', o.cookie);
    return r;
  };
  const post = (path: string, o: { cookie?: string; csrf?: string } = {}) => {
    let r = request(app.getHttpServer()).post(path).set('X-Forwarded-For', ipBaru()).set('Origin', ORIGIN);
    if (o.cookie) r = r.set('Cookie', o.cookie);
    if (o.csrf) r = r.set('X-CSRF-Token', o.csrf);
    return r;
  };
  const cookieNamed = (res: request.Response, nama: string): string => {
    const h = (res.headers['set-cookie'] as unknown as string[] | undefined)?.find((x) => x.startsWith(`${nama}=`)) ?? '';
    return h.split(';')[0];
  };
  const klaimBaru = (): KlaimUji => ({ sub: `sub-${randomBytes(6).toString('hex')}`, email: `member-${randomBytes(4).toString('hex')}@contoh.invalid`, name: 'SINTETIS Member' });
  const galatDari = (res: request.Response) => new URLSearchParams((res.headers.location as string).split('?')[1] ?? '').get('galat');

  /** start -> (Google menerbitkan kode) -> callback. */
  async function login(klaim: KlaimUji, opsi: OpsiToken = {}, opsiStart: { returnTo?: string; cookieSesi?: string } = {}) {
    const mulai = await get(`/auth/member/google/start${opsiStart.returnTo ? `?returnTo=${encodeURIComponent(opsiStart.returnTo)}` : ''}`).expect(302);
    const { query, params } = idp.terbitkanKode(mulai.headers.location, klaim, opsi);
    const binding = cookieNamed(mulai, '__Host-oidc');
    const cb = await get(`/auth/member/google/callback?${query}`, { cookie: [binding, opsiStart.cookieSesi].filter(Boolean).join('; ') });
    return { mulai, params, query, binding, cb, sesi: cookieNamed(cb, '__Host-sid') };
  }
  const jumlahUser = async (email: string) => (await pool.query(`SELECT count(*)::int AS n FROM users WHERE realm = 'member' AND email = $1`, [email])).rows[0].n as number;
  const bacaAudit = async (aksi: string) => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.audit_global', 'on', true)`);
      const r = await c.query(`SELECT detail::text AS d FROM audit_logs WHERE action = $1`, [aksi]);
      await c.query('ROLLBACK');
      return r.rows.map((x) => x.d as string);
    } finally {
      c.release();
    }
  };

  // ---------- start ----------
  describe('memulai login', () => {
    it('mengalihkan ke Google dengan PKCE S256, state, nonce, redirect_uri persis, dan cookie pengikat aman', async () => {
      const r = await get('/auth/member/google/start').expect(302);
      const u = new URL(r.headers.location);
      expect(u.origin + u.pathname).toBe(`${idp.issuer}/authorize`);
      const p = u.searchParams;
      expect(p.get('response_type')).toBe('code');
      expect(p.get('client_id')).toBe(idp.clientId);
      expect(p.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/member/google/callback`);
      expect(p.get('scope')).toBe('openid email profile');
      expect(p.get('code_challenge_method')).toBe('S256');
      expect(p.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(p.get('state')!.length).toBeGreaterThanOrEqual(20);
      expect(p.get('nonce')!.length).toBeGreaterThanOrEqual(20);
      expect(p.get('prompt')).toBe('select_account');
      expect(p.get('access_type')).toBeNull(); // tidak meminta refresh token
      const set = (r.headers['set-cookie'] as unknown as string[]).find((x) => x.startsWith('__Host-oidc='))!;
      expect(set).toMatch(/HttpOnly/i);
      expect(set).toMatch(/Secure/i);
      expect(set).toMatch(/Path=\//);
      expect(set).toMatch(/SameSite=Lax/i);
      expect(set).not.toMatch(/Domain=/i);
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.headers['referrer-policy']).toBe('no-referrer');
    });

    it('state dan nonce berbeda tiap permintaan', async () => {
      const a = new URL((await get('/auth/member/google/start')).headers.location).searchParams;
      const b = new URL((await get('/auth/member/google/start')).headers.location).searchParams;
      expect(a.get('state')).not.toBe(b.get('state'));
      expect(a.get('nonce')).not.toBe(b.get('nonce'));
    });

    it('state dan pengikat hanya disimpan sebagai hash; code_verifier terenkripsi', async () => {
      const m = await get('/auth/member/google/start').expect(302);
      const state = new URL(m.headers.location).searchParams.get('state')!;
      const binding = cookieNamed(m, '__Host-oidc').split('=')[1];
      const r = await pool.query(`SELECT state_hash, binding_hash, code_verifier_enc FROM oidc_transactions WHERE state_hash = $1`, [sha(state)]);
      expect(r.rowCount).toBe(1);
      expect((r.rows[0].state_hash as Buffer).includes(Buffer.from(state))).toBe(false);
      expect((r.rows[0].binding_hash as Buffer).equals(sha(binding))).toBe(true);
      expect((r.rows[0].code_verifier_enc as Buffer).length).toBe(12 + 16 + 43); // iv + tag + verifier 43 karakter (terenkripsi)
    });
  });

  // ---------- alur sukses ----------
  describe('alur sukses', () => {
    it('member baru: akun, identitas Google, dan sesi PENUH terbentuk; tanpa endpoint kata sandi', async () => {
      const k = klaimBaru();
      const { cb, sesi } = await login(k);
      expect(cb.status).toBe(302);
      expect(cb.headers.location).toBe(`${ORIGIN}/`);
      const set = (cb.headers['set-cookie'] as unknown as string[]).find((x) => x.startsWith('__Host-sid='))!;
      expect(set).toMatch(/HttpOnly/i);
      expect(set).toMatch(/Secure/i);
      expect(set).toMatch(/SameSite=Lax/i);
      expect(set).not.toMatch(/Domain=/i);
      expect(cb.headers['cache-control']).toBe('no-store');
      const u = await pool.query(`SELECT u.id, u.realm, u.status, g.google_sub FROM users u JOIN google_identities g ON g.user_id = u.id WHERE u.email = $1`, [k.email!.toLowerCase()]);
      expect(u.rows[0]).toMatchObject({ realm: 'member', status: 'AKTIF', google_sub: k.sub });
      const me = await get('/auth/member/me', { cookie: sesi }).expect(200);
      expect(me.body).toMatchObject({ realm: 'member', state: 'PENUH', user: { email: k.email!.toLowerCase() } });
      const info = await get('/auth/session', { cookie: sesi }).expect(200);
      expect(info.body.realm).toBe('member');
      await request(app.getHttpServer()).post('/auth/member/login').set('Origin', ORIGIN).send({ email: k.email, password: PASSWORD }).expect(404);
      await request(app.getHttpServer()).post('/auth/member/register').set('Origin', ORIGIN).send({}).expect(404);
    });

    it('PKCE benar-benar dikirim: IdP memverifikasi code_verifier dan kredensial klien', async () => {
      const sebelum = idp.permintaanToken.length;
      await login(klaimBaru());
      const baru = idp.permintaanToken.slice(sebelum);
      expect(baru).toEqual([{ pkceOk: true, clientOk: true }]);
    });

    it('login kedua dengan akun Google yang sama masuk ke user yang sama (tanpa duplikat)', async () => {
      const k = klaimBaru();
      const a = await login(k);
      const b = await login(k);
      expect(b.sesi).not.toBe(a.sesi);
      expect(await jumlahUser(k.email!.toLowerCase())).toBe(1);
      const ids = await pool.query(`SELECT count(*)::int AS n FROM google_identities WHERE google_sub = $1`, [k.sub]);
      expect(ids.rows[0].n).toBe(1);
    });

    it('email dinormalisasi huruf kecil', async () => {
      const k = klaimBaru();
      k.email = k.email!.toUpperCase().replace('@CONTOH.INVALID', '@Contoh.Invalid');
      await login(k);
      expect(await jumlahUser(k.email.toLowerCase())).toBe(1);
    });

    it('sesi lama di browser dicabut saat login member (satu browser, satu sesi)', async () => {
      const a = await login(klaimBaru());
      await get('/auth/member/me', { cookie: a.sesi }).expect(200);
      const b = await login(klaimBaru(), {}, { cookieSesi: a.sesi });
      expect(b.sesi).not.toBe('');
      await get('/auth/member/me', { cookie: a.sesi }).expect(401);
    });

    it('balapan: dua login pertama akun yang sama bersamaan menghasilkan satu user dan keduanya sukses', async () => {
      const k = klaimBaru();
      const m1 = await get('/auth/member/google/start').expect(302);
      const m2 = await get('/auth/member/google/start').expect(302);
      const c1 = idp.terbitkanKode(m1.headers.location, k);
      const c2 = idp.terbitkanKode(m2.headers.location, k);
      const [r1, r2] = await Promise.all([
        get(`/auth/member/google/callback?${c1.query}`, { cookie: cookieNamed(m1, '__Host-oidc') }),
        get(`/auth/member/google/callback?${c2.query}`, { cookie: cookieNamed(m2, '__Host-oidc') }),
      ]);
      expect([r1.headers.location, r2.headers.location]).toEqual([`${ORIGIN}/`, `${ORIGIN}/`]);
      expect(await jumlahUser(k.email!.toLowerCase())).toBe(1);
    });
  });

  // ---------- penolakan ----------
  describe('penolakan token dan transaksi', () => {
    const kasus: [string, OpsiToken | ((k: KlaimUji) => KlaimUji), string][] = [
      ['email_verified=false', { emailVerified: false }, 'email_belum_terverifikasi'],
      ['email_verified bukan boolean true (string "true")', { emailVerified: 'true' }, 'email_belum_terverifikasi'],
      ['nonce tidak cocok', { nonce: 'nonce-penyerang-yang-salah' }, 'gagal'],
      ['audience salah', { aud: 'klien-lain.apps.contoh.invalid' }, 'gagal'],
      ['issuer salah', { iss: 'https://penipu.contoh.invalid' }, 'gagal'],
      ['id_token kedaluwarsa', { expDetik: -3600 }, 'gagal'],
      ['ditandatangani kunci yang tidak ada di JWKS', { kunciLain: true }, 'gagal'],
      ['penukaran kode ditolak IdP', { tolakToken: true }, 'gagal'],
    ];
    it.each(kasus)('menolak: %s', async (_nama, opsi, kode) => {
      const k = klaimBaru();
      const { cb, sesi } = await login(k, opsi as OpsiToken);
      expect(cb.status).toBe(302);
      expect(cb.headers.location).toBe(`${ORIGIN}/masuk?galat=${kode}`);
      expect(sesi).toBe('');
      expect(await jumlahUser(k.email!.toLowerCase())).toBe(0);
    });

    it('menolak klaim email hilang', async () => {
      const k = klaimBaru();
      delete k.email;
      const { cb, sesi } = await login(k);
      expect(galatDari(cb)).toBe('gagal');
      expect(sesi).toBe('');
    });

    it('state tidak dikenal ditolak', async () => {
      const r = await get('/auth/member/google/callback?code=abc&state=state-karangan', { cookie: '__Host-oidc=apapun' }).expect(302);
      expect(galatDari(r)).toBe('sesi_kedaluwarsa');
    });

    it('cookie pengikat hilang atau salah ditolak TANPA menghanguskan transaksi (browser sah masih bisa melanjutkan)', async () => {
      const k = klaimBaru();
      const m = await get('/auth/member/google/start').expect(302);
      const { query } = idp.terbitkanKode(m.headers.location, k);
      const tanpa = await get(`/auth/member/google/callback?${query}`).expect(302);
      expect(galatDari(tanpa)).toBe('sesi_kedaluwarsa');
      const salah = await get(`/auth/member/google/callback?${query}`, { cookie: '__Host-oidc=pengikat-penyerang' }).expect(302);
      expect(galatDari(salah)).toBe('sesi_kedaluwarsa');
      const sah = await get(`/auth/member/google/callback?${query}`, { cookie: cookieNamed(m, '__Host-oidc') }).expect(302);
      expect(sah.headers.location).toBe(`${ORIGIN}/`);
    });

    it('callback yang diputar ulang (replay) ditolak; transaksi hanya sekali pakai', async () => {
      const { query, binding, cb } = await login(klaimBaru());
      expect(cb.headers.location).toBe(`${ORIGIN}/`);
      const ulang = await get(`/auth/member/google/callback?${query}`, { cookie: binding }).expect(302);
      expect(galatDari(ulang)).toBe('sesi_kedaluwarsa');
      expect(cookieNamed(ulang, '__Host-sid')).toBe('');
    });

    it('dua callback paralel pada transaksi yang sama: tepat satu berhasil', async () => {
      const m = await get('/auth/member/google/start').expect(302);
      const { query } = idp.terbitkanKode(m.headers.location, klaimBaru());
      const binding = cookieNamed(m, '__Host-oidc');
      const hasil = await Promise.all([get(`/auth/member/google/callback?${query}`, { cookie: binding }), get(`/auth/member/google/callback?${query}`, { cookie: binding })]);
      const sukses = hasil.filter((r) => r.headers.location === `${ORIGIN}/`);
      expect(sukses).toHaveLength(1);
    });

    it('transaksi kedaluwarsa ditolak', async () => {
      const m = await get('/auth/member/google/start').expect(302);
      const state = new URL(m.headers.location).searchParams.get('state')!;
      await pool.query(`UPDATE oidc_transactions SET expires_at = now() - interval '1 second' WHERE state_hash = $1`, [sha(state)]);
      const { query } = idp.terbitkanKode(m.headers.location, klaimBaru());
      const r = await get(`/auth/member/google/callback?${query}`, { cookie: cookieNamed(m, '__Host-oidc') }).expect(302);
      expect(galatDari(r)).toBe('sesi_kedaluwarsa');
    });

    it('pengguna membatalkan di Google (access_denied) -> dibatalkan; transaksi hangus', async () => {
      const m = await get('/auth/member/google/start').expect(302);
      const state = new URL(m.headers.location).searchParams.get('state')!;
      const binding = cookieNamed(m, '__Host-oidc');
      const r = await get(`/auth/member/google/callback?error=access_denied&state=${state}`, { cookie: binding }).expect(302);
      expect(galatDari(r)).toBe('dibatalkan');
      const lagi = await get(`/auth/member/google/callback?error=access_denied&state=${state}`, { cookie: binding }).expect(302);
      expect(galatDari(lagi)).toBe('sesi_kedaluwarsa');
    });

    it('parameter callback berlebihan atau terlalu panjang ditolak rapi', async () => {
      const r = await get(`/auth/member/google/callback?code=${'a'.repeat(5000)}&state=x`).expect(302);
      expect(galatDari(r)).toBe('gagal');
    });
  });

  // ---------- akun ----------
  describe('penanganan akun', () => {
    it('email sama dengan akun Google berbeda: ditolak, masuk antrean tinjauan, tanpa penautan otomatis', async () => {
      const a = klaimBaru();
      const awal = await login(a);
      expect(awal.cb.headers.location).toBe(`${ORIGIN}/`);
      const penyerang: KlaimUji = { sub: `sub-lain-${randomBytes(4).toString('hex')}`, email: a.email, name: 'SINTETIS Penyusup' };
      const r1 = await login(penyerang);
      expect(galatDari(r1.cb)).toBe('konflik_akun');
      expect(r1.sesi).toBe('');
      await login(penyerang); // percobaan berulang tidak menggandakan antrean
      expect(await jumlahUser(a.email!.toLowerCase())).toBe(1);
      const idpLain = await pool.query(`SELECT 1 FROM google_identities WHERE google_sub = $1`, [penyerang.sub]);
      expect(idpLain.rowCount).toBe(0);
      const q = await pool.query(`SELECT count(*)::int AS n, bool_and(c.status = 'MENUNGGU') AS menunggu FROM member_account_conflicts c JOIN users u ON u.id = c.existing_user_id WHERE u.email = $1`, [a.email!.toLowerCase()]);
      expect(q.rows[0]).toEqual({ n: 1, menunggu: true });
      expect((await bacaAudit('auth.member.conflict')).length).toBeGreaterThan(0);
    });

    it('member NONAKTIF ditolak dan sesinya langsung tidak berlaku', async () => {
      const k = klaimBaru();
      const a = await login(k);
      await get('/auth/member/me', { cookie: a.sesi }).expect(200);
      await pool.query(`UPDATE users SET status = 'NONAKTIF' WHERE email = $1 AND realm = 'member'`, [k.email!.toLowerCase()]);
      await get('/auth/member/me', { cookie: a.sesi }).expect(401);
      const b = await login(k);
      expect(galatDari(b.cb)).toBe('akun_nonaktif');
      expect(b.sesi).toBe('');
    });

    it('email yang sama di realm staff dan member adalah dua akun terpisah tanpa penautan', async () => {
      const email = `ganda-${randomBytes(3).toString('hex')}@contoh.invalid`;
      await invitations.undang({ email, namaTampilan: 'SINTETIS Staff', diundangOleh: null });
      const m = await login({ sub: `sub-${randomBytes(4).toString('hex')}`, email, name: 'SINTETIS' });
      expect(m.cb.headers.location).toBe(`${ORIGIN}/`);
      const r = await pool.query(`SELECT realm FROM users WHERE email = $1 ORDER BY realm`, [email]);
      expect(r.rows.map((x) => x.realm)).toEqual(['member', 'staff']);
    });
  });

  // ---------- pemisahan realm ----------
  describe('pemisahan realm member dan staff', () => {
    const tokenDariEmail = (p: PesanEmail) => /token=([A-Za-z0-9_-]+)/.exec(p.text)![1];
    async function staffPenuh() {
      const email = `staff-${randomBytes(4).toString('hex')}@contoh.invalid`;
      await invitations.undang({ email, namaTampilan: 'SINTETIS Staff', diundangOleh: null });
      await worker.prosesBatch();
      const acc = await post('/auth/staff/invitation/accept').send({ token: tokenDariEmail(terkirim.find((m) => m.to === email)!), password: PASSWORD }).expect(200);
      const c1 = cookieNamed(acc, '__Host-sid');
      const st = await post('/auth/staff/mfa/enroll/start', { cookie: c1, csrf: acc.body.csrfToken }).expect(200);
      const conf = await post('/auth/staff/mfa/enroll/confirm', { cookie: c1, csrf: acc.body.csrfToken }).send({ code: generateSync({ secret: st.body.secret }) }).expect(200);
      return { cookie: cookieNamed(conf, '__Host-sid'), csrf: conf.body.csrfToken as string };
    }

    it('sesi member tidak dapat memakai endpoint staff; sesi staff tidak dapat memakai endpoint member', async () => {
      const m = await login(klaimBaru());
      const s = await staffPenuh();
      const meStaffDenganMember = await get('/auth/me', { cookie: m.sesi }).expect(403);
      expect(meStaffDenganMember.body.kode).toBe('REALM_TIDAK_SESUAI');
      const sesiMember = await get('/auth/session', { cookie: m.sesi }).expect(200);
      await post('/auth/staff/mfa/verify', { cookie: m.sesi, csrf: sesiMember.body.csrfToken }).send({ code: '123456' }).expect(403);
      await post('/auth/staff/mfa/enroll/start', { cookie: m.sesi, csrf: sesiMember.body.csrfToken }).expect(403);
      const meMemberDenganStaff = await get('/auth/member/me', { cookie: s.cookie }).expect(403);
      expect(meMemberDenganStaff.body.kode).toBe('REALM_TIDAK_SESUAI');
    });

    it('logout member mencabut sesi dan memakai CSRF seperti staff', async () => {
      const m = await login(klaimBaru());
      const info = await get('/auth/session', { cookie: m.sesi }).expect(200);
      await post('/auth/logout', { cookie: m.sesi }).expect(403); // tanpa token CSRF
      await post('/auth/logout', { cookie: m.sesi, csrf: info.body.csrfToken }).expect(200);
      await get('/auth/member/me', { cookie: m.sesi }).expect(401);
    });
  });

  // ---------- masa berlaku sesi member ----------
  describe('masa berlaku sesi member (A-14)', () => {
    it('batas mutlak 30 hari dan batas tidak aktif 24 jam', async () => {
      const a = await login(klaimBaru());
      const token = a.sesi.split('=')[1];
      const r = await pool.query(`SELECT extract(epoch FROM (expires_at - created_at)) / 86400 AS hari FROM sessions WHERE token_hash = $1`, [sha(token)]);
      expect(Number(r.rows[0].hari)).toBeGreaterThan(29.9);
      expect(Number(r.rows[0].hari)).toBeLessThan(30.1);
      await pool.query(`UPDATE sessions SET last_seen_at = now() - interval '23 hours' WHERE token_hash = $1`, [sha(token)]);
      await get('/auth/member/me', { cookie: a.sesi }).expect(200);
      await pool.query(`UPDATE sessions SET last_seen_at = now() - interval '25 hours' WHERE token_hash = $1`, [sha(token)]);
      await get('/auth/member/me', { cookie: a.sesi }).expect(401);

      const b = await login(klaimBaru());
      await pool.query(`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE token_hash = $1`, [sha(b.sesi.split('=')[1])]);
      await get('/auth/member/me', { cookie: b.sesi }).expect(401);
    });
  });

  // ---------- returnTo ----------
  describe('returnTo (cegah open redirect)', () => {
    it('jalur relatif dipertahankan setelah masuk', async () => {
      const { cb } = await login(klaimBaru(), {}, { returnTo: '/lowongan?wilayah=jakarta' });
      expect(cb.headers.location).toBe(`${ORIGIN}/lowongan?wilayah=jakarta`);
    });
    it.each(['https://jahat.contoh.invalid/', '//jahat.contoh.invalid', '/\\jahat.contoh.invalid', 'javascript:alert(1)', 'lowongan', `/${'a'.repeat(300)}`])('mengabaikan returnTo berbahaya: %s', async (v) => {
      const { cb } = await login(klaimBaru(), {}, { returnTo: v });
      expect(cb.headers.location).toBe(`${ORIGIN}/`);
    });
    it('returnToAman (unit)', () => {
      expect(returnToAman('/a/b?c=1')).toBe('/a/b?c=1');
      expect(returnToAman('//x.invalid')).toBe('/');
      expect(returnToAman('/\\x')).toBe('/');
      expect(returnToAman('/x\ny')).toBe('/');
      expect(returnToAman(undefined)).toBe('/');
      expect(returnToAman(42)).toBe('/');
    });
  });

  // ---------- audit & log ----------
  describe('audit dan log', () => {
    it('audit tidak memuat email, sub, atau nama mentah', async () => {
      const k = klaimBaru();
      await login(k);
      await login({ ...k, sub: `lain-${randomBytes(3).toString('hex')}` }); // konflik
      const semua = [...(await bacaAudit('auth.member.login.success')), ...(await bacaAudit('auth.member.created')), ...(await bacaAudit('auth.member.conflict')), ...(await bacaAudit('auth.member.login.failed'))];
      expect(semua.length).toBeGreaterThan(0);
      for (const d of semua) {
        expect(d).not.toContain(k.email!);
        expect(d).not.toContain(k.sub);
        expect(d).not.toContain('SINTETIS');
      }
    });

    it('log HTTP tidak memuat code, state, atau token dari callback', async () => {
      const tertulis: string[] = [];
      const asli = fs.write as (...a: unknown[]) => unknown;
      const spy = jest.spyOn(fs, 'write').mockImplementation(((fd: number, data: unknown, ...rest: unknown[]) => {
        if (fd === 1 || fd === 2) tertulis.push(typeof data === 'string' ? data : Buffer.from(data as Uint8Array).toString());
        return asli.call(fs, fd, data, ...rest);
      }) as unknown as typeof fs.write);
      try {
        const k = klaimBaru();
        const { query, binding } = await login(k);
        const code = new URLSearchParams(query).get('code')!;
        const state = new URLSearchParams(query).get('state')!;
        await new Promise((r) => setTimeout(r, 200));
        const log = tertulis.join('');
        expect(log).toContain('/auth/member/google/callback'); // bukti penangkapan log bekerja (bukan lolos semu)
        expect(log).not.toContain(code);
        expect(log).not.toContain(state);
        expect(log).not.toContain(binding.split('=')[1]);
      } finally {
        spy.mockRestore();
      }
    });
  });
});
