/**
 * Utilitas CSV aman. Sel yang diawali = + - @ (atau tab/CR) dapat dieksekusi sebagai rumus oleh spreadsheet (CSV/formula injection),
 * sehingga diawali apostrof; lalu sel dikutip bila memuat pemisah, kutip, atau baris baru.
 */
const BERBAHAYA = /^[=+\-@\t\r]/;
export function selCsv(nilai: unknown): string {
  let s = nilai === null || nilai === undefined ? '' : String(nilai);
  if (BERBAHAYA.test(s)) s = `'${s}`;
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const barisCsv = (sel: unknown[]): string => sel.map(selCsv).join(',');
/** BOM UTF-8 agar Excel membaca aksara dengan benar. */
const BOM = String.fromCharCode(0xfeff);
export const dokumenCsv = (kepala: string[], baris: unknown[][]): string => `${BOM}${[kepala, ...baris].map(barisCsv).join('\r\n')}\r\n`;
