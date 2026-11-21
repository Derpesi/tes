import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const KODE_SAH = ['V', 'C', 'U', 'D', 'K', 'A', 'E', 'F', 'S'] as const;
export type Kode = (typeof KODE_SAH)[number];

export interface Matriks {
  peran: string[];
  /** modul -> peran -> himpunan kode izin */
  sel: Map<string, Map<string, Set<string>>>;
}

/** Mengurai satu sel, mis. "V,U(konfig)" atau "V(teknis, tanpa PII)" atau "–". */
export function uraiSel(teks: string): Set<string> {
  const bersih = teks.replace(/\([^)]*\)/g, '').replace(/\*/g, '').trim();
  if (bersih === '' || bersih === '–' || bersih === '-') return new Set();
  return new Set(bersih.split(',').map((x) => x.trim()).filter(Boolean));
}

export function uraiMatriks(markdown: string): Matriks {
  const baris = markdown.split('\n');
  const awal = baris.findIndex((b) => /^\|\s*Modul\s*\|/.test(b));
  if (awal < 0) throw new Error('Tabel matriks (header "Modul") tidak ditemukan di docs/rbac.md');
  const potong = (b: string) => b.trim().replace(/^\||\|$/g, '').split('|').map((x) => x.trim());
  const header = potong(baris[awal]);
  const peran = header.slice(1);
  const sel = new Map<string, Map<string, Set<string>>>();
  for (let i = awal + 2; i < baris.length && baris[i].trim().startsWith('|'); i++) {
    const kolom = potong(baris[i]);
    if (kolom.length !== header.length) throw new Error(`Baris matriks tidak sejajar dengan header: "${baris[i]}"`);
    const perPeran = new Map<string, Set<string>>();
    peran.forEach((p, idx) => perPeran.set(p, uraiSel(kolom[idx + 1])));
    sel.set(kolom[0], perPeran);
  }
  return { peran, sel };
}

export function muatMatriksRbac(): Matriks {
  return uraiMatriks(readFileSync(join(__dirname, '..', '..', 'docs', 'rbac.md'), 'utf8'));
}
