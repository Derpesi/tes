import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Token acak aman (bawaan 256-bit) dalam base64url. */
export function tokenAcak(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(data: string | Buffer): Buffer {
  return createHash('sha256').update(data).digest();
}

/** HMAC-SHA256, dipakai mis. untuk menyamarkan email/IP di log percobaan masuk. */
export function hmac(kunci: Buffer, data: string): Buffer {
  return createHmac('sha256', kunci).update(data).digest();
}

/** Perbandingan waktu-konstan. Panjang berbeda dianggap tidak sama. */
export function samaAman(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

const IV = 12;
const TAG = 16;

/**
 * AES-256-GCM. Hasil: iv(12) | tag(16) | ciphertext. `aad` mengikat ciphertext pada konteksnya
 * (mis. "mfa:<userId>") sehingga tidak dapat dipindahkan ke baris/tujuan lain.
 */
export function enkripsi(plain: Buffer | string, kunci: Buffer, aad: string): Buffer {
  if (kunci.length !== 32) throw new Error('Kunci enkripsi harus 32 byte');
  const iv = randomBytes(IV);
  const c = createCipheriv('aes-256-gcm', kunci, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

/** Melempar error bila data diubah, kunci salah, atau aad tidak cocok. */
export function dekripsi(data: Buffer, kunci: Buffer, aad: string): Buffer {
  if (kunci.length !== 32) throw new Error('Kunci enkripsi harus 32 byte');
  if (data.length < IV + TAG) throw new Error('Data terenkripsi tidak valid');
  const d = createDecipheriv('aes-256-gcm', kunci, data.subarray(0, IV));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(data.subarray(IV, IV + TAG));
  return Buffer.concat([d.update(data.subarray(IV + TAG)), d.final()]);
}
