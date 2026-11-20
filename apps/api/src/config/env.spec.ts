import { muatEnv } from './env';

describe('muatEnv', () => {
  it('menolak bila DATABASE_URL kosong', () => {
    expect(() => muatEnv({ NODE_ENV: 'test' } as NodeJS.ProcessEnv)).toThrow(/DATABASE_URL wajib diisi/);
  });
  it('menolak format DATABASE_URL yang salah', () => {
    expect(() => muatEnv({ DATABASE_URL: 'mysql://x' } as NodeJS.ProcessEnv)).toThrow(/postgres/);
  });
  it('menerima konfigurasi valid dengan PORT bawaan', () => {
    const env = muatEnv({ DATABASE_URL: 'postgres://u:p@localhost:5432/db' } as NodeJS.ProcessEnv);
    expect(env.PORT).toBe(3001);
  });
});
