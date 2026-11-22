import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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

type Metode = 'get' | 'post' | 'put' | 'patch' | 'delete';
interface Sesi { cookie: string; csrf: string; userId: string }
interface Rute { metode: Metode; path: string; templ: string; tulis: boolean; multipart: boolean }

// Rute publik yang SAH (sisanya wajib 401 tanpa sesi). Menambah rute publik baru harus disengaja: tes ini gagal sampai daftar ini diperbarui.
const PUBLIK_SAH = new Set(['/health', '/auth/staff/invitation/accept', '/auth/staff/login', '/auth/staff/password/forgot', '/auth/staff/password/reset', '/auth/member/google/start', '/auth/member/google/callback']);
// Rute staf yang sah dibuka untuk staf tanpa peran apa pun (isi dibatasi izin di dalamnya).
const STAF_TANPA_IZIN_SAH = new Set(['/dashboard/staff']);
const PAYLOAD = [
  `' OR 1=1--`, `'; DROP TABLE users;--`, `<script>alert(1)</script>`, `"><img src=x onerror=alert(1)>`, `../../../../etc/passwd`, `\u0000%00`, '${7*7}{{7*7}}', 'A'.repeat(4000), '😀日本語‮', `{"$ne":null}`,
];
const KUNCI_QUERY = ['action', 'cursor', 'limit', 'status', 'from', 'to', 'q', 'kategori', 'locationId', 'personId', 'kind', 'tahap', 'companyId', 'objectType', 'objectId', 'actorId', 'year'];
const KUNCI_BODY = ['name', 'label', 'title', 'description', 'reason', 'note', 'email', 'password', 'code', 'kind', 'status', 'locationId', 'personId', 'amount', 'date', 'startDate', 'endDate', 'decision', 'effect', 'token', 'role'];

const dok = JSON.parse(readFileSync(join(__dirname, '../../../docs/openapi/openapi.json'), 'utf8')) as { paths: Record<string, Record<string, { requestBody?: unknown; parameters?: { name: string; in: string }[] }>> };
const isi = (templ: string) => templ.replace(/\{(\w+)\}/g, (_m, n: string) => (n === 'roleCode' ? 'HRD' : n === 'nama' ? 'workforce' : randomUUID()));
const RUTE: Rute[] = Object.entries(dok.paths).flatMap(([templ, ops]) =>
  Object.entries(ops).filter(([m]) => ['get', 'post', 'put', 'patch', 'delete'].includes(m)).map(([m, d]) => ({ metode: m as Metode, templ, path: isi(templ), tulis: m !== 'get', multipart: JSON.stringify(d.requestBody ?? '').includes('multipart') })),
);

