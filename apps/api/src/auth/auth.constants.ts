export const COOKIE_SESI = '__Host-sid';
/** Cookie pengikat transaksi OIDC ke browser yang memulai login (anti login-CSRF). */
export const COOKIE_OIDC = '__Host-oidc';

export const TTL = {
  /** Staff: tidak aktif selama ini => sesi berakhir (asumsi A-14). */
  staffIdleMs: 30 * 60 * 1000,
  /** Staff: batas mutlak sesi penuh (asumsi A-14). */
  staffAbsoluteMs: 8 * 60 * 60 * 1000,
  /** Sesi sementara (menunggu MFA / pendaftaran MFA). */
  tertundaMs: 10 * 60 * 1000,
  /** Member: tidak aktif selama ini => sesi berakhir (asumsi A-14). */
  memberIdleMs: 24 * 60 * 60 * 1000,
  /** Member: batas mutlak sesi penuh (asumsi A-14). */
  memberAbsoluteMs: 30 * 24 * 60 * 60 * 1000,
  /** Transaksi OIDC (dari start sampai callback). */
  oidcTransaksiMs: 10 * 60 * 1000,
  undanganMs: 7 * 24 * 60 * 60 * 1000,
  resetPasswordMs: 30 * 60 * 1000,
} as const;

export const KUNCI_AKUN = { maksGagal: 5, kunciMs: 15 * 60 * 1000 } as const;

/** Pesan seragam agar tidak membocorkan apakah email terdaftar atau akun terkunci. */
export const PESAN_LOGIN_GAGAL = 'Email atau kata sandi salah, atau akun terkunci sementara. Coba lagi nanti.';
export const PESAN_MFA_GAGAL = 'Kode verifikasi salah, sudah dipakai, atau akun terkunci sementara. Coba lagi nanti.';
export const ISSUER_TOTP = 'DAMARINDO GROUP HRIS';

export type StateSesi = 'PENUH' | 'MENUNGGU_MFA' | 'MENUNGGU_ENROLL_MFA';
export type Realm = 'member' | 'staff';

export function normalisasiEmail(e: string): string {
  return e.trim().toLowerCase();
}
