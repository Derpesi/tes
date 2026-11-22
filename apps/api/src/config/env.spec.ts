import { randomBytes } from 'node:crypto';
import { ISSUER_GOOGLE, docsAktif, muatEnv, redirectUriGoogle } from './env';

const sah = (): NodeJS.ProcessEnv =>
  ({
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    APP_BASE_URL: 'https://hris.contoh.invalid',
    AUTH_HMAC_KEY: randomBytes(32).toString('base64'),
    APP_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  }) as NodeJS.ProcessEnv;

describe('muatEnv', () => {
  it('menolak bila DATABASE_URL kosong', () => {
    const e = sah();
    delete e.DATABASE_URL;
    expect(() => muatEnv(e)).toThrow(/DATABASE_URL wajib diisi/);
  });
  it('menolak format DATABASE_URL yang salah', () => {
    expect(() => muatEnv({ ...sah(), DATABASE_URL: 'mysql://x' })).toThrow(/postgres/);
  });
  it('menerima konfigurasi valid dengan PORT bawaan', () => {
    expect(muatEnv(sah()).PORT).toBe(3001);
  });
  it.each(['APP_BASE_URL', 'AUTH_HMAC_KEY', 'APP_ENCRYPTION_KEY'])('secret/konfigurasi wajib: %s tidak boleh kosong', (nama) => {
    const e = sah();
    delete e[nama];
    expect(() => muatEnv(e)).toThrow(new RegExp(`${nama} wajib diisi`));
  });
  it('APP_ENCRYPTION_KEY harus tepat 32 byte', () => {
    expect(() => muatEnv({ ...sah(), APP_ENCRYPTION_KEY: randomBytes(16).toString('base64') })).toThrow(/32 byte/);
  });
  it('AUTH_HMAC_KEY minimal 32 byte', () => {
    expect(() => muatEnv({ ...sah(), AUTH_HMAC_KEY: randomBytes(8).toString('base64') })).toThrow(/minimal 32 byte/);
  });
  it('APP_BASE_URL tidak boleh berakhir garis miring', () => {
    expect(() => muatEnv({ ...sah(), APP_BASE_URL: 'https://hris.contoh.invalid/' })).toThrow(/garis miring/);
  });
  it('Google OAuth: setengah terisi ditolak, kosong dan lengkap diterima', () => {
    expect(() => muatEnv({ ...sah(), GOOGLE_CLIENT_ID: 'id-sintetis' })).toThrow(/Google OAuth/);
    expect(muatEnv({ ...sah(), GOOGLE_CLIENT_ID: 'id-sintetis', GOOGLE_CLIENT_SECRET: 'rahasia-sintetis' }).GOOGLE_CLIENT_ID).toBe('id-sintetis');
  });
  it('SMTP: setengah terisi ditolak', () => {
    expect(() => muatEnv({ ...sah(), SMTP_HOST: 'localhost' })).toThrow(/SMTP/);
  });
  it('pesan error tidak memuat nilai rahasia', () => {
    const kunciSalah = randomBytes(16).toString('base64');
    try {
      muatEnv({ ...sah(), APP_ENCRYPTION_KEY: kunciSalah });
    } catch (e) {
      expect((e as Error).message).not.toContain(kunciSalah);
    }
  });
  it('string kosong dari .env dianggap tidak diisi (opsional)', () => {
    const e = muatEnv({ ...sah(), GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', SMTP_HOST: '', TRUST_PROXY: '', GOOGLE_ISSUER: '', API_PUBLIC_PATH: '' });
    expect(e.GOOGLE_CLIENT_ID).toBeUndefined();
    expect(e.SMTP_HOST).toBeUndefined();
    expect(e.TRUST_PROXY).toBe(0);
    expect(e.GOOGLE_ISSUER).toBe(ISSUER_GOOGLE);
    expect(e.API_PUBLIC_PATH).toBe('/api');
  });
  it('GOOGLE_ISSUER tidak boleh diubah di produksi, boleh di tes/pengembangan', () => {
    expect(() => muatEnv({ ...sah(), NODE_ENV: 'production', GOOGLE_ISSUER: 'http://127.0.0.1:9999' })).toThrow(/produksi/);
    expect(muatEnv({ ...sah(), NODE_ENV: 'test', GOOGLE_ISSUER: 'http://127.0.0.1:9999' }).GOOGLE_ISSUER).toBe('http://127.0.0.1:9999');
    expect(muatEnv({ ...sah(), NODE_ENV: 'production', STORAGE_DIR: '/var/lib/hris/objek' }).GOOGLE_ISSUER).toBe(ISSUER_GOOGLE);
  });
  it('API_PUBLIC_PATH harus berupa jalur dan membentuk redirect URI persis', () => {
    expect(() => muatEnv({ ...sah(), API_PUBLIC_PATH: 'api' })).toThrow(/API_PUBLIC_PATH/);
    expect(() => muatEnv({ ...sah(), API_PUBLIC_PATH: '/api/' })).toThrow(/API_PUBLIC_PATH/);
    expect(redirectUriGoogle(muatEnv(sah()))).toBe('https://hris.contoh.invalid/api/auth/member/google/callback');
  });
});

describe('docsAktif (dokumentasi API)', () => {
  it('bawaan: hidup di luar produksi, MATI di produksi', () => {
    expect(docsAktif({ NODE_ENV: 'development', API_DOCS: undefined })).toBe(true);
    expect(docsAktif({ NODE_ENV: 'test', API_DOCS: undefined })).toBe(true);
    expect(docsAktif({ NODE_ENV: 'production', API_DOCS: undefined })).toBe(false);
  });
  it('API_DOCS menimpa bawaan; nilai selain on/off ditolak skema', () => {
    expect(docsAktif({ NODE_ENV: 'production', API_DOCS: 'on' })).toBe(true);
    expect(docsAktif({ NODE_ENV: 'development', API_DOCS: 'off' })).toBe(false);
    expect(() => muatEnv({ ...sah(), API_DOCS: 'ya' })).toThrow(/API_DOCS harus on atau off/);
  });
});

describe('validasi konfigurasi produksi (gagal-cepat)', () => {
  const prod = (): NodeJS.ProcessEnv => ({ ...sah(), NODE_ENV: 'production', STORAGE_DIR: '/var/lib/hris/objek' }) as NodeJS.ProcessEnv;
  it('konfigurasi produksi yang benar diterima', () => {
    expect(muatEnv(prod()).NODE_ENV).toBe('production');
  });
  it('menolak APP_BASE_URL non-https di produksi, tetapi boleh di pengembangan', () => {
    expect(() => muatEnv({ ...prod(), APP_BASE_URL: 'http://hris.contoh.invalid' })).toThrow(/https/);
    expect(muatEnv({ ...sah(), APP_BASE_URL: 'http://localhost:3000' }).APP_BASE_URL).toBe('http://localhost:3000');
  });
  it('produksi: http hanya diizinkan untuk loopback (E2E lokal), bukan domain publik', () => {
    expect(muatEnv({ ...prod(), APP_BASE_URL: 'http://localhost:3000' }).APP_BASE_URL).toBe('http://localhost:3000');
    expect(muatEnv({ ...prod(), APP_BASE_URL: 'http://127.0.0.1:3000' }).APP_BASE_URL).toBe('http://127.0.0.1:3000');
    expect(() => muatEnv({ ...prod(), APP_BASE_URL: 'http://localhost.evil.invalid' })).toThrow(/https/);
  });
  it('menolak produksi tanpa STORAGE_DIR (folder bawaan tidak boleh dipakai)', () => {
    const e = prod();
    delete e.STORAGE_DIR;
    expect(() => muatEnv(e)).toThrow(/STORAGE_DIR wajib diisi di produksi/);
  });
  it('menolak kunci yang sama untuk HMAC dan enkripsi', () => {
    const k = randomBytes(32).toString('base64');
    expect(() => muatEnv({ ...prod(), AUTH_HMAC_KEY: k, APP_ENCRYPTION_KEY: k })).toThrow(/harus berbeda/);
  });
  it('menolak kunci lemah (byte hampir seragam) tanpa menampilkan nilainya', () => {
    const lemah = Buffer.alloc(32, 7).toString('base64');
    expect(() => muatEnv({ ...prod(), AUTH_HMAC_KEY: lemah })).toThrow(/AUTH_HMAC_KEY terlalu lemah/);
    try {
      muatEnv({ ...prod(), AUTH_HMAC_KEY: lemah });
    } catch (e) {
      expect(String(e)).not.toContain(lemah);
    }
  });
  it('DB_POOL_MAX: bawaan 10, batas 2..100', () => {
    expect(muatEnv(sah()).DB_POOL_MAX).toBe(10);
    expect(muatEnv({ ...sah(), DB_POOL_MAX: '25' }).DB_POOL_MAX).toBe(25);
    expect(() => muatEnv({ ...sah(), DB_POOL_MAX: '1' })).toThrow(/DB_POOL_MAX/);
    expect(() => muatEnv({ ...sah(), DB_POOL_MAX: '500' })).toThrow(/DB_POOL_MAX/);
  });
});
