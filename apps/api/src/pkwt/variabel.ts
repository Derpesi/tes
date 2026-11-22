/**
 * Variabel yang boleh dipakai di isi template PKWT. Daftar putih: variabel lain ditolak saat template dibuat.
 * Sistem TIDAK membawa teks hukum bawaan; isi template sepenuhnya disediakan pengguna dan diverifikasi ahli hukum di luar sistem.
 */
/** Variabel inti: WAJIB bernilai saat PDF dibuat (galat bila kosong, tidak pernah dibiarkan kosong diam-diam). */
export const VARIABEL_WAJIB = ['nama', 'nik', 'nomor', 'jabatan', 'tanggal_mulai', 'tanggal_akhir', 'perusahaan', 'tanggal_cetak'] as const;
/**
 * Variabel data master/penempatan yang boleh belum tersedia (mis. legalitas perusahaan belum diisi, lokasi belum dipilih pada lowongan):
 * bila tidak ada nilainya, dicetak sebagai titik-titik agar diisi tangan di dokumen cetak (dan dilaporkan sebagai "isian tangan").
 */
export const VARIABEL_ISIAN_TANGAN = [
  'perusahaan_hukum', 'perusahaan_hukum_kapital', 'perusahaan_alamat', 'perusahaan_legalitas', 'penandatangan_nama', 'penandatangan_jabatan', 'kota_penandatanganan', 'pengadilan_negeri',
  'tempat_lahir', 'tanggal_lahir', 'pendidikan', 'alamat_pekerja', 'kontak_pekerja', 'pengguna_jasa', 'alamat_pengguna_jasa', 'jenis_pekerjaan',
] as const;
export const VARIABEL_TEMPLATE = [...VARIABEL_WAJIB, ...VARIABEL_ISIAN_TANGAN] as const;
export type NamaVariabel = (typeof VARIABEL_TEMPLATE)[number];

/** Pengganti isian tangan. */
export const TITIK_ISIAN = '…………………………………………………';

const POLA = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/** Daftar nama variabel yang muncul di isi template (unik, urut kemunculan). */
export function ekstrakVariabel(isi: string): string[] {
  const hasil: string[] = [];
  for (const m of isi.matchAll(POLA)) if (!hasil.includes(m[1])) hasil.push(m[1]);
  return hasil;
}

/** Variabel di luar daftar putih. Kosong = sah. */
export function variabelTidakDikenal(isi: string): string[] {
  return ekstrakVariabel(isi).filter((v) => !(VARIABEL_TEMPLATE as readonly string[]).includes(v));
}

export interface HasilIsiTemplate {
  teks: string;
  /** Nama variabel yang tidak punya nilai dan dicetak sebagai titik-titik (tanpa nilai apa pun). */
  isianTangan: string[];
}

/** Mengisi variabel. Variabel inti tanpa nilai melempar galat; variabel isian-tangan tanpa nilai menjadi titik-titik. Nilai tidak diperluas ulang. */
export function isiTemplateLengkap(isi: string, nilai: Partial<Record<NamaVariabel, string>>): HasilIsiTemplate {
  const isianTangan: string[] = [];
  const teks = isi.replace(POLA, (_m, nama: string) => {
    const v = (nilai as Record<string, string | undefined>)[nama];
    if (v !== undefined && v.trim() !== '') return v;
    if ((VARIABEL_ISIAN_TANGAN as readonly string[]).includes(nama)) {
      if (!isianTangan.includes(nama)) isianTangan.push(nama);
      return TITIK_ISIAN;
    }
    throw new Error(`Variabel tidak memiliki nilai: ${nama}`);
  });
  return { teks, isianTangan };
}

export function isiTemplate(isi: string, nilai: Partial<Record<NamaVariabel, string>>): string {
  return isiTemplateLengkap(isi, nilai).teks;
}
