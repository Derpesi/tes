/** Pesan untuk kode galat pada redirect `/masuk?galat=<kode>` (login Google). Semua berbahasa Indonesia. */
export const PESAN_GALAT_MASUK: Record<string, string> = {
  dibatalkan: 'Masuk dengan Google dibatalkan. Silakan coba lagi bila ingin melanjutkan.',
  sesi_kedaluwarsa: 'Sesi masuk sudah kedaluwarsa. Silakan mulai kembali.',
  email_belum_terverifikasi: 'Email Google Anda belum terverifikasi. Verifikasi email di akun Google lalu coba lagi.',
  akun_nonaktif: 'Akun Anda dinonaktifkan. Hubungi HRD Damarindo Group.',
  konflik_akun: 'Email ini sudah terdaftar dengan akun Google lain. Permintaan Anda diteruskan ke HRD untuk ditinjau.',
  gagal: 'Masuk dengan Google gagal. Silakan coba lagi.',
};

export function pesanGalatMasuk(kode: string | undefined | null): string | null {
  if (!kode) return null;
  return PESAN_GALAT_MASUK[kode] ?? PESAN_GALAT_MASUK.gagal;
}
