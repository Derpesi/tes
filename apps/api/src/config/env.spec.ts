import { randomBytes } from 'node:crypto';
import { muatEnv } from './env';

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
});
