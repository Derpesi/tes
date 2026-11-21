import { dekripsi, enkripsi, hmac } from './crypto';

/** Versi skema kunci PII. Rotasi kunci belum ada; kolom key_version disiapkan agar migrasi data kelak dapat dilacak. */
export const VERSI_KUNCI_PII = 1;

const NIK = /^[0-9]{16}$/;
export const nikValid = (nik: string): boolean => NIK.test(nik);

/** Blind index NIK untuk keunikan "satu orang satu akun". Prefiks domain memisahkan penggunaan kunci HMAC dari CSRF/email/dll. */
export function blindIndexNik(kunciHmac: Buffer, nik: string): Buffer {
  return hmac(kunciHmac, `pii:nik:${nik}`);
}

export const enkripsiNik = (nik: string, kunci: Buffer, profileId: string): Buffer => enkripsi(nik, kunci, `member_profile:${profileId}:nik`);
export const dekripsiNik = (data: Buffer, kunci: Buffer, profileId: string): string => dekripsi(data, kunci, `member_profile:${profileId}:nik`).toString('utf8');

/** NIK tersamar untuk tampilan: hanya 4 digit terakhir. */
export const samarkanNik = (nik: string): string => `${'*'.repeat(Math.max(nik.length - 4, 0))}${nik.slice(-4)}`;

/** Isi berkas identitas dienkripsi sebelum disimpan; AAD = kunci objek sehingga tidak dapat dipindah ke objek lain. */
export const enkripsiBerkas = (isi: Buffer, kunci: Buffer, kunciObjek: string): Buffer => enkripsi(isi, kunci, `berkas:${kunciObjek}`);
export const dekripsiBerkas = (data: Buffer, kunci: Buffer, kunciObjek: string): Buffer => dekripsi(data, kunci, `berkas:${kunciObjek}`);
