// Smoke E2E alur staff di browser nyata (Chromium, 360 px) terhadap API + web yang berjalan sungguhan.
// Prasyarat: `pnpm build`, PostgreSQL (TEST_DATABASE_URL), dan Playwright terpasang (require('playwright')).
// Tidak dijalankan di CI (butuh browser); jalankan lokal: `pnpm test:e2e`. Data sepenuhnya sintetis.
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const aku = dirname(fileURLToPath(import.meta.url));
const akar = join(aku, '..', '..');
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { generateSync } = require(join(akar, 'apps/api/node_modules/otplib'));
const { Pool } = require(join(akar, 'tests/node_modules/pg'));

const DB = process.env.TEST_DATABASE_URL;
if (!DB) throw new Error('TEST_DATABASE_URL wajib diisi');
const SKEMA = `e2e_${randomBytes(4).toString('hex')}`;
const WEB = 'http://localhost:3000';
const PASSWORD = 'kuda lari malam hari di sawah';
const EMAIL = `e2e-${randomBytes(3).toString('hex')}@contoh.invalid`;
const OUT = process.env.E2E_OUT ?? join(akar, 'tests/e2e/out');
mkdirSync(OUT, { recursive: true });

const proses = [];
const tunggu = async (url, nama) => {
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch(url)).status < 500) return; } catch { /* belum siap */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${nama} tidak siap: ${url}`);
};
const berhenti = () => proses.forEach((p) => p.kill('SIGTERM'));

async function utama() {
  execFileSync('node', [join(akar, 'apps/api/scripts/migrate.js'), 'up'], { env: { ...process.env, DATABASE_URL: DB, MIGRATE_SCHEMA: SKEMA } });
  const pool = new Pool({ connectionString: `${DB}${DB.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${SKEMA}`)}`, max: 2 });
  const token = randomBytes(32).toString('base64url');
  const p = await pool.query(`INSERT INTO persons (display_name) VALUES ('SINTETIS E2E') RETURNING id`);
  const u = await pool.query(`INSERT INTO users (person_id, realm, email, status) VALUES ($1, 'staff', $2, 'DIUNDANG') RETURNING id`, [p.rows[0].id, EMAIL]);
  await pool.query(`INSERT INTO staff_invitations (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [u.rows[0].id, createHash('sha256').update(token).digest()]);

  const envApi = {
    ...process.env, NODE_ENV: 'production', PORT: '3001', APP_BASE_URL: WEB,
    DATABASE_URL: `${DB}${DB.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${SKEMA}`)}`,
    AUTH_HMAC_KEY: randomBytes(32).toString('base64'), APP_ENCRYPTION_KEY: randomBytes(32).toString('base64'), TRUST_PROXY: '0',
  };
  delete envApi.GOOGLE_CLIENT_ID; delete envApi.GOOGLE_CLIENT_SECRET;
  proses.push(spawn('node', [join(akar, 'apps/api/dist/main.js')], { env: envApi, stdio: 'ignore' }));
  proses.push(spawn('node', [join(akar, 'apps/web/node_modules/next/dist/bin/next'), 'start', '-p', '3000'], { cwd: join(akar, 'apps/web'), env: { ...process.env, NODE_ENV: 'production' }, stdio: 'ignore' }));
  await tunggu('http://localhost:3001/health', 'API');
  await tunggu(`${WEB}/`, 'Web');

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, deviceScaleFactor: 1, locale: 'id-ID' });
  const page = await ctx.newPage();
  const galatKonsol = [];
  // Respons 401 yang memang diharapkan (belum masuk, kata sandi/kode salah) dicatat Chromium sebagai galat jaringan.
  // Hanya pola itu yang dikecualikan; pelanggaran CSP dan galat lain tetap menggagalkan tes.
  const diharapkan = /Failed to load resource: the server responded with a status of 401/;
  page.on('console', (m) => { if (m.type() === 'error' && !diharapkan.test(m.text())) galatKonsol.push(m.text()); });
  page.on('pageerror', (e) => galatKonsol.push(String(e)));

  const tanpaGulirHorizontal = async (nama) => {
    const lebar = await page.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(lebar <= 360, `${nama}: gulir horizontal (scrollWidth=${lebar})`);
  };
  const semuaInputBerlabel = async (nama) => {
    const tanpaLabel = await page.evaluate(() => [...document.querySelectorAll('input:not([type=hidden])')].filter((i) => !document.querySelector(`label[for="${i.id}"]`)).map((i) => i.id || i.name));
    assert.deepEqual(tanpaLabel, [], `${nama}: input tanpa label`);
  };
  const targetSentuh = async (nama) => {
    const kecil = await page.evaluate(() => [...document.querySelectorAll('button, a.tombol, a.tombol-sekunder')].filter((e) => e.getBoundingClientRect().height < 44).map((e) => e.textContent));
    assert.deepEqual(kecil, [], `${nama}: target sentuh < 44 px`);
  };
  // Kontras WCAG AA (>= 4.5:1) teks vs latar untuk tombol dan tautan: mencegah teks tak terlihat (mis. navy di atas navy).
  const kontras = async (nama) => {
    const buruk = await page.evaluate(() => {
      const lum = (c) => { const [r, g, b] = c.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      return [...document.querySelectorAll('button, a')].filter((e) => e.getBoundingClientRect().height > 0).map((e) => {
        const cs = getComputedStyle(e); const a = lum(cs.color), b = lum(cs.backgroundColor === 'rgba(0, 0, 0, 0)' ? 'rgb(255, 255, 255)' : cs.backgroundColor);
        return { teks: e.textContent.trim().slice(0, 30), rasio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
      }).filter((x) => x.rasio < 4.5);
    });
    assert.deepEqual(buruk, [], `${nama}: kontras < 4.5:1`);
  };
  const periksa = async (nama) => { await tanpaGulirHorizontal(nama); await semuaInputBerlabel(nama); await targetSentuh(nama); await kontras(nama); };
  const foto = (nama) => page.screenshot({ path: join(OUT, `${nama}.png`), fullPage: true });

  // 1. Beranda
  const resp = await page.goto(`${WEB}/`);
  assert.equal(await page.getAttribute('html', 'lang'), 'id');
  const h = resp.headers();
  assert.match(h['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(h['x-frame-options'], 'DENY');
  assert.equal(h['x-powered-by'], undefined);
  await periksa('beranda'); await foto('01-beranda');

  // 2. Halaman masuk member + kode galat Google
  await page.goto(`${WEB}/masuk?galat=konflik_akun`);
  assert.match(await page.textContent('[role=alert].galat'), /terdaftar dengan akun Google lain/);
  assert.equal(await page.getAttribute('a.tombol', 'href'), '/api/auth/member/google/start');
  await periksa('masuk-member'); await foto('02-masuk-member');
  const g = await page.request.get(`${WEB}/api/auth/member/google/start`, { maxRedirects: 0 });
  assert.equal(g.status(), 503);
  assert.equal((await g.json()).kode, 'GOOGLE_BELUM_DIKONFIGURASI');

  // 3. Undangan -> kata sandi
  await page.goto(`${WEB}/undangan?token=${token}`);
  await page.waitForSelector('#password');
  assert.ok(!page.url().includes(token), 'token harus dibuang dari URL');
  await page.fill('#password', 'pendek'); await page.fill('#ulang', 'pendek'); await page.click('button[type=submit]');
  assert.match(await page.textContent('[role=alert].galat'), /minimal 12 karakter/);
  await periksa('undangan'); await foto('03-undangan');
  await page.fill('#password', PASSWORD); await page.fill('#ulang', PASSWORD); await page.click('button[type=submit]');
  await page.waitForURL('**/staff/daftar-mfa');

  // 4. Daftar MFA
  await page.waitForSelector('.rahasia');
  assert.ok(await page.isVisible('img.qr'), 'kode QR harus tampil');
  const secret = (await page.textContent('.rahasia')).trim();
  assert.match(secret, /^[A-Z2-7]{16,}$/);
  await periksa('daftar-mfa'); await foto('04-daftar-mfa');
  await page.fill('#kode', '000000'); await page.click('button[type=submit]');
  assert.match(await page.textContent('[role=alert].galat'), /salah|sudah dipakai|terkunci/i);
  await page.fill('#kode', generateSync({ secret })); await page.click('button[type=submit]');
  await page.waitForSelector('.daftar-kode');
  assert.equal(await page.locator('.daftar-kode li').count(), 10);
  assert.ok(await page.isDisabled('button.tombol'), 'tombol Lanjut harus nonaktif sebelum dicentang');
  await periksa('kode-pemulihan'); await foto('05-kode-pemulihan');
  await page.check('#tersimpan'); await page.click('button.tombol');
  await page.waitForURL('**/staff');

  // 5. Beranda staff + cookie
  await page.waitForSelector('.kartu');
  assert.match(await page.textContent('.kartu'), new RegExp(EMAIL));
  assert.match(await page.textContent('.kartu'), /belum ada peran/);
  const sid = (await ctx.cookies()).find((c) => c.name === '__Host-sid');
  assert.ok(sid, 'cookie sesi __Host-sid harus ada');
  assert.deepEqual({ httpOnly: sid.httpOnly, secure: sid.secure, path: sid.path, sameSite: sid.sameSite }, { httpOnly: true, secure: true, path: '/', sameSite: 'Lax' });
  assert.ok(!(await page.evaluate(() => document.cookie)).includes('__Host-sid'), 'cookie sesi tidak boleh terbaca JS');
  await periksa('beranda-staff'); await foto('06-beranda-staff');

  // 6. Keluar, lalu masuk lagi dengan kata sandi + TOTP
  await page.click('button.tombol-sekunder');
  await page.waitForURL('**/staff/masuk');
  await page.goto(`${WEB}/staff`);
  await page.waitForURL('**/staff/masuk'); // tanpa sesi -> diarahkan ke masuk
  await page.fill('#email', EMAIL); await page.fill('#password', 'salah-salah-salah'); await page.click('button[type=submit]');
  assert.match(await page.textContent('[role=alert].galat'), /salah|terkunci/);
  await page.fill('#password', PASSWORD); await page.click('button[type=submit]');
  await page.waitForSelector('#kode');
  assert.match(await page.textContent('h2'), /Verifikasi dua langkah/);
  await periksa('mfa-login'); await foto('07-mfa-login');
  await page.fill('#kode', generateSync({ secret, epoch: Math.floor(Date.now() / 1000) + 30 })); await page.click('button[type=submit]');
  await page.waitForURL('**/staff');
  await page.waitForSelector('.kartu');

  // 7. Lupa kata sandi (respons seragam) + halaman reset tanpa token
  await page.click('button.tombol-sekunder'); await page.waitForURL('**/staff/masuk');
  await page.goto(`${WEB}/staff/lupa-password`);
  await page.fill('#email', 'tidak-ada@contoh.invalid'); await page.click('button[type=submit]');
  assert.match(await page.textContent('[role=status].sukses'), /Jika email terdaftar/);
  await periksa('lupa-password');
  await page.goto(`${WEB}/staff/reset`);
  assert.match(await page.textContent('[role=alert].galat'), /tidak valid/);

  assert.deepEqual(galatKonsol, [], `galat konsol/CSP: ${galatKonsol.join(' | ')}`);
  await browser.close();
  await pool.end();
  console.log('E2E staff (360 px): LULUS');
}

let kode = 0;
try { await utama(); } catch (e) { console.error('E2E GAGAL:', e.message); kode = 1; }
berhenti();
const admin = new Pool({ connectionString: DB, max: 1 });
await admin.query(`DROP SCHEMA IF EXISTS ${SKEMA} CASCADE`).catch(() => undefined);
await admin.end();
process.exit(kode);
