import { PasswordService, validasiPassword } from './password.service';

describe('validasiPassword', () => {
  const e = 'budi.santoso@contoh.invalid';
  it('menerima kata sandi panjang tanpa aturan komposisi', () => {
    expect(validasiPassword('kuda lari malam hari di sawah', e)).toEqual([]);
  });
  it('menolak yang terlalu pendek', () => {
    expect(validasiPassword('Pendek1!', e)).toContain('Kata sandi minimal 12 karakter');
  });
  it('menolak yang terlalu panjang', () => {
    expect(validasiPassword('x'.repeat(129) + 'a', e)).toContain('Kata sandi maksimal 128 karakter');
  });
  it('menolak satu karakter berulang', () => {
    expect(validasiPassword('aaaaaaaaaaaaaa', e)).toContain('Kata sandi tidak boleh terdiri dari satu karakter berulang');
  });
  it('menolak kata umum', () => {
    expect(validasiPassword('Password-123456-aman', e)).toContain('Kata sandi terlalu umum atau mudah ditebak');
    expect(validasiPassword('damarindo-2026-xyz', e)).toContain('Kata sandi terlalu umum atau mudah ditebak');
  });
  it('menolak yang memuat bagian email', () => {
    expect(validasiPassword('xx-budi.santoso-xx-yy', e)).toContain('Kata sandi tidak boleh memuat bagian dari email');
  });
  it('menghitung karakter unicode sebagai satu', () => {
    expect(validasiPassword('🙂'.repeat(12), e)).not.toContain('Kata sandi minimal 12 karakter');
  });
});

describe('PasswordService', () => {
  const s = new PasswordService();
  it('hash argon2id dapat diverifikasi dan tidak memuat password', async () => {
    const h = await s.hash('kuda lari malam hari');
    expect(h).toMatch(/^\$argon2id\$/);
    expect(h).not.toContain('kuda');
    expect(await s.verify(h, 'kuda lari malam hari')).toBe(true);
    expect(await s.verify(h, 'salah')).toBe(false);
  });
  it('hash berbeda tiap panggilan (salt acak)', async () => {
    expect(await s.hash('x-sama-sama-12')).not.toBe(await s.hash('x-sama-sama-12'));
  });
  it('verify mengembalikan false (bukan melempar) untuk hash rusak', async () => {
    expect(await s.verify('bukan-hash', 'x')).toBe(false);
  });
});