// Semua data SINTETIS.
jalan('Keamanan: sapuan seluruh rute OpenAPI (autentikasi, otorisasi, CSRF/Origin, injeksi, header, pembatas laju)', () => {
  let app: INestApplication;
  let pool: Pool;
  let nomorIp = 1;
  let sessions: import('../src/auth/session.service').SessionService;
  const direktur: Sesi[] = [];
  const member: Sesi[] = [];
  const tanpaPeran: Sesi[] = [];

  const ipBaru = () => `10.98.${Math.floor(nomorIp / 250)}.${(nomorIp++ % 250) + 1}`;
  const buatStaff = async (roles: string[], companyIds: string[]): Promise<Sesi> => {
    const u = (await pool.query(`INSERT INTO users (realm, email, status) VALUES ('staff', $1, 'AKTIF') RETURNING id`, [`s-${randomBytes(4).toString('hex')}@contoh.invalid`])).rows[0].id as string;
    for (const role of roles) await pool.query(`INSERT INTO user_roles (user_id, role_code, grant_source) VALUES ($1, $2, 'MANUAL')`, [u, role]);
    for (const c of companyIds) await pool.query(`INSERT INTO user_company_scopes (user_id, scope_company_id) VALUES ($1, $2)`, [u, c]);
    const x = await sessions.buat({ userId: u, realm: 'staff', state: 'PENUH' });
    return { cookie: `__Host-sid=${x.token}`, csrf: x.csrfToken, userId: u };
  };
  const buatMember = async (): Promise<Sesi> => {
    const p = (await pool.query(`INSERT INTO persons (display_name) VALUES ('SINTETIS Member') RETURNING id`)).rows[0].id;
    const u = (await pool.query(`INSERT INTO users (person_id, realm, email, status) VALUES ($1, 'member', $2, 'AKTIF') RETURNING id`, [p, `m-${randomBytes(4).toString('hex')}@contoh.invalid`])).rows[0].id as string;
    const x = await sessions.buat({ userId: u, realm: 'member', state: 'PENUH' });
    return { cookie: `__Host-sid=${x.token}`, csrf: x.csrfToken, userId: u };
  };
  let putar = 0;
  const dari = (kolam: Sesi[]) => kolam[putar++ % kolam.length]; // menyebar beban agar pembatas laju per pengguna tidak terpicu

  interface Opsi { sesi?: Sesi; origin?: string | null; csrf?: string | null; body?: unknown; query?: string; ip?: string; header?: Record<string, string> }
  const kirim = (r: Rute, o: Opsi = {}) => {
    let q = request(app.getHttpServer())[r.metode](r.path + (o.query ? `?${o.query}` : '')).set('X-Forwarded-For', o.ip ?? ipBaru());
    if (o.origin !== null && r.tulis) q = q.set('Origin', o.origin ?? ORIGIN);
    if (o.sesi) q = q.set('Cookie', o.sesi.cookie);
    if (o.sesi && o.csrf !== null && r.tulis) q = q.set('X-CSRF-Token', o.csrf ?? o.sesi.csrf);
    for (const [k, v] of Object.entries(o.header ?? {})) q = q.set(k, v);
    return o.body !== undefined && r.tulis ? q.send(o.body as object) : q;
  };
  const lewati = (r: Rute) => r.path === '/auth/logout'; // mematikan sesi uji
  const terpakai = RUTE.filter((r) => !lewati(r));

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
    const A = (await pool.query(`INSERT INTO companies (name) VALUES ($1) RETURNING id`, [`PT SINTETIS A ${randomBytes(3).toString('hex')}`])).rows[0].id;
    const B = (await pool.query(`INSERT INTO companies (name) VALUES ($1) RETURNING id`, [`PT SINTETIS B ${randomBytes(3).toString('hex')}`])).rows[0].id;
    for (let i = 0; i < 40; i++) direktur.push(await buatStaff(['DIREKTUR'], [A, B]));
    for (let i = 0; i < 12; i++) tanpaPeran.push(await buatStaff([], [A]));
    for (let i = 0; i < 14; i++) member.push(await buatMember());
  });
  afterAll(async () => {
    await pool?.end();
    await app?.close();
  });

  it('cakupan: seluruh rute dokumen OpenAPI dipakai (bukan daftar tulis-tangan)', () => {
    expect(RUTE.length).toBeGreaterThan(150);
    expect(RUTE.some((r) => r.multipart)).toBe(true);
    expect([...PUBLIK_SAH].every((p) => RUTE.some((r) => r.templ === p))).toBe(true);
  });

  describe('autentikasi: tanpa sesi', () => {
    it('setiap rute non-publik 401 (tidak 200, tidak 500); rute publik hanya yang disengaja dan tidak 5xx', async () => {
      const salah: string[] = [];
      for (const r of terpakai) {
        const res = await kirim(r, { body: {} });
        const publik = PUBLIK_SAH.has(r.templ);
        const googleBelumDiset = r.templ === '/auth/member/google/start' && res.status === 503 && res.body?.kode === 'GOOGLE_BELUM_DIKONFIGURASI'; // 503 terkurasi (kredensial belum ada)
        if (publik ? res.status >= 500 && !googleBelumDiset : res.status !== 401) salah.push(`${r.metode.toUpperCase()} ${r.templ} -> ${res.status}`);
      }
      expect(salah).toEqual([]);
    });
  });

  describe('otorisasi: realm dan izin', () => {
    it('sesi MEMBER pada rute staf = 403; sesi STAF pada rute member = 403', async () => {
      const salah: string[] = [];
      for (const r of terpakai.filter((x) => !PUBLIK_SAH.has(x.templ) && !x.templ.startsWith('/auth/'))) {
        const memberRute = r.templ.startsWith('/member/');
        const res = await kirim(r, { sesi: dari(memberRute ? direktur : member), body: {} });
        if (res.status !== 403) salah.push(`${r.metode.toUpperCase()} ${r.templ} -> ${res.status}`);
      }
      expect(salah).toEqual([]);
    });
    it('staf TANPA PERAN: setiap rute staf 403 kecuali yang sah (dashboard kosong); tidak pernah 200 pada data', async () => {
      const salah: string[] = [];
      for (const r of terpakai.filter((x) => !PUBLIK_SAH.has(x.templ) && !x.templ.startsWith('/auth/') && !x.templ.startsWith('/member/'))) {
        const res = await kirim(r, { sesi: dari(tanpaPeran), body: {} });
        const sah = STAF_TANPA_IZIN_SAH.has(r.templ);
        if (sah ? res.status !== 200 : res.status !== 403) salah.push(`${r.metode.toUpperCase()} ${r.templ} -> ${res.status}`);
      }
      expect(salah).toEqual([]);
    });
  });

  describe('CSRF dan Origin pada seluruh rute tulis', () => {
    const tulis = terpakai.filter((r) => r.tulis);
    it('token CSRF hilang atau salah (sesi sah, Origin benar) = 403; tidak pernah 2xx/5xx', async () => {
      const salah: string[] = [];
      for (const r of tulis.filter((x) => !PUBLIK_SAH.has(x.templ) && !x.templ.startsWith('/auth/') && !x.templ.startsWith('/member/'))) {
        for (const csrf of [null, 'salah-salah']) {
          const res = await kirim(r, { sesi: dari(direktur), csrf, body: {} });
          if (res.status !== 403) salah.push(`${r.metode.toUpperCase()} ${r.templ} csrf=${csrf} -> ${res.status}`);
        }
      }
      expect(salah).toEqual([]);
    });
    it('Origin asing atau tanpa Origin/Referer = 403 pada SEMUA rute tulis (termasuk publik)', async () => {
      const salah: string[] = [];
      for (const r of tulis) {
        for (const origin of ['https://jahat.invalid', null]) {
          const res = await kirim(r, { sesi: dari(direktur), origin, body: {} });
          if (res.status !== 403) salah.push(`${r.metode.toUpperCase()} ${r.templ} origin=${origin} -> ${res.status}`);
        }
      }
      expect(salah).toEqual([]);
    });
  });

  describe('injeksi dan masukan jahat (staf berizin penuh)', () => {
    it('GET: parameter query jahat tidak pernah menghasilkan 5xx atau refleksi mentah', async () => {
      const salah: string[] = [];
      const gets = terpakai.filter((r) => r.metode === 'get' && !r.templ.startsWith('/auth/') && !PUBLIK_SAH.has(r.templ) && !r.path.endsWith('.pdf') && !r.templ.includes('/selfie'));
      for (const p of PAYLOAD.slice(0, 6)) {
        const query = KUNCI_QUERY.map((k) => `${k}=${encodeURIComponent(p.slice(0, 300))}`).join('&');
        for (const r of gets) {
          const res = await kirim(r, { sesi: dari(direktur), query });
          const teks = typeof res.text === 'string' ? res.text : '';
          if (res.status >= 500) salah.push(`5xx ${r.templ} (${res.status}) payload=${p.slice(0, 12)}`);
          if (/<script>alert|<img src=x onerror/.test(teks)) salah.push(`refleksi ${r.templ}`);
        }
      }
      expect(salah).toEqual([]);
    });
    it('tulis: body jahat (semua kunci umum) tidak pernah 5xx atau refleksi mentah; rute multipart menolak JSON', async () => {
      const salah: string[] = [];
      for (const p of PAYLOAD) {
        const body = Object.fromEntries(KUNCI_BODY.map((k) => [k, p]));
        for (const r of terpakai.filter((x) => x.tulis && !x.templ.startsWith('/auth/logout'))) {
          const publik = PUBLIK_SAH.has(r.templ);
          const res = await kirim(r, { sesi: publik ? undefined : dari(direktur), body });
          const teks = typeof res.text === 'string' ? res.text : '';
          if (res.status >= 500) salah.push(`5xx ${r.metode.toUpperCase()} ${r.templ} (${res.status}) payload=${p.slice(0, 12)}`);
          if (/<script>alert|<img src=x onerror/.test(teks)) salah.push(`refleksi ${r.templ}`);
        }
      }
      expect(salah).toEqual([]);
    });
    it('UUID rusak pada path = 400/404, bukan 5xx; ID tak ada = 404/400', async () => {
      const salah: string[] = [];
      for (const r of terpakai.filter((x) => x.templ.includes('{') && !x.templ.includes('{roleCode}') && !x.templ.includes('{nama}') && !x.templ.startsWith('/auth/') && !x.templ.startsWith('/member/'))) {
        for (const buruk of ['x', "1' OR '1'='1", '%00', '../etc', '😀']) {
          const path = r.templ.replace(/\{\w+\}/g, encodeURIComponent(buruk));
          const res = await kirim({ ...r, path }, { sesi: dari(direktur), body: {} });
          if (![400, 403, 404].includes(res.status)) salah.push(`${r.metode.toUpperCase()} ${r.templ} id=${buruk} -> ${res.status}`);
        }
      }
      expect(salah).toEqual([]);
    });
    it('body besar atau bersarang dalam ditolak terkendali (413/400), bukan 5xx; kursor rusak 400', async () => {
      const r: Rute = { metode: 'post', templ: '/payroll/periods', path: '/payroll/periods', tulis: true, multipart: false };
      const besar = await kirim(r, { sesi: dari(direktur), body: { label: 'x'.repeat(2_000_000) } });
      expect([400, 413]).toContain(besar.status);
      let dalam: unknown = 'x';
      for (let i = 0; i < 3000; i++) dalam = { a: dalam };
      const nest = await kirim(r, { sesi: dari(direktur), body: dalam });
      expect(nest.status).toBeLessThan(500);
      for (const kursor of ['rusak', 'e30', Buffer.from('{"t":"x","id":"y"}').toString('base64url'), 'A'.repeat(2000)]) {
        const res = await kirim({ metode: 'get', templ: '/audit-logs', path: '/audit-logs', tulis: false, multipart: false }, { sesi: dari(direktur), query: `cursor=${encodeURIComponent(kursor)}` });
        expect([400]).toContain(res.status);
      }
    });
  });

  describe('header dan permukaan', () => {
    it('semua respons API (sukses, galat, 401, 403, 404) membawa header keamanan, tanpa X-Powered-By, dan no-store', async () => {
      const salah: string[] = [];
      const contoh: [Rute, Opsi][] = [
        [{ metode: 'get', templ: '/health', path: '/health', tulis: false, multipart: false }, {}],
        [{ metode: 'get', templ: '/auth/session', path: '/auth/session', tulis: false, multipart: false }, {}],
        [{ metode: 'get', templ: '/dashboard/staff', path: '/dashboard/staff', tulis: false, multipart: false }, { sesi: direktur[0] }],
        [{ metode: 'get', templ: '/payroll/periods', path: '/payroll/periods', tulis: false, multipart: false }, { sesi: tanpaPeran[1] }],
        [{ metode: 'get', templ: '/attendance/points/x', path: `/attendance/points/${randomUUID()}`, tulis: false, multipart: false }, { sesi: direktur[1] }],
        [{ metode: 'get', templ: '/tidak-ada', path: '/rute/tidak/ada', tulis: false, multipart: false }, { sesi: direktur[2] }],
        [{ metode: 'post', templ: '/payroll/periods', path: '/payroll/periods', tulis: true, multipart: false }, { sesi: direktur[3], body: { kind: 'SALAH' } }],
      ];
      for (const [r, o] of contoh) {
        const res = await kirim(r, o);
        const h = res.headers;
        if (h['x-powered-by']) salah.push(`${r.templ}: x-powered-by`);
        if (h['x-content-type-options'] !== 'nosniff') salah.push(`${r.templ}: nosniff`);
        if (!/no-store/.test(String(h['cache-control']))) salah.push(`${r.templ}: no-store`);
        if (h['referrer-policy'] !== 'no-referrer') salah.push(`${r.templ}: referrer-policy`);
        if (h['x-frame-options'] !== 'DENY') salah.push(`${r.templ}: x-frame-options`);
        if (h['cross-origin-resource-policy'] !== 'same-origin') salah.push(`${r.templ}: corp`);
      }
      expect(salah).toEqual([]);
    });
    it('galat 5xx/4xx tidak membocorkan jejak tumpukan, SQL, atau jalur berkas', async () => {
      const res = await kirim({ metode: 'post', templ: '/payroll/periods', path: '/payroll/periods', tulis: true, multipart: false }, { sesi: direktur[4], body: { kind: 'PARTNER', label: "x'", startDate: '2026-03-01', endDate: '2026-03-31', companyId: '00000000-0000-4000-8000-000000000000' } });
      expect(res.text).not.toMatch(/at \w+.*\(\/|node_modules|SELECT |INSERT |pg_|stack|\/home\//i);
    });
  });

  describe('pembatas laju', () => {
    it('pengguna BERBEDA di satu IP (NAT/lokasi kerja) tidak saling memblokir; pembatas dihitung per pengguna', async () => {
      const ipBersama = '203.0.113.77';
      const r: Rute = { metode: 'get', templ: '/dashboard/staff', path: '/dashboard/staff', tulis: false, multipart: false };
      const status: number[] = [];
      for (let u = 0; u < 14; u++) for (let i = 0; i < 10; i++) status.push((await kirim(r, { sesi: tanpaPeran[u % tanpaPeran.length], ip: ipBersama })).status);
      // 140 permintaan dari satu IP oleh 12 pengguna (masing-masing <= 12): per-IP murni (120/mnt) akan memblokir; per-pengguna tidak
      expect(status.filter((s) => s === 429)).toEqual([]);
      expect(status.every((s) => s === 200)).toBe(true);
    });
    it('satu pengguna yang melampaui batas (120/mnt) dibatasi 429; pengguna lain tidak terdampak', async () => {
      const korban = await buatStaff([], []);
      const lain = await buatStaff([], []);
      const r: Rute = { metode: 'get', templ: '/dashboard/staff', path: '/dashboard/staff', tulis: false, multipart: false };
      const ip = '203.0.113.88';
      let ditolak = 0;
      for (let i = 0; i < 130; i++) if ((await kirim(r, { sesi: korban, ip })).status === 429) ditolak += 1;
      expect(ditolak).toBeGreaterThanOrEqual(5);
      expect((await kirim(r, { sesi: lain, ip })).status).toBe(200);
    });
    it('banjir cookie palsu ke rute bersesi dari satu IP dibatasi 429 (mencegah pengungkit beban database); pengguna sah dari IP lain tidak terdampak', async () => {
      const r: Rute = { metode: 'get', templ: '/dashboard/staff', path: '/dashboard/staff', tulis: false, multipart: false };
      const ip = '203.0.113.111';
      const hasil: number[] = [];
      for (let i = 0; i < 75; i++) hasil.push((await kirim(r, { ip, header: { Cookie: `__Host-sid=${randomBytes(16).toString('hex')}` } })).status);
      expect(hasil.slice(0, 50).every((s) => s === 401)).toBe(true);
      expect(hasil.filter((s) => s === 429).length).toBeGreaterThanOrEqual(10);
      expect((await kirim(r, { sesi: dari(tanpaPeran), ip: '203.0.113.112' })).status).toBe(200);
    });
    it('rute tanpa sesi tetap per IP: cookie palsu yang berganti-ganti TIDAK menghindari pembatas login', async () => {
      const r: Rute = { metode: 'post', templ: '/auth/staff/login', path: '/auth/staff/login', tulis: true, multipart: false };
      const ip = '203.0.113.99';
      const hasil: number[] = [];
      for (let i = 0; i < 16; i++) hasil.push((await kirim(r, { ip, body: { email: `x${i}@contoh.invalid`, password: 'salah-salah-salah' }, header: { Cookie: `__Host-sid=palsu${i}${randomBytes(8).toString('hex')}` } })).status);
      expect(hasil.filter((s) => s === 429).length).toBeGreaterThanOrEqual(4);
    });
  });
});
