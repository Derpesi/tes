import { BadRequestException } from '@nestjs/common';

export interface Kursor {
  /** Waktu dalam teks Postgres (mikrodetik utuh), mis. "2026-11-21 07:06:03.613169+00". */
  t: string;
  id: string;
}

const TEKS_WAKTU_PG = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const encodeKursor = (k: Kursor): string => Buffer.from(JSON.stringify(k)).toString('base64url');

/** Mengurai dan memvalidasi kursor keyset. Kursor palsu/rusak -> 400 (tidak pernah sampai ke query). */
export function decodeKursor(mentah: string | undefined): Kursor | null {
  if (!mentah) return null;
  try {
    const k = JSON.parse(Buffer.from(mentah, 'base64url').toString()) as Partial<Kursor>;
    if (typeof k.t === 'string' && typeof k.id === 'string' && TEKS_WAKTU_PG.test(k.t) && UUID.test(k.id)) return { t: k.t, id: k.id };
  } catch {
    /* jatuh ke galat di bawah */
  }
  throw new BadRequestException({ kode: 'KURSOR_TIDAK_VALID', message: 'Kursor halaman tidak valid' });
}
