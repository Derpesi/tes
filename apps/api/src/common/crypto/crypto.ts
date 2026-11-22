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
/** Penanda format berversi. Format lama (sebelum rotasi kunci) tidak berawalan: iv | tag | ciphertext, kunci id 1. */
const MAGIC = 0xe1;
const KEY_LEN = 32;

/**
 * Cincin kunci enkripsi berversi. `aktif` = id tertinggi (dipakai untuk SEMUA penulisan baru); kunci lain hanya untuk membaca data lama
 * sampai semuanya dienkripsi ulang (lihat alat rotasi, ADR-0013).
 */
export interface KunciEnkripsi {
  readonly aktif: number;
  readonly kunci: ReadonlyMap<number, Buffer>;
}
/** Buffer tunggal = cincin satu kunci dengan id 1 (kompatibel dengan kode/tes yang memberi satu kunci). */
export type SumberKunci = Buffer | KunciEnkripsi;

export function cincinKunci(daftar: { id: number; kunci: Buffer }[]): KunciEnkripsi {
  if (daftar.length === 0) throw new Error('Cincin kunci kosong');
  const peta = new Map<number, Buffer>();
  for (const { id, kunci } of daftar) {
    if (!Number.isInteger(id) || id < 1 || id > 255) throw new Error('Id kunci harus bilangan bulat 1-255');
    if (kunci.length !== KEY_LEN) throw new Error('Kunci enkripsi harus 32 byte');
    if (peta.has(id)) throw new Error('Id kunci ganda');
    peta.set(id, kunci);
  }
  return { aktif: Math.max(...peta.keys()), kunci: peta };
}
const jadiCincin = (k: SumberKunci): KunciEnkripsi => (Buffer.isBuffer(k) ? cincinKunci([{ id: 1, kunci: k }]) : k);

function gcmEnkripsi(plain: Buffer | string, kunci: Buffer, aad: string): Buffer {
  const iv = randomBytes(IV);
  const c = createCipheriv('aes-256-gcm', kunci, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}
function gcmDekripsi(data: Buffer, kunci: Buffer, aad: string): Buffer {
  if (data.length < IV + TAG) throw new Error('Data terenkripsi tidak valid');
  const d = createDecipheriv('aes-256-gcm', kunci, data.subarray(0, IV));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(data.subarray(IV, IV + TAG));
  return Buffer.concat([d.update(data.subarray(IV + TAG)), d.final()]);
}

/**
 * AES-256-GCM dengan kunci AKTIF. Hasil: 0xE1 | idKunci | iv(12) | tag(16) | ciphertext. `aad` mengikat ciphertext pada konteksnya
 * (mis. "mfa:<userId>") sehingga tidak dapat dipindahkan ke baris/tujuan lain.
 */
export function enkripsi(plain: Buffer | string, sumber: SumberKunci, aad: string): Buffer {
  const k = jadiCincin(sumber);
  return Buffer.concat([Buffer.from([MAGIC, k.aktif]), gcmEnkripsi(plain, k.kunci.get(k.aktif)!, aad)]);
}

export interface HasilDekripsi {
  isi: Buffer;
  /** Id kunci yang berhasil membuka data. */
  versi: number;
  /** true = format lama tanpa awalan (dianggap kunci id 1). */
  lama: boolean;
}

/**
 * Membuka data berversi maupun format lama. Tebakan format aman: GCM memastikan kegagalan autentikasi, sehingga awalan palsu pada data lama
 * jatuh ke jalur format lama. Melempar bila data diubah, kunci tidak tersedia/salah, atau aad tidak cocok.
 */
export function dekripsiBerversi(data: Buffer, sumber: SumberKunci, aad: string): HasilDekripsi {
  const k = jadiCincin(sumber);
  if (data.length >= 2 + IV + TAG && data[0] === MAGIC) {
    const kunci = k.kunci.get(data[1]);
    if (kunci) {
      try {
        return { isi: gcmDekripsi(data.subarray(2), kunci, aad), versi: data[1], lama: false };
      } catch {
        /* mungkin data lama yang kebetulan berawalan 0xE1: coba format lama */
      }
    }
  }
  const kunci1 = k.kunci.get(1);
  if (!kunci1 || data.length < IV + TAG) throw new Error('Data terenkripsi tidak valid atau kunci tidak tersedia');
  return { isi: gcmDekripsi(data, kunci1, aad), versi: 1, lama: true };
}

export function dekripsi(data: Buffer, sumber: SumberKunci, aad: string): Buffer {
  return dekripsiBerversi(data, sumber, aad).isi;
}
