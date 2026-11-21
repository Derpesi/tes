import { Injectable } from '@nestjs/common';
import { Algorithm, hash, verify } from '@node-rs/argon2';
import { tokenAcak } from '../common/crypto/crypto';

// Parameter argon2id: minimum rekomendasi OWASP (m=19 MiB, t=2, p=1). Disetel ulang setelah uji beban.
const OPSI = { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

// Daftar kata umum sederhana (BUKAN daftar kebocoran lengkap; keterbatasan dicatat di docs/security.md).
const UMUM = ['password', 'passw0rd', 'katasandi', 'kata sandi', 'qwerty', '123456', 'abcdef', 'iloveyou', 'letmein', 'welcome', 'admin', 'indonesia', 'damarindo', 'hris'];

export function validasiPassword(password: string, email: string): string[] {
  const galat: string[] = [];
  const panjang = [...password].length;
  if (panjang < 12) galat.push('Kata sandi minimal 12 karakter');
  if (panjang > 128) galat.push('Kata sandi maksimal 128 karakter');
  if (panjang > 0 && new Set(password).size === 1) galat.push('Kata sandi tidak boleh terdiri dari satu karakter berulang');
  const rendah = password.toLowerCase();
  if (UMUM.some((k) => rendah.includes(k))) galat.push('Kata sandi terlalu umum atau mudah ditebak');
  const lokal = email.trim().toLowerCase().split('@')[0];
  if (lokal.length >= 4 && rendah.includes(lokal)) galat.push('Kata sandi tidak boleh memuat bagian dari email');
  return galat;
}

@Injectable()
export class PasswordService {
  /** Hash tiruan agar waktu respons login untuk email tak dikenal mendekati email dikenal. */
  private dummy?: Promise<string>;

  hash(password: string): Promise<string> {
    return hash(password, OPSI);
  }

  verify(hashTersimpan: string, password: string): Promise<boolean> {
    return verify(hashTersimpan, password).catch(() => false);
  }

  async verifikasiTiruan(password: string): Promise<void> {
    this.dummy ??= hash(tokenAcak(), OPSI);
    await verify(await this.dummy, password).catch(() => false);
  }
}
