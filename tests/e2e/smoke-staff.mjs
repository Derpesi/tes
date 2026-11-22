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

  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] }); // kamera dan izin palsu untuk uji absensi
  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, deviceScaleFactor: 1, locale: 'id-ID', permissions: ['geolocation', 'camera'], geolocation: { latitude: -6.9, longitude: 107.6, accuracy: 20 } });
  const page = await ctx.newPage();
  const galatKonsol = [];
  // Respons 401/400 yang memang diharapkan (belum masuk, kata sandi/kode salah, validasi formulir) dicatat Chromium sebagai galat jaringan.
  // Hanya pola itu yang dikecualikan; pelanggaran CSP dan galat lain tetap menggagalkan tes.
  const diharapkan = /Failed to load resource: the server responded with a status of (400|401|403|409)/; // 400/403/409: validasi dan penolakan backend yang sengaja dipicu tes
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


  // 9. Fase 5: alur member end-to-end. Sesi member dibuat sintetis lewat DB (Google belum dikonfigurasi di E2E; format sesi mengikuti SessionService).
  const buatHrd = async () => { const h = await buatStaff('hrd', ['HRD']); await pool.query(`INSERT INTO user_company_scopes (user_id, scope_company_id) VALUES ($1, $2)`, [h.uid, comp.rows[0].id]); return h; };
  const pm = await pool.query(`INSERT INTO persons (display_name) VALUES ('SINTETIS Member E2E') RETURNING id`);
  const um = await pool.query(`INSERT INTO users (person_id, realm, email, status) VALUES ($1, 'member', $2, 'AKTIF') RETURNING id`, [pm.rows[0].id, `e2e-member-${randomBytes(3).toString('hex')}@contoh.invalid`]);
  const tokenMember = randomBytes(32).toString('base64url');
  await pool.query(`INSERT INTO sessions (user_id, realm, token_hash, state, expires_at) VALUES ($1, 'member', $2, 'PENUH', now() + interval '2 hours')`, [um.rows[0].id, createHash('sha256').update(tokenMember).digest()]);
  const cdp = await ctx.newCDPSession(page); // awalan __Host- melarang atribut Domain, jadi cookie diset host-only lewat CDP
  const masukMember = async () => {
    await ctx.clearCookies();
    const r = await cdp.send('Network.setCookie', { name: '__Host-sid', value: tokenMember, url: WEB, path: '/', httpOnly: true, secure: true, sameSite: 'Lax' });
    assert.ok(r.success, 'cookie sesi member gagal diset');
  };
  const NIK_UJI = '9900000000000001'; // sintetis, bukan NIK nyata

  // 9a. Member: biodata, KTP, ajukan
  await masukMember();
  await page.goto(`${WEB}/saya`); await page.waitForSelector('.kartu');
  assert.match(await page.textContent('.kartu'), /Terdaftar/);
  assert.ok(!(await page.isVisible('a:has-text("Lowongan")')), 'member belum terverifikasi tidak melihat menu Lowongan');
  await periksa('member-beranda'); await foto('13-member-beranda');
  await page.click('a:has-text("Biodata dan dokumen")'); await page.waitForSelector('#nik');
  await page.fill('#nik', '123'); await page.fill('#nama', 'SINTETIS Pelamar E2E'); await page.click('button:has-text("Simpan biodata")');
  assert.match(await page.textContent('[role=alert].galat'), /NIK harus 16 digit/);
  await page.fill('#nik', NIK_UJI); await page.fill('#tempat', 'Bandung'); await page.fill('#lahir', '1995-05-17'); await page.selectOption('#gender', 'L');
  await page.fill('#alamat', 'Jl. Contoh No. 1'); await page.fill('#kota', 'Bandung'); await page.fill('#provinsi', 'Jawa Barat'); await page.fill('#telepon', '081234567890');
  await page.selectOption('#pendidikan', 'SMA/SMK'); await page.fill('#darurat-nama', 'SINTETIS Kerabat'); await page.fill('#darurat-telp', '081234500000');
  await page.click('button:has-text("Simpan biodata")');
  assert.match(await page.textContent('[role=status].sukses'), /Biodata disimpan/);
  await page.waitForSelector('button:has-text("Ajukan verifikasi")');
  await page.click('button:has-text("Ajukan verifikasi")');
  assert.match(await page.textContent('[role=alert].galat'), /Dokumen KTP/); // kelengkapan diperiksa backend
  await page.selectOption('#jenis', 'KTP');
  await page.setInputFiles('#berkas', { name: 'ktp.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\nKTP-SINTETIS-E2E\n%%EOF\n') });
  await page.click('button:has-text("Unggah dokumen")');
  assert.match(await page.textContent('[role=status].sukses'), /Dokumen diunggah/);
  await periksa('member-biodata'); await foto('14-member-biodata');
  await page.click('button:has-text("Ajukan verifikasi")');
  assert.match(await page.textContent('[role=status].sukses'), /Menunggu verifikasi/);

  // 9b. HRD mengembalikan untuk revisi (NIK tersamar; NIK penuh hanya lewat tombol teraudit)
  const hrd1 = await buatHrd();
  await masukUI(hrd1);
  await page.goto(`${WEB}/staff/anggota`); await page.waitForSelector('.butir');
  assert.match(await page.textContent('.butir'), /SINTETIS Pelamar E2E/);
  assert.match(await page.textContent('.butir'), /\*{12}0001/);
  assert.ok(!(await page.textContent('body')).includes(NIK_UJI), 'NIK penuh tidak tampil di daftar');
  await periksa('anggota'); await foto('15-anggota');
  await page.click('a:has-text("Buka SINTETIS Pelamar E2E")'); await page.waitForSelector('#h-dok');
  assert.ok(!(await page.textContent('body')).includes(NIK_UJI), 'NIK penuh tidak tampil di detail secara bawaan');
  await page.click('button:has-text("Tampilkan NIK lengkap")');
  await page.waitForSelector(`text=${NIK_UJI}`);
  assert.ok(await page.isVisible('a:has-text("Unduh ktp.pdf")'));
  await page.fill('#alasan', 'Foto KTP kurang jelas'); await page.click('button:has-text("Kembalikan untuk revisi")');
  assert.match(await page.textContent('[role=status].sukses'), /Dikembalikan/);
  await periksa('anggota-detail'); await foto('16-anggota-detail');
  await keluarUI();

  // 9c. Member melihat catatan HRD, lalu mengajukan ulang
  await masukMember();
  await page.goto(`${WEB}/saya`); await page.waitForSelector('.kartu');
  assert.match(await page.textContent('[role=alert].galat'), /Catatan HRD: Foto KTP kurang jelas/);
  await page.goto(`${WEB}/saya/biodata`); await page.waitForSelector('button:has-text("Ajukan verifikasi")');
  await page.click('button:has-text("Ajukan verifikasi")');
  assert.match(await page.textContent('[role=status].sukses'), /Menunggu verifikasi/);

  // 9d. HRD menyetujui, membuat dan membuka lowongan
  const hrd2 = await buatHrd();
  await masukUI(hrd2);
  await page.goto(`${WEB}/staff/anggota`); await page.waitForSelector('.butir');
  await page.click('a:has-text("Buka SINTETIS Pelamar E2E")'); await page.waitForSelector('button:has-text("Setujui verifikasi")');
  await page.click('button:has-text("Setujui verifikasi")');
  assert.match(await page.textContent('[role=status].sukses'), /diverifikasi/);
  await page.goto(`${WEB}/staff/lowongan`); await page.waitForSelector('summary:has-text("Tambah lowongan")');
  await page.click('summary:has-text("Tambah lowongan")');
  await page.fill('#judul', 'Satpam E2E'); await page.fill('#deskripsi', 'Deskripsi sintetis'); await page.click('button:has-text("Simpan lowongan")');
  assert.match(await page.textContent('[role=status].sukses'), /DRAFT/);
  await page.click('button:has-text("Buka lowongan Satpam E2E")');
  assert.match(await page.textContent('[role=status].sukses'), /Lowongan dibuka/);
  await periksa('lowongan-staff'); await foto('17-lowongan-staff');
  await keluarUI();

  // 9e. Member melamar
  await masukMember();
  await page.goto(`${WEB}/saya`); await page.waitForSelector('.kartu');
  assert.match(await page.textContent('.kartu'), /belum ditempatkan/i);
  await page.click('a:has-text("Lowongan")'); await page.waitForSelector('.butir');
  assert.match(await page.textContent('.butir'), /Satpam E2E/);
  await periksa('member-lowongan'); await foto('18-member-lowongan');
  await page.click('button:has-text("Lamar Satpam E2E")');
  assert.match(await page.textContent('[role=status].sukses'), /terkirim/);
  await page.goto(`${WEB}/saya/lamaran`); await page.waitForSelector('.butir');
  assert.match(await page.textContent('.butir'), /Satpam E2E/);
  assert.match(await page.textContent('.butir'), /DIAJUKAN/);
  await periksa('member-lamaran'); await foto('19-member-lamaran');

  // 9f. HRD menyeleksi sampai diterima (menunggu PKWT)
  const hrd3 = await buatHrd();
  await masukUI(hrd3);
  await page.goto(`${WEB}/staff/lamaran`); await page.waitForSelector('.butir');
  await page.click('a:has-text("Proses lamaran SINTETIS Pelamar E2E")'); await page.waitForSelector('button:has-text("Lanjut ke seleksi administrasi")');
  await page.click('button:has-text("Lanjut ke seleksi administrasi")');
  await page.waitForSelector('button:has-text("Lanjut ke interview")');
  await page.click('button:has-text("Lanjut ke interview")');
  await page.waitForSelector('button:has-text("Terima pelamar")');
  await page.click('button:has-text("Terima pelamar")');
  assert.match(await page.textContent('[role=status].sukses'), /menunggu PKWT/);
  assert.match(await page.textContent('.kartu'), /MENUNGGU PKWT/);
  await periksa('lamaran-detail'); await foto('20-lamaran-detail');
  await keluarUI();

  // 10. Fase 6: PKWT (template -> kontrak -> PDF -> scan -> verifikasi) dan penempatan; status member berubah OTOMATIS (tanpa mengatur DB).
  const buatStaffScope = async (kode, roles, semua = false) => { const x = await buatStaff(kode, roles, semua); if (!semua) await pool.query(`INSERT INTO user_company_scopes (user_id, scope_company_id) VALUES ($1, $2)`, [x.uid, comp.rows[0].id]); return x; };
  const hariWib = (selisih = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date(Date.now() + selisih * 86400000));
  const NOMOR_PREFIKS = 'PKWT/';
  const IDEM = 'Satpam E2E';

  // Login UI (kata sandi + TOTP) sudah diuji di bagian awal; bagian Fase 6 memakai sesi staf sintetis lewat DB agar tidak terkena pembatas laju autentikasi (10/menit/IP).
  const masukSesi = async (st) => {
    const tok = randomBytes(32).toString('base64url');
    await pool.query(`INSERT INTO sessions (user_id, realm, token_hash, state, expires_at) VALUES ($1, 'staff', $2, 'PENUH', now() + interval '2 hours')`, [st.uid, createHash('sha256').update(tok).digest()]);
    await ctx.clearCookies();
    const r = await cdp.send('Network.setCookie', { name: '__Host-sid', value: tok, url: WEB, path: '/', httpOnly: true, secure: true, sameSite: 'Lax' });
    assert.ok(r.success, 'cookie sesi staf gagal diset');
    await page.goto(`${WEB}/staff`); await page.waitForSelector('.kartu');
  };

  // 10a. HRD membuat template; Direktur mencatat verifikasi hukum (tanpa teks hukum bawaan sistem)
  const hrdTpl = await buatStaffScope('hrd-tpl', ['HRD']);
  await masukSesi(hrdTpl);
  await page.goto(`${WEB}/staff/template-pkwt`); await page.waitForSelector('summary:has-text("Tambah template")');
  assert.match(await page.textContent('body'), /Sistem tidak menyediakan teks hukum/);
  await page.click('summary:has-text("Tambah template")');
  await page.fill('#nama-tpl', 'Template E2E'); await page.fill('#isi-tpl', 'Gaji {{gaji}}'); await page.click('button:has-text("Simpan template")');
  assert.match(await page.textContent('[role=alert].galat'), /Variabel tidak dikenal: gaji/);
  await page.fill('#isi-tpl', 'CONTOH UJI — BUKAN DOKUMEN HUKUM. Nama: {{nama}}; Nomor: {{nomor}}; Jabatan: {{jabatan}}');
  await page.click('button:has-text("Simpan template")');
  assert.match(await page.textContent('[role=status].sukses'), /perlu diverifikasi/);
  await periksa('template-pkwt'); await foto('22-template-pkwt');
  await ctx.clearCookies();
  const dirTpl = await buatStaffScope('dir-tpl', ['DIREKTUR'], true);
  await masukSesi(dirTpl);
  await page.goto(`${WEB}/staff/template-pkwt`); await page.waitForSelector('.butir');
  await page.fill('input[id^="cat-"]', 'Diverifikasi ahli hukum (uji E2E)'); await page.click('button:has-text("Catat verifikasi Template E2E v1")');
  assert.match(await page.textContent('[role=status].sukses'), /sudah diverifikasi/);
  await ctx.clearCookies();

  // 10b. Adm membuat kontrak dari lamaran yang diterima; HRD mengajukan; HRD lain memeriksa; Direktur menyetujui
  const mulaiKontrak = hariWib(0);
  const akhirKontrak = hariWib(60);
  const adm = await buatStaffScope('adm', ['STAFF_ADMINISTRASI']);
  await masukSesi(adm);
  await page.goto(`${WEB}/staff/pkwt`); await page.waitForSelector('summary:has-text("Buat kontrak dari lamaran")');
  await page.click('summary:has-text("Buat kontrak dari lamaran")');
  await page.waitForFunction(() => document.querySelectorAll('#lamaran option').length > 1);
  await page.selectOption('#lamaran', { index: 1 }); await page.selectOption('#template', { index: 1 });
  await page.fill('#jabatan', IDEM); await page.fill('#mulai', mulaiKontrak); await page.fill('#akhir', hariWib(-1)); await page.click('button:has-text("Simpan kontrak")');
  assert.match(await page.textContent('[role=alert].galat'), /sebelum/);
  await page.fill('#akhir', akhirKontrak); await page.click('button:has-text("Simpan kontrak")');
  assert.match(await page.textContent('[role=status].sukses'), /draf/);
  await periksa('pkwt-daftar'); await foto('23-pkwt-daftar');
  await ctx.clearCookies();
  const hrdA1 = await buatStaffScope('hrd-a1', ['HRD']);
  await masukSesi(hrdA1);
  await page.goto(`${WEB}/staff/pkwt`); await page.waitForSelector('.butir');
  await page.click(`a:has-text("Buka kontrak ${NOMOR_PREFIKS}")`); await page.waitForSelector('button:has-text("Ajukan untuk diperiksa")');
  const urlKontrak = page.url();
  await page.click('button:has-text("Ajukan untuk diperiksa")');
  assert.match(await page.textContent('[role=status].sukses'), /diajukan/);
  await ctx.clearCookies();
  const hrdR = await buatStaffScope('hrd-r', ['HRD']);
  await masukSesi(hrdR);
  await page.goto(urlKontrak); await page.waitForSelector('button:has-text("Periksa dan teruskan")');
  await page.fill('#alasan-kembali', 'Mohon cek jabatan'); await page.click('button:has-text("Kembalikan ke draf")');
  assert.match(await page.textContent('[role=status].sukses'), /dikembalikan/);
  await ctx.clearCookies();
  await masukSesi(hrdA1); // pembuat/pengaju memperbaiki dan mengajukan ulang
  await page.goto(urlKontrak); await page.waitForSelector('button:has-text("Ajukan untuk diperiksa")');
  await page.click('button:has-text("Ajukan untuk diperiksa")');
  assert.match(await page.textContent('[role=status].sukses'), /diajukan/);
  await ctx.clearCookies();
  const hrdR2 = await buatStaffScope('hrd-r2', ['HRD']);
  await masukSesi(hrdR2);
  await page.goto(urlKontrak); await page.waitForSelector('button:has-text("Periksa dan teruskan")');
  await page.click('button:has-text("Periksa dan teruskan")');
  assert.match(await page.textContent('[role=status].sukses'), /menunggu persetujuan/);
  await ctx.clearCookies();
  const dirK = await buatStaffScope('dir-k', ['DIREKTUR'], true);
  await masukSesi(dirK);
  await page.goto(urlKontrak); await page.waitForSelector('button:has-text("Setujui kontrak")');
  assert.match(await page.textContent('.kartu'), /bukan tanda tangan sah/);
  await periksa('pkwt-detail-persetujuan'); await foto('24-pkwt-persetujuan');
  await page.click('button:has-text("Setujui kontrak")');
  assert.match(await page.textContent('[role=status].sukses'), /ditandatangani basah/);
  await ctx.clearCookies();

  // 10c. HRD mencetak PDF (diunduh via API), mengunggah scan; HRD lain memverifikasi -> kontrak sah dan aktif (tanggal mulai = hari ini)
  const hrdU = await buatStaffScope('hrd-u', ['HRD']);
  await masukSesi(hrdU);
  await page.goto(urlKontrak); await page.waitForSelector('a:has-text("Unduh PDF kontrak")');
  const pdf = await page.request.get(`${WEB}/api${new URL(urlKontrak).pathname.replace('/staff', '')}/pdf`);
  assert.equal(pdf.status(), 200);
  assert.match(pdf.headers()['content-type'], /application\/pdf/);
  const isiPdf = await pdf.body();
  assert.equal(isiPdf.subarray(0, 5).toString(), '%PDF-');
  await page.waitForSelector('h3:has-text("Unggah scan bertanda tangan")');
  await page.setInputFiles('#berkas', { name: 'kontrak-ttd.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\nSCAN-TTD-E2E\n%%EOF\n') });
  await page.click('button:has-text("Unggah scan")');
  assert.match(await page.textContent('[role=status].sukses'), /menunggu verifikasi/i);
  await periksa('pkwt-detail-scan'); await foto('25-pkwt-scan');
  await ctx.clearCookies();
  const hrdV = await buatStaffScope('hrd-v', ['HRD']);
  await masukSesi(hrdV);
  await page.goto(urlKontrak); await page.waitForSelector('button:has-text("Verifikasi scan kontrak-ttd.pdf")');
  await page.click('button:has-text("Verifikasi scan kontrak-ttd.pdf")');
  assert.match(await page.textContent('[role=status].sukses'), /Kontrak sah/);
  await page.waitForSelector('.kartu :text("Aktif")'); // tanggal mulai hari ini: siklus hidup langsung mengaktifkan
  await periksa('pkwt-detail-aktif'); await foto('26-pkwt-aktif');
  await ctx.clearCookies();

  // 10d. HRD merencanakan penempatan; Mgr Ops menyetujui -> penempatan AKTIF dan member menjadi karyawan OTOMATIS
  const hrdP = await buatStaffScope('hrd-p', ['HRD']);
  await masukSesi(hrdP);
  await page.goto(`${WEB}/staff/penempatan`); await page.waitForSelector('summary:has-text("Rencanakan penempatan")');
  await page.click('summary:has-text("Rencanakan penempatan")');
  await page.waitForFunction(() => document.querySelectorAll('#kontrak option').length > 1 && document.querySelectorAll('#rekanan option').length > 1);
  await page.selectOption('#kontrak', { index: 1 }); await page.selectOption('#rekanan', { label: 'REKANAN SINTETIS E2E' });
  await page.waitForFunction(() => document.querySelectorAll('#lokasi option').length > 1);
  await page.selectOption('#lokasi', { label: 'Gedung Utama' }); await page.fill('#mulai', mulaiKontrak);
  await page.click('button:has-text("Simpan penempatan")');
  assert.match(await page.textContent('[role=status].sukses'), /menunggu persetujuan/);
  await periksa('penempatan-hrd'); await foto('27-penempatan');
  await ctx.clearCookies();
  const ops = await buatStaffScope('ops', ['MANAGER_OPERASIONAL']);
  await masukSesi(ops);
  await page.goto(`${WEB}/staff/penempatan`); await page.waitForSelector('button:has-text("Setujui penempatan")');
  await page.click('button:has-text("Setujui penempatan")');
  assert.match(await page.textContent('[role=status].sukses'), /disetujui/);
  await page.waitForSelector('.butir .lencana-aktif'); // aktif otomatis (kontrak aktif dan tanggal mulai tiba)
  await page.goto(`${WEB}/staff/karyawan`); await page.waitForSelector('.angka');
  assert.match(await page.textContent('.butir:has-text("SINTETIS Pelamar E2E")'), /Satpam E2E/);
  assert.ok((await page.textContent('.angka')).match(/\d+Aktif/), 'ringkasan karyawan aktif tampil');
  await periksa('karyawan-aktif'); await foto('28-karyawan-aktif');
  await ctx.clearCookies();

  // 10e. Member: status KARYAWAN_AKTIF diturunkan OTOMATIS -> menu Lowongan hilang, dashboard menampilkan kontrak, backend menolak lamaran (403)
  await masukMember();
  await page.goto(`${WEB}/saya`); await page.waitForSelector('.kartu');
  assert.match(await page.textContent('body'), /Karyawan aktif/);
  assert.match(await page.textContent('[aria-label="Kontrak kerja"]'), /Satpam E2E/);
  assert.match(await page.textContent('[aria-label="Kontrak kerja"]'), /Gedung Utama/);
  assert.ok(!(await page.isVisible('a:has-text("Lowongan")')), 'karyawan aktif tidak melihat menu Lowongan');
  assert.match(await page.textContent('.kartu'), /Karyawan aktif tidak dapat melamar/);
  await periksa('member-karyawan-aktif'); await foto('29-member-karyawan-aktif');
  await page.goto(`${WEB}/saya/lowongan`); await page.waitForSelector('.butir'); // halaman dapat dibuka langsung, tetapi backend yang menegakkan
  await page.click('button:has-text("Lamar Satpam E2E")');
  assert.match(await page.textContent('[role=alert].galat'), /Karyawan aktif tidak dapat melamar/);
  const st = await pool.query(`SELECT status FROM member_profiles WHERE person_id = $1`, [pm.rows[0].id]);
  assert.equal(st.rows[0].status, 'KARYAWAN_AKTIF');
  const otomatis = await pool.query(`SELECT count(*)::int AS n FROM member_status_histories WHERE person_id = $1 AND to_status = 'KARYAWAN_AKTIF' AND actor_user_id IS NULL AND reason LIKE 'Otomatis:%'`, [pm.rows[0].id]);
  assert.equal(otomatis.rows[0].n, 1, 'perubahan status karyawan dicatat sebagai otomatis (tanpa aktor)');

  // 11. Fase 7: absensi QR + GPS + selfie. Pengaturan titik/shift/jadwal lewat UI staf; absen lewat UI member dengan geolokasi dan kamera palsu.
  const tenantQ = async (fn) => {
    const c = await pool.connect();
    try { await c.query('BEGIN'); await c.query(`SELECT set_config('app.company_ids', $1, true)`, [comp.rows[0].id]); const r = await fn(c); await c.query('COMMIT'); return r; }
    catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
  };
  await tenantQ((c) => c.query(`UPDATE partner_locations SET latitude = -6.9, longitude = 107.6, geofence_radius_m = 100 WHERE name = 'Gedung Utama'`));
  const hariIni7 = hariWib(0);

  // 11a. Mgr Ops membuat titik absensi; Adm mengunduh poster QR (izin export); izin kamera/lokasi hanya dibuka di /absen
  const ops7 = await buatStaffScope('ops7', ['MANAGER_OPERASIONAL']);
  await masukSesi(ops7);
  await page.goto(`${WEB}/staff/titik-absensi`); await page.waitForSelector('summary:has-text("Buat titik absensi")');
  await page.click('summary:has-text("Buat titik absensi")');
  await page.waitForFunction(() => document.querySelectorAll('#rekanan option').length > 1);
  await page.selectOption('#rekanan', { label: 'REKANAN SINTETIS E2E' });
  await page.waitForFunction(() => document.querySelectorAll('#lokasi option').length > 1);
  await page.selectOption('#lokasi', { label: 'Gedung Utama' });
  await page.click('button:has-text("Buat titik")');
  assert.match(await page.textContent('[role=status].sukses'), /Titik absensi dibuat/);
  await page.waitForSelector('.butir:has-text("Gedung Utama")');
  assert.ok(!(await page.isVisible('a:has-text("Unduh poster QR")')), 'Mgr Ops tidak memegang izin ekspor QR');
  await periksa('titik-absensi'); await foto('30-titik-absensi');
  const titik = (await tenantQ((c) => c.query(`SELECT id, public_code FROM attendance_points WHERE status = 'AKTIF' ORDER BY created_at DESC LIMIT 1`))).rows[0];
  await ctx.clearCookies();
  const adm7 = await buatStaffScope('adm7', ['STAFF_ADMINISTRASI']);
  await masukSesi(adm7);
  await page.goto(`${WEB}/staff/titik-absensi`); await page.waitForSelector('a:has-text("Unduh poster QR")');
  const qr = await page.request.get(`${WEB}${await page.getAttribute('a:has-text("Unduh poster QR")', 'href')}`);
  assert.equal(qr.status(), 200);
  assert.equal((await qr.body()).subarray(0, 5).toString(), '%PDF-');
  const cekHeader = async (jalur) => (await page.request.get(`${WEB}${jalur}`)).headers()['permissions-policy'];
  assert.equal(await cekHeader('/absen'), 'camera=(self), microphone=(), geolocation=(self)');
  assert.equal(await cekHeader('/'), 'camera=(), microphone=(), geolocation=()');
  assert.equal(await cekHeader('/staff'), 'camera=(), microphone=(), geolocation=()');
  await ctx.clearCookies();

  // 11b. Mgr Ops membuat shift fleksibel (mencakup seluruh hari) dan jadwal untuk penempatan member
  await masukSesi(ops7);
  await page.goto(`${WEB}/staff/jadwal`); await page.waitForSelector('summary:has-text("Tambah shift")');
  await page.click('summary:has-text("Tambah shift")');
  await page.fill('#s-nama', 'Fleksibel E2E'); await page.selectOption('#s-jenis', 'FLEXIBLE'); await page.fill('#s-mulai', '00:00'); await page.fill('#s-selesai', '23:59');
  await page.click('button:has-text("Simpan shift")');
  assert.match(await page.textContent('[role=status].sukses'), /Shift ditambahkan/);
  await page.click('summary:has-text("Tambah jadwal")');
  await page.waitForFunction(() => document.querySelectorAll('#j-p option').length > 1 && [...document.querySelectorAll('#j-s option')].some((o) => o.textContent === 'Fleksibel E2E'));
  await page.selectOption('#j-p', { index: 1 }); await page.selectOption('#j-s', { label: 'Fleksibel E2E' });
  for (const d of [6, 7]) await page.check(`#hari-${d}`);
  await page.fill('#j-mulai', hariIni7);
  await page.click('button:has-text("Simpan jadwal")');
  assert.match(await page.textContent('[role=status].sukses'), /Jadwal ditambahkan/);
  await periksa('jadwal'); await foto('31-jadwal');
  await ctx.clearCookies();

  // 11c. Member tanpa sesi diarahkan masuk dengan returnTo; lalu absen masuk (VALID), pulang di luar radius (DITOLAK), pulang dari perangkat baru (PERLU_VERIFIKASI)
  await page.goto(`${WEB}/absen?t=${titik.public_code}`);
  await page.waitForURL('**/masuk?returnTo=*');
  assert.equal(new URL(page.url()).searchParams.get('returnTo'), `/absen?t=${titik.public_code}`);
  assert.match(await page.getAttribute('a.tombol', 'href'), /\/api\/auth\/member\/google\/start\?returnTo=%2Fabsen%3Ft%3D/);
  await masukMember();
  await page.goto(`${WEB}/absen`); // tanpa kode titik
  assert.match(await page.textContent('body'), /Pindai QR di lokasi kerja/);
  await page.goto(`${WEB}/absen?t=${titik.public_code}`); await page.waitForSelector('button:has-text("Ambil lokasi saya")');
  await periksa('absen'); await foto('32-absen');
  const absenUI = async (jenis) => {
    await page.click(`label:has(#jenis-${jenis})`);
    await page.click('button:has-text("lokasi")');
    await page.waitForSelector('text=Lokasi terambil');
    await page.click('button:has-text("Buka kamera")'); await page.waitForSelector('video.kamera');
    await page.waitForFunction(() => { const v = document.querySelector('video.kamera'); return v && v.videoWidth > 0; });
    await page.click('button:has-text("Ambil foto")'); await page.waitForSelector('img.kamera');
    await page.click('button:has-text("Kirim absen")'); await page.waitForSelector('[role=status].kartu');
    return page.textContent('[role=status].kartu');
  };
  const masuk = await absenUI('MASUK');
  assert.match(masuk, /Valid/); assert.match(masuk, /Absen masuk tercatat pukul \d\d:\d\d WIB/);
  await foto('33-absen-valid');
  await ctx.setGeolocation({ latitude: -6.91, longitude: 107.6, accuracy: 20 }); // ~1,1 km dari titik
  await page.goto(`${WEB}/absen?t=${titik.public_code}`); await page.waitForSelector('button:has-text("Ambil lokasi saya")');
  const jauh = await absenUI('PULANG');
  assert.match(jauh, /Ditolak/); assert.match(jauh, /di luar radius/);
  await ctx.setGeolocation({ latitude: -6.9, longitude: 107.6, accuracy: 20 });
  await page.goto(`${WEB}/absen?t=${titik.public_code}`); await page.waitForSelector('button:has-text("Ambil lokasi saya")');
  await page.evaluate(() => window.localStorage.setItem('hris_perangkat', 'perangkat-e2e-kedua-0123456789abcdef'));
  const baru = await absenUI('PULANG');
  assert.match(baru, /Perlu verifikasi/); assert.match(baru, /perangkat baru/i);
  await foto('34-absen-perlu-verifikasi');
  await page.goto(`${WEB}/saya/absensi`); await page.waitForSelector('.butir');
  assert.equal(await page.locator('.butir').count(), 3);
  const riwayat = await page.textContent('main');
  for (const t of ['Valid', 'Ditolak', 'Perlu verifikasi', 'Perangkat baru']) assert.ok(riwayat.includes(t), `riwayat memuat "${t}": ${riwayat.slice(0, 600)}`);
  await periksa('riwayat-absensi'); await foto('35-riwayat-absensi');
  await page.goto(`${WEB}/saya`); await page.waitForSelector('a:has-text("Riwayat absensi")');
  await ctx.clearCookies();

  // 11d. PayAbs memeriksa dan melihat selfie (diaudit); Mgr Ops memutuskan dan menyetujui perangkat; peran lain tidak dapat melihat selfie
  const payabs7 = await buatStaffScope('payabs7', ['STAFF_PAYROLL_ABSENSI_REKANAN']);
  await masukSesi(payabs7);
  await page.goto(`${WEB}/staff/tinjauan-absensi`); await page.waitForSelector('.butir');
  assert.match(await page.textContent('.butir'), /Perangkat baru/);
  assert.match(await page.textContent('.butir'), /Menunggu pemeriksaan/);
  await page.click('button:has-text("Buka rincian")'); await page.waitForSelector('#alasan-periksa');
  await page.fill('#alasan-periksa', 'Wajah dan lokasi sesuai'); await page.click('button:has-text("Catat pemeriksaan")');
  assert.match(await page.textContent('[role=status].sukses'), /Pemeriksaan dicatat/);
  await page.click('button:has-text("Tampilkan selfie")');
  await page.waitForFunction(() => { const i = document.querySelector('img.foto-tinjau'); return i && i.complete && i.naturalWidth > 0; });
  assert.ok(!(await page.isVisible('#putusan')), 'PayAbs tidak dapat memutuskan');
  await periksa('tinjauan-absensi'); await foto('36-tinjauan-absensi');
  const rekPerlu = (await tenantQ((c) => c.query(`SELECT id FROM attendance_records WHERE status = 'PERLU_VERIFIKASI' ORDER BY created_at DESC LIMIT 1`))).rows[0].id;
  const dilihat = await tenantQ((c) => c.query(`SELECT actor_id FROM audit_logs WHERE action = 'attendance.selfie.viewed' AND object_id = $1`, [rekPerlu]));
  assert.ok(dilihat.rows.some((r) => r.actor_id === payabs7.uid), 'akses selfie tercatat di audit');
  await ctx.clearCookies();
  await masukSesi(ops7);
  await page.goto(`${WEB}/staff/tinjauan-absensi`); await page.waitForSelector('.butir');
  await page.click('button:has-text("Buka rincian")'); await page.waitForSelector('#putusan');
  assert.ok(await page.isVisible('button:has-text("Tampilkan selfie")'), 'Mgr Ops memegang selfie.view per matriks, sehingga tombol tampil');
  await page.selectOption('#putusan', 'DISETUJUI'); await page.selectOption('#perangkat', 'SETUJUI'); await page.fill('#alasan-putus', 'Perangkat milik pekerja');
  await page.click('button:has-text("Simpan putusan")');
  assert.match(await page.textContent('[role=status].sukses'), /Putusan dicatat/);
  const dev = await tenantQ((c) => c.query(`SELECT status FROM device_registrations ORDER BY first_seen_at DESC LIMIT 1`));
  assert.equal(dev.rows[0].status, 'DISETUJUI');
  await ctx.clearCookies();
  await masukSesi(adm7);
  assert.equal((await page.request.get(`${WEB}/api/attendance/records/${rekPerlu}/selfie`)).status(), 403, 'Adm tidak boleh melihat selfie');
  assert.equal((await page.request.get(`${WEB}/api/attendance/review`)).status(), 403);
  await ctx.clearCookies();

  // 11e. Rekap absensi dan ekspor CSV (Mgr Ops)
  await masukSesi(ops7);
  await page.goto(`${WEB}/staff/rekap-absensi`); await page.waitForSelector('#dari');
  await page.fill('#dari', hariIni7); await page.fill('#sampai', hariIni7); await page.click('button:has-text("Tampilkan rekap")');
  await page.waitForSelector('.butir:has-text("SINTETIS Pelamar E2E")');
  assert.match(await page.textContent('.butir:has-text("SINTETIS Pelamar E2E")'), /Hadir/);
  await periksa('rekap-absensi'); await foto('37-rekap-absensi');
  const csv = await page.request.get(`${WEB}/api/attendance/recap/export.csv?from=${hariIni7}&to=${hariIni7}`);
  assert.equal(csv.status(), 200);
  assert.match(csv.headers()['content-type'], /text\/csv/);
  const teksCsv = (await csv.body()).toString('utf8');
  assert.equal(teksCsv.charCodeAt(0), 0xfeff);
  assert.match(teksCsv, /Tanggal Shift,Nama,Lokasi/); assert.match(teksCsv, /SINTETIS Pelamar E2E/);
  await page.goto(`${WEB}/staff/koreksi-absensi`); await page.waitForSelector('text=Koreksi absensi');
  await periksa('koreksi-absensi');

  // 12. Fase 8: rekap payroll TAHAP AWAL. PayAbs membuka periode, menarik absensi, mengisi komponen; Keuangan memverifikasi; Direktur menyetujui;
  // Keuangan lain memfinalisasi; ekspor; koreksi resmi. Pembuat, pemeriksa, penyetuju, finalisator harus orang berbeda (pelanggaran ditolak backend).
  await ctx.clearCookies();
  await masukSesi(payabs7);
  await page.goto(`${WEB}/staff/payroll`); await page.waitForSelector('summary:has-text("Buka periode baru")');
  assert.match(await page.textContent('body'), /Tidak ada perhitungan gaji, PPh 21, BPJS/);
  await page.click('summary:has-text("Buka periode baru")');
  await page.selectOption('#kind', 'PARTNER'); assert.equal(await page.locator('#kind option').count(), 2, 'PayAbs hanya dapat membuka rekap rekanan');
  await page.fill('#label', 'Periode E2E'); await page.fill('#mulai', hariIni7); await page.fill('#akhir', hariIni7);
  await page.click('button:has-text("Buka periode")');
  assert.match(await page.textContent('[role=status].sukses'), /Periode dibuka/);
  await page.click('a:has-text("Buka rekap Periode E2E")'); await page.waitForSelector('button:has-text("Tarik absensi")');
  const urlRekap = page.url();
  await page.click('button:has-text("Tarik absensi")');
  await page.waitForSelector('.butir:has-text("SINTETIS Pelamar E2E")');
  assert.match(await page.textContent('.butir:has-text("SINTETIS Pelamar E2E")'), /Hadir 1/);
  await page.click('button:has-text("Tambah komponen untuk SINTETIS Pelamar E2E")'); await page.waitForSelector('#k-kind');
  await page.selectOption('#k-kind', 'TUNJANGAN'); await page.fill('#k-nama', 'Uang makan'); await page.fill('#k-nominal', '150.000,50');
  await page.click('button:has-text("Simpan komponen")');
  assert.match(await page.textContent('[role=alert].galat'), /Nominal harus berupa angka desimal/);
  await page.fill('#k-nominal', '150000.50'); await page.click('button:has-text("Simpan komponen")');
  assert.match(await page.textContent('[role=status].sukses'), /Komponen ditambahkan/);
  await page.click('button:has-text("Tambah komponen untuk SINTETIS Pelamar E2E")'); await page.waitForSelector('#k-kind');
  await page.selectOption('#k-kind', 'POTONGAN'); await page.fill('#k-nama', 'Seragam'); await page.fill('#k-nominal', '20000'); await page.click('button:has-text("Simpan komponen")');
  await page.waitForSelector('.komponen:has-text("Seragam")');
  assert.match(await page.textContent('.kartu'), /Tunjangan 150000\.50 · Potongan 20000\.00 · Insentif 0\.00/);
  assert.ok(!(await page.isVisible('button:has-text("Verifikasi rekap")')), 'PayAbs tidak memegang izin verifikasi');
  assert.ok(!(await page.isVisible('a:has-text("Ekspor csv")')), 'belum disetujui: tanpa ekspor');
  await periksa('payroll-draf'); await foto('38-payroll-draf');
  await ctx.clearCookies();

  const keu1 = await buatStaffScope('keu1', ['STAFF_KEUANGAN']);
  const dir8 = await buatStaffScope('dir8', ['DIREKTUR']);
  const keu2 = await buatStaffScope('keu2', ['STAFF_KEUANGAN']);
  await masukSesi(keu1);
  await page.goto(urlRekap); await page.waitForSelector('button:has-text("Verifikasi rekap")');
  assert.ok(!(await page.isVisible('button:has-text("Tarik absensi")')), 'Keuangan tidak menyunting');
  await page.click('button:has-text("Verifikasi rekap")');
  assert.match(await page.textContent('[role=status].sukses'), /diverifikasi/);
  await page.waitForSelector('button:has-text("Setujui rekap")');
  await page.click('button:has-text("Setujui rekap")'); // pemeriksa yang sama: ditolak backend
  assert.match(await page.textContent('[role=alert].galat'), /Penyetuju tidak boleh sama dengan pembuat atau pemeriksa/);
  await periksa('payroll-diverifikasi'); await foto('39-payroll-diverifikasi');
  await ctx.clearCookies();
  await masukSesi(dir8);
  await page.goto(urlRekap); await page.waitForSelector('button:has-text("Setujui rekap")');
  await page.click('button:has-text("Setujui rekap")');
  assert.match(await page.textContent('[role=status].sukses'), /disetujui/);
  await page.waitForSelector('button:has-text("Finalisasi rekap")');
  await page.click('button:has-text("Finalisasi rekap")'); // penyetuju yang sama: ditolak backend
  assert.match(await page.textContent('[role=alert].galat'), /Finalisator tidak boleh sama/);
  assert.ok(!(await page.isVisible('a:has-text("Ekspor csv")')), 'Direktur tidak memegang izin ekspor rekap rekanan');
  await ctx.clearCookies();
  await masukSesi(keu2);
  await page.goto(urlRekap); await page.waitForSelector('button:has-text("Finalisasi rekap")');
  await page.click('button:has-text("Finalisasi rekap")');
  assert.match(await page.textContent('[role=status].sukses'), /difinalisasi/);
  await ctx.clearCookies();

  // 12b. Ekspor oleh Keuangan (izin export rekanan); setiap ekspor dicatat; formula injection dinetralkan
  await masukSesi(keu1);
  await page.goto(urlRekap); await page.waitForSelector('a:has-text("Ekspor csv")');
  const idRekap = new URL(urlRekap).pathname.split('/').pop();
  const csvP = await page.request.get(`${WEB}/api/payroll/recaps/${idRekap}/export.csv`);
  assert.equal(csvP.status(), 200);
  const teksP = (await csvP.body()).toString('utf8');
  assert.equal(teksP.charCodeAt(0), 0xfeff); assert.match(teksP, /SINTETIS Pelamar E2E/); assert.match(teksP, /150000\.50,20000\.00,0\.00/);
  const xl = await page.request.get(`${WEB}/api/payroll/recaps/${idRekap}/export.xlsx`);
  assert.equal(xl.status(), 200); assert.equal((await xl.body()).subarray(0, 2).toString(), 'PK');
  const pd = await page.request.get(`${WEB}/api/payroll/recaps/${idRekap}/export.pdf`);
  assert.equal(pd.status(), 200); assert.equal((await pd.body()).subarray(0, 5).toString(), '%PDF-');
  await page.reload(); await page.waitForSelector('text=Riwayat ekspor');
  assert.equal(await page.locator('#h-eks ~ p').count(), 3, 'tiga ekspor tercatat');
  await periksa('payroll-difinalisasi'); await foto('40-payroll-difinalisasi');
  await ctx.clearCookies();

  // 12c. Koreksi resmi oleh PayAbs: versi baru bernomor (salinan DRAFT); versi lama tetap utuh
  await masukSesi(payabs7);
  await page.goto(urlRekap); await page.waitForSelector('summary:has-text("Koreksi resmi")');
  assert.ok(!(await page.isVisible('button:has-text("Tarik absensi")')), 'rekap final tidak dapat disunting langsung');
  await page.click('summary:has-text("Koreksi resmi")');
  await page.fill('#alasan-koreksi', 'Uang makan perlu disesuaikan'); await page.click('button:has-text("Buat versi koreksi")');
  await page.waitForFunction(() => /Versi 2|versi 2/.test(document.body.textContent ?? '') && /KRP\//.test(document.body.textContent ?? ''));
  assert.match(await page.textContent('.kartu'), /Draf \(disusun\)/);
  assert.match(await page.textContent('.kartu'), /Alasan koreksi: Uang makan perlu disesuaikan/);
  await page.waitForSelector('.butir:has-text("SINTETIS Pelamar E2E") .komponen:has-text("Uang makan")'); // komponen tersalin
  await periksa('payroll-koreksi'); await foto('41-payroll-koreksi');
  const v1 = await tenantQ((c) => c.query(`SELECT status FROM payroll_recaps WHERE id = $1`, [idRekap]));
  assert.equal(v1.rows[0].status, 'DIFINALISASI', 'versi 1 tetap utuh sampai versi koreksi disetujui');
  await ctx.clearCookies();

  // 13. Fase 9: dashboard staf per izin, laporan konsolidasi, dan penampil audit (kategori per peran).
  await ctx.clearCookies();
  const dari13 = hariWib(-30);
  await masukSesi(dir8);
  await page.waitForSelector('.butir:has-text("Karyawan aktif")');
  assert.match(await page.textContent('.butir:has-text("Karyawan aktif")'), /Karyawan aktif\s*[1-9]/); // karyawan E2E ditempatkan
  assert.ok(await page.isVisible('.butir:has-text("Rekap payroll")'), 'Direktur melihat widget payroll');
  assert.ok(await page.isVisible('a:has-text("Laporan konsolidasi")') && await page.isVisible('a:has-text("Audit log")'));
  await periksa('beranda-direktur'); await foto('42-beranda-direktur');
  await page.goto(`${WEB}/staff/laporan`); await page.waitForSelector('#laporan');
  await page.selectOption('#laporan', 'workforce'); await page.fill('#dari', dari13); await page.fill('#sampai', hariIni7);
  await page.click('button:has-text("Tampilkan laporan")'); await page.waitForSelector('section:has-text("Karyawan aktif")');
  assert.match(await page.textContent('section:has-text("Karyawan aktif")'), /Karyawan aktif/);
  assert.doesNotMatch(await page.textContent('main'), /SINTETIS Pelamar E2E/, 'laporan tanpa nama pekerja');
  await periksa('laporan-workforce'); await foto('43-laporan-workforce');
  await page.selectOption('#laporan', 'attendance'); await page.click('button:has-text("Tampilkan laporan")'); await page.waitForSelector('section:has-text("Absensi per lokasi")');
  assert.match(await page.textContent('section:has-text("Absensi per lokasi")'), /Rekaman valid/);
  await page.selectOption('#laporan', 'payroll'); await page.click('button:has-text("Tampilkan laporan")'); await page.waitForSelector('section:has-text("Payroll rekanan")');
  assert.match(await page.textContent('section:has-text("Payroll rekanan")'), /subtotal tunjangan[^0-9]*150000\.50/);
  const csvLap = await page.request.get(`${WEB}/api/reports/payroll/export.csv?from=${dari13}&to=${hariIni7}`);
  assert.equal(csvLap.status(), 200); assert.equal((await csvLap.body()).toString('utf8').charCodeAt(0), 0xfeff);
  await page.goto(`${WEB}/staff/audit`); await page.waitForSelector('.butir');
  const kategoriDir = await page.locator('.butir h3').allTextContents();
  assert.ok(kategoriDir.some((a) => a.startsWith('payroll.')) && kategoriDir.some((a) => a.startsWith('attendance.') || a.startsWith('master.') || a.startsWith('pkwt.')), 'Direktur melihat banyak kategori');
  await periksa('audit-direktur'); await foto('44-audit-direktur');
  await ctx.clearCookies();

  // IT: dashboard tanpa data bisnis; audit hanya TEKNIS dan TANPA rincian; tanpa menu laporan
  const it9 = await buatStaffScope('it9', ['IT_ADMIN']);
  await masukSesi(it9);
  await page.waitForSelector('.butir:has-text("Pengguna staf")');
  assert.ok(!(await page.isVisible('.butir:has-text("Karyawan aktif")')), 'IT tidak melihat widget karyawan');
  assert.ok(!(await page.isVisible('a:has-text("Laporan konsolidasi")')), 'IT tidak memiliki laporan konsolidasi');
  await page.goto(`${WEB}/staff/audit`); await page.waitForSelector('.butir');
  const aksiIt = await page.locator('.butir h3').allTextContents();
  assert.ok(aksiIt.length > 0 && aksiIt.every((a) => a.startsWith('auth.')), `IT hanya melihat aksi teknis: ${aksiIt.slice(0, 5).join(',')}`);
  assert.equal(await page.locator('summary:has-text("Rincian")').count(), 0, 'IT tidak melihat rincian audit');
  assert.equal((await (await page.request.get(`${WEB}/api/audit-logs?action=payroll.&limit=5`)).json()).items.length, 0);
  assert.equal((await page.request.get(`${WEB}/api/reports/workforce?from=${dari13}&to=${hariIni7}`)).status(), 403);
  await periksa('audit-it'); await foto('45-audit-it');
  await ctx.clearCookies();

  // Keuangan: audit hanya transaksi (payroll/laporan); HRD: laporan tanpa bagian payroll
  const keu9 = await buatStaffScope('keu9', ['STAFF_KEUANGAN']);
  await masukSesi(keu9);
  await page.goto(`${WEB}/staff/audit`); await page.waitForSelector('.butir');
  const aksiKeu = await page.locator('.butir h3').allTextContents();
  assert.ok(aksiKeu.length > 0 && aksiKeu.every((a) => a.startsWith('payroll.') || a.startsWith('report.')), `Keuangan hanya melihat transaksi: ${aksiKeu.slice(0, 5).join(',')}`);
  await ctx.clearCookies();
  const hrd9 = await buatStaffScope('hrd9', ['HRD']);
  await masukSesi(hrd9);
  assert.ok(!(await page.isVisible('.butir:has-text("Rekap payroll")')), 'HRD tidak melihat widget payroll');
  assert.ok(!(await page.isVisible('a:has-text("Audit log")')), 'HRD tidak memiliki audit log');
  await page.goto(`${WEB}/staff/laporan`); await page.waitForSelector('#laporan');
  await page.selectOption('#laporan', 'payroll'); await page.fill('#dari', dari13); await page.fill('#sampai', hariIni7);
  await page.click('button:has-text("Tampilkan laporan")');
  await page.waitForSelector('text=Tidak ada bagian laporan yang dapat Anda lihat');
  assert.ok(!(await page.isVisible('a:has-text("Ekspor CSV")')), 'HRD tidak memegang izin ekspor laporan');
  await page.selectOption('#laporan', 'recruitment'); await page.click('button:has-text("Tampilkan laporan")'); await page.waitForSelector('section:has-text("Lowongan")');
  await periksa('laporan-hrd'); await foto('46-laporan-hrd');
  await ctx.clearCookies();

  assert.deepEqual(galatKonsol, [], `galat konsol/CSP: ${galatKonsol.join(' | ')}`);
  await browser.close();
  await pool.end();
  console.log('E2E staff (360 px): LULUS');
}

let kode = 0;
try { await utama(); } catch (e) { console.error('E2E GAGAL:', e.message); if (process.env.E2E_DEBUG) console.error(e.stack); kode = 1; }
berhenti();
const admin = new Pool({ connectionString: DB, max: 1 });
await admin.query(`DROP SCHEMA IF EXISTS ${SKEMA} CASCADE`).catch(() => undefined);
await admin.end();
process.exit(kode);
