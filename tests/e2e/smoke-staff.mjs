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
const { generateSync, generateSecret } = require(join(akar, 'apps/api/node_modules/otplib'));
const { hash: hashArgon, Algorithm } = require(join(akar, 'apps/api/node_modules/@node-rs/argon2'));
const { enkripsi } = require(join(akar, 'apps/api/dist/common/crypto/crypto.js'));
const { Pool } = require(join(akar, 'tests/node_modules/pg'));

const DB = process.env.TEST_DATABASE_URL;
if (!DB) throw new Error('TEST_DATABASE_URL wajib diisi');
const SKEMA = `e2e_${randomBytes(4).toString('hex')}`;
const WEB = 'http://localhost:3000';
const PASSWORD = 'kuda lari malam hari di sawah';
const KUNCI_ENK = randomBytes(32).toString('base64');
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
    AUTH_HMAC_KEY: randomBytes(32).toString('base64'), APP_ENCRYPTION_KEY: KUNCI_ENK, TRUST_PROXY: '0', STORAGE_DIR: join(OUT, 'penyimpanan'),
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
  // Respons 401/400 yang memang diharapkan (belum masuk, kata sandi/kode salah, validasi formulir) dicatat Chromium sebagai galat jaringan.
  // Hanya pola itu yang dikecualikan; pelanggaran CSP dan galat lain tetap menggagalkan tes.
  const diharapkan = /Failed to load resource: the server responded with a status of (401|400)/; // 400: validasi formulir yang sengaja dipicu tes
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


  // 8. Master data (Fase 4): IT membuat perusahaan -> Direktur menyetujui -> Marketing menambah rekanan/lokasi/kontak/kontrak -> Direktur mengaktifkan kontrak.
  const hashPassword = await hashArgon(PASSWORD, { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
  const buatStaff = async (kode, roles, allCompanies = false) => {
    const email = `e2e-${kode}-${randomBytes(3).toString('hex')}@contoh.invalid`;
    const rahasia = generateSecret();
    const pp = await pool.query(`INSERT INTO persons (display_name) VALUES ('SINTETIS E2E') RETURNING id`);
    const uu = await pool.query(`INSERT INTO users (person_id, realm, email, status, all_companies) VALUES ($1, 'staff', $2, 'AKTIF', $3) RETURNING id`, [pp.rows[0].id, email, allCompanies]);
    const uid = uu.rows[0].id;
    await pool.query(`INSERT INTO staff_credentials (user_id, password_hash) VALUES ($1, $2)`, [uid, hashPassword]);
    await pool.query(`INSERT INTO staff_mfa_factors (user_id, secret_enc, status, confirmed_at) VALUES ($1, $2, 'AKTIF', now())`, [uid, enkripsi(rahasia, Buffer.from(KUNCI_ENK, 'base64'), `mfa:${uid}`)]);
    for (const r of roles) await pool.query(`INSERT INTO user_roles (user_id, role_code, grant_source) VALUES ($1, $2, 'MANUAL')`, [uid, r]);
    return { email, rahasia, uid, langkah: 0 };
  };
  const masukUI = async (st) => {
    await page.goto(`${WEB}/staff/masuk`);
    await page.fill('#email', st.email); await page.fill('#password', PASSWORD); await page.click('button[type=submit]');
    await page.waitForSelector('#kode');
    await page.fill('#kode', generateSync({ secret: st.rahasia, epoch: Math.floor(Date.now() / 1000) + 30 * st.langkah++ })); await page.click('button[type=submit]');
    await page.waitForURL('**/staff'); await page.waitForSelector('.kartu');
  };
  const keluarUI = async () => { await page.goto(`${WEB}/staff`); await page.waitForSelector('button.tombol-sekunder'); await page.click('button.tombol-sekunder'); await page.waitForURL('**/staff/masuk'); };
  const itAdm = await buatStaff('it', ['IT_ADMIN']);
  const direktur = await buatStaff('dir', ['DIREKTUR'], true);
  const marketing = await buatStaff('mkt', ['MARKETING']);
  const KODE = `E${randomBytes(2).toString('hex').toUpperCase()}`;

  // 8a. IT membuat perusahaan baru (tanpa ubah kode)
  await masukUI(itAdm);
  assert.ok(await page.isVisible('a:has-text("Perusahaan")'), 'IT melihat menu Perusahaan');
  await page.click('a:has-text("Perusahaan")'); await page.waitForURL('**/staff/perusahaan');
  await page.click('summary:has-text("Tambah perusahaan")');
  await page.fill('#nama', 'PT SINTETIS E2E'); await page.fill('#kode', 'x'); await page.click('button[type=submit]');
  assert.match(await page.textContent('[role=alert].galat'), /Kode singkat/); // validasi Indonesia dari API
  await page.fill('#kode', KODE); await page.click('button[type=submit]');
  assert.match(await page.textContent('[role=status].sukses'), /menunggu persetujuan/i);
  assert.match(await page.textContent('.butir'), /MENUNGGU PERSETUJUAN/);
  await periksa('perusahaan-it'); await foto('08-perusahaan-it');
  await keluarUI();

  // 8b. Direktur menyetujui aktivasi
  await masukUI(direktur);
  await page.goto(`${WEB}/staff/persetujuan`);
  await page.waitForSelector('.butir');
  assert.match(await page.textContent('.butir'), /Aktivasi perusahaan baru/);
  await periksa('persetujuan'); await foto('09-persetujuan');
  await page.click('button:has-text("Setujui")');
  assert.match(await page.textContent('[role=status].sukses'), /disetujui/i);
  await page.goto(`${WEB}/staff/perusahaan`);
  await page.waitForSelector('.butir');
  assert.match(await page.textContent('body'), new RegExp(`Kode ${KODE} AKTIF`));
  await keluarUI();
  const comp = await pool.query(`SELECT id FROM companies WHERE short_code = $1`, [KODE]);
  assert.equal(comp.rowCount, 1);
  await pool.query(`INSERT INTO user_company_scopes (user_id, scope_company_id) VALUES ($1, $2)`, [marketing.uid, comp.rows[0].id]);

  // 8c. Marketing: rekanan, lokasi, kontak, kontrak
  await masukUI(marketing);
  assert.ok(!(await page.isVisible('a:has-text("Persetujuan")')), 'Marketing tidak melihat menu Persetujuan');
  await page.click('a:has-text("Rekanan")'); await page.waitForURL('**/staff/rekanan');
  await page.click('summary:has-text("Tambah rekanan")');
  await page.fill('#nama', 'REKANAN SINTETIS E2E'); await page.fill('#kota', 'Bandung'); await page.click('button[type=submit]');
  assert.match(await page.textContent('[role=status].sukses'), /Rekanan ditambahkan/);
  await periksa('rekanan'); await foto('10-rekanan');
  await page.click('a:has-text("Lihat detail REKANAN SINTETIS E2E")'); await page.waitForURL(/\/staff\/rekanan\/[0-9a-f-]{36}/);
  await page.waitForSelector('#h-lokasi');
  await page.click('summary:has-text("Tambah lokasi")');
  await page.fill('#lok-nama', 'Gedung Utama'); await page.fill('#lok-lat', '91'); await page.fill('#lok-lng', '106,8272'); await page.click('button:has-text("Simpan lokasi")');
  assert.match(await page.textContent('[role=alert].galat'), /Lintang/);
  await page.fill('#lok-lat', '-6,175392'); await page.click('button:has-text("Simpan lokasi")');
  assert.match(await page.textContent('[role=status].sukses'), /Lokasi ditambahkan/);
  assert.match(await page.textContent('#h-lokasi + .butir'), /-6\.175392, 106\.8272 · radius 100 m/);
  await page.click('summary:has-text("Tambah kontak")');
  await page.fill('#kontak-nama', 'PIC Sintetis'); await page.click('button:has-text("Simpan kontak")');
  assert.match(await page.textContent('[role=status].sukses'), /Kontak ditambahkan/);
  await page.click('summary:has-text("Tambah kontrak")');
  await page.fill('#ktr-nomor', 'KTR/E2E/001'); await page.fill('#ktr-jenis', 'Keamanan'); await page.fill('#ktr-mulai', '2026-02-01'); await page.fill('#ktr-akhir', '2026-01-01'); await page.click('button:has-text("Simpan kontrak")');
  assert.match(await page.textContent('[role=alert].galat'), /sebelum/);
  await page.fill('#ktr-akhir', '2026-12-31'); await page.click('button:has-text("Simpan kontrak")');
  assert.match(await page.textContent('[role=status].sukses'), /DRAFT/);
  assert.match(await page.textContent('#h-kontrak + .butir'), /KTR\/E2E\/001 DRAFT/);
  assert.match(await page.textContent('#h-kontrak + .butir'), /1 Februari 2026 – 31 Desember 2026/);
  assert.ok(!(await page.isVisible('button:has-text("Aktifkan kontrak")')), 'Marketing tidak dapat mengaktifkan kontrak');
  await periksa('detail-rekanan'); await foto('11-detail-rekanan');
  const detailUrl = page.url();
  await keluarUI();

  // 8d. Direktur mengaktifkan kontrak (bukan pembuat)
  await masukUI(direktur);
  await page.goto(detailUrl);
  await page.waitForSelector('#h-kontrak + .butir');
  await page.click('button:has-text("Aktifkan kontrak KTR/E2E/001")');
  assert.match(await page.textContent('[role=status].sukses'), /diaktifkan/);
  assert.match(await page.textContent('#h-kontrak + .butir'), /KTR\/E2E\/001 AKTIF/);
  await periksa('kontrak-aktif'); await foto('12-kontrak-aktif');
  const cl = await pool.connect(); // RLS berlaku juga bagi pemeriksa: baca dalam transaksi bersekop perusahaan
  await cl.query('BEGIN'); await cl.query(`SELECT set_config('app.company_ids', $1, true)`, [comp.rows[0].id]);
  const k = await cl.query(`SELECT status, approved_by, created_by FROM partner_contracts WHERE contract_number = 'KTR/E2E/001'`);
  await cl.query('ROLLBACK'); cl.release();
  assert.equal(k.rows[0].status, 'AKTIF');
  assert.equal(k.rows[0].approved_by, direktur.uid);
  assert.equal(k.rows[0].created_by, marketing.uid);
  await keluarUI();

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
