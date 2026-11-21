import { createHash } from 'node:crypto';
import { BadRequestException, PayloadTooLargeException, UnsupportedMediaTypeException } from '@nestjs/common';

export const BATAS_UNGGAH_BYTE = 10 * 1024 * 1024;

export type MimeDiizinkan = 'application/pdf' | 'image/png' | 'image/jpeg';

export interface BerkasMasuk {
  buffer: Buffer;
  originalname: string;
  size: number;
}

export interface BerkasTervalidasi {
  mime: MimeDiizinkan;
  sha256: Buffer;
  ukuran: number;
  /** Nama asli yang sudah disanitasi (untuk tampilan/unduhan), bukan untuk jalur penyimpanan. */
  namaAsli: string;
}

const EKSTENSI: Record<MimeDiizinkan, string[]> = {
  'application/pdf': ['pdf'],
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
};

/** Jenis ditentukan dari ISI berkas (magic bytes), bukan dari ekstensi atau MIME yang diklaim klien. */
export function deteksiMime(b: Buffer): MimeDiizinkan | null {
  if (b.length >= 5 && b.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  return null;
}

export function sanitasiNamaBerkas(nama: string): string {
  const dasar = nama.split(/[\\/]/).pop() ?? '';
  const bersih = [...dasar]
    .filter((c) => c.charCodeAt(0) >= 32 && !'"<>|:*?'.includes(c))
    .join('')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120);
  return bersih || 'dokumen';
}

/**
 * Memvalidasi unggahan: tidak kosong, <= 10 MB, jenis dari magic bytes (PDF/PNG/JPEG), dan ekstensi (bila ada) harus
 * sesuai isi. Keterbatasan: belum ada pemindai virus, dan PDF berbahaya yang valid secara format tidak terdeteksi.
 */
export function periksaUnggahan(f: BerkasMasuk | undefined): BerkasTervalidasi {
  if (!f || !f.buffer) throw new BadRequestException({ kode: 'BERKAS_WAJIB', message: 'Berkas wajib diunggah' });
  if (f.buffer.length === 0) throw new BadRequestException({ kode: 'BERKAS_KOSONG', message: 'Berkas kosong' });
  if (f.buffer.length > BATAS_UNGGAH_BYTE) throw new PayloadTooLargeException({ kode: 'BERKAS_TERLALU_BESAR', message: 'Ukuran berkas melebihi batas 10 MB' });
  const mime = deteksiMime(f.buffer);
  if (!mime) throw new UnsupportedMediaTypeException({ kode: 'JENIS_BERKAS_TIDAK_DIDUKUNG', message: 'Jenis berkas tidak didukung. Gunakan PDF, PNG, atau JPEG' });
  const titik = f.originalname.lastIndexOf('.');
  const ekstensi = titik >= 0 ? f.originalname.slice(titik + 1).toLowerCase() : '';
  if (ekstensi && !EKSTENSI[mime].includes(ekstensi)) {
    throw new BadRequestException({ kode: 'EKSTENSI_TIDAK_SESUAI', message: 'Ekstensi berkas tidak sesuai dengan isinya' });
  }
  return { mime, sha256: createHash('sha256').update(f.buffer).digest(), ukuran: f.buffer.length, namaAsli: sanitasiNamaBerkas(f.originalname) };
}
