import { randomUUID } from 'node:crypto';

export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');

/**
 * Antarmuka penyimpanan objek privat. Driver lokal dipakai untuk dev/tes; driver S3-kompatibel ditambahkan setelah
 * hosting dipilih (D-06). Objek TIDAK PERNAH dilayani langsung ke publik: unduhan lewat API dengan cek izin + scope + audit.
 */
export interface ObjectStorage {
  simpan(kunci: string, data: Buffer): Promise<void>;
  baca(kunci: string): Promise<Buffer>;
  hapus(kunci: string): Promise<void>;
}

export class ObjekTidakDitemukan extends Error {
  constructor() {
    super('Objek tidak ditemukan');
    this.name = 'ObjekTidakDitemukan';
  }
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** Kunci objek selalu `<companyId>/<uuid-acak>`: tidak memuat nama berkas dari pengguna. */
export const POLA_KUNCI = new RegExp(`^${UUID}/${UUID}$`);

export function buatKunciObjek(companyId: string): string {
  const kunci = `${companyId}/${randomUUID()}`;
  if (!POLA_KUNCI.test(kunci)) throw new Error('companyId tidak valid untuk kunci objek');
  return kunci;
}

/** Kunci objek berkas member: `<personId>/<uuid-acak>` (berkas member tidak ber-company_id). */
export function buatKunciObjekMember(personId: string): string {
  const kunci = `${personId}/${randomUUID()}`;
  if (!POLA_KUNCI.test(kunci)) throw new Error('personId tidak valid untuk kunci objek');
  return kunci;
}
