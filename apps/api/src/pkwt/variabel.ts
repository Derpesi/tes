/**
 * Variabel yang boleh dipakai di isi template PKWT. Daftar putih: variabel lain ditolak saat template dibuat.
 * Sistem TIDAK membawa teks hukum bawaan; isi template sepenuhnya disediakan pengguna dan diverifikasi ahli hukum di luar sistem.
 */
export const VARIABEL_TEMPLATE = ['nama', 'nik', 'nomor', 'jabatan', 'tanggal_mulai', 'tanggal_akhir', 'perusahaan', 'tanggal_cetak'] as const;
export type NamaVariabel = (typeof VARIABEL_TEMPLATE)[number];

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

/** Mengisi variabel. Variabel yang tidak punya nilai melempar galat (tidak pernah dibiarkan kosong diam-diam). */
export function isiTemplate(isi: string, nilai: Partial<Record<NamaVariabel, string>>): string {
  return isi.replace(POLA, (_m, nama: string) => {
    const v = (nilai as Record<string, string | undefined>)[nama];
    if (v === undefined) throw new Error(`Variabel tidak memiliki nilai: ${nama}`);
    return v;
  });
}
