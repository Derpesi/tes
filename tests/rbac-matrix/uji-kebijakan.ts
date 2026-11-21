import type { Matriks } from './parse-matriks';

/** Kebijakan hak akses yang diuji: mengembalikan himpunan kode izin untuk (peran, modul). */
export type Kebijakan = (peran: string, modul: string) => Set<string>;

export interface HasilUji {
  lolos: boolean;
  /** Izin yang diberikan kebijakan tetapi TIDAK ada di docs/rbac.md. */
  kelebihan: string[];
  /** Izin yang ada di docs/rbac.md tetapi tidak diberikan kebijakan. */
  kekurangan: string[];
  /** Laporan teks peran x modul. */
  laporan: string;
}

export function ujiKebijakan(kebijakan: Kebijakan, matriks: Matriks): HasilUji {
  const kelebihan: string[] = [];
  const kekurangan: string[] = [];
  const baris: string[] = [['Modul', ...matriks.peran].join(' | ')];

  for (const [modul, perPeran] of matriks.sel) {
    const sel: string[] = [];
    for (const peran of matriks.peran) {
      const diharapkan = perPeran.get(peran) ?? new Set<string>();
      const aktual = kebijakan(peran, modul);
      const lebih = [...aktual].filter((k) => !diharapkan.has(k));
      const kurang = [...diharapkan].filter((k) => !aktual.has(k));
      lebih.forEach((k) => kelebihan.push(`${peran} / ${modul}: ${k}`));
      kurang.forEach((k) => kekurangan.push(`${peran} / ${modul}: ${k}`));
      sel.push(lebih.length || kurang.length ? `!${[...aktual].sort().join(',') || '–'}` : [...aktual].sort().join(',') || '–');
    }
    baris.push([modul, ...sel].join(' | '));
  }
  return {
    lolos: kelebihan.length === 0 && kekurangan.length === 0,
    kelebihan,
    kekurangan,
    laporan: baris.join('\n'),
  };
}

/** Kebijakan acuan: persis sama dengan matriks (untuk uji diri harness). */
export function kebijakanDariMatriks(m: Matriks): Kebijakan {
  return (peran, modul) => new Set(m.sel.get(modul)?.get(peran) ?? []);
}
