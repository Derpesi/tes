import { crc32, deflateRawSync } from 'node:zlib';

/**
 * Penulis xlsx MINIMAL (OOXML dalam ZIP, tanpa dependency; exceljs ditolak kebijakan lisensi/audit). Hanya yang dibutuhkan rekap: beberapa lembar,
 * sel teks (inline string) dan sel angka desimal. Teks yang berawalan = + - @ TAB CR diberi apostrof (anti formula injection) dan selalu ditulis sebagai
 * STRING (tidak pernah rumus). Nominal ditulis apa adanya dari teks desimal (tidak ada perhitungan float di sini).
 */
export type SelXlsx = string | number | null | { angka: string };
export interface LembarXlsx { nama: string; baris: SelXlsx[][] }

const BERBAHAYA = /^[=+\-@\t\r]/;
const POLA_ANGKA = /^-?\d{1,15}(\.\d{1,6})?$/;
// Karakter kontrol yang tidak sah di XML 1.0.
// eslint-disable-next-line no-control-regex
const KONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

export const xmlAman = (t: string): string => t.replace(KONTROL, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const kolom = (i: number): string => {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

/** Nama lembar: maksimal 31 karakter, tanpa : \ / ? * [ ]. */
export const namaLembar = (n: string): string => n.replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 31) || 'Lembar';

function selXml(v: SelXlsx, ref: string): string {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number') return Number.isFinite(v) ? `<c r="${ref}"><v>${v}</v></c>` : '';
  if (typeof v === 'object') return POLA_ANGKA.test(v.angka) ? `<c r="${ref}"><v>${v.angka}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlAman(v.angka)}</t></is></c>`;
  const teks = BERBAHAYA.test(v) ? `'${v}` : v;
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlAman(teks)}</t></is></c>`;
}

const lembarXml = (baris: SelXlsx[][]): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${baris
    .map((b, r) => `<row r="${r + 1}">${b.map((v, c) => selXml(v, `${kolom(c)}${r + 1}`)).join('')}</row>`)
    .join('')}</sheetData></worksheet>`;

interface Berkas { nama: string; isi: Buffer }

/** ZIP sederhana (deflate, tanda waktu tetap agar deterministik). */
export function zip(berkas: Berkas[]): Buffer {
  const lokal: Buffer[] = [];
  const pusat: Buffer[] = [];
  let offset = 0;
  for (const b of berkas) {
    const nama = Buffer.from(b.nama, 'utf8');
    const data = deflateRawSync(b.isi);
    const crc = crc32(b.isi);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(8, 8); h.writeUInt16LE(0, 10); h.writeUInt16LE(0x0021, 12);
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(b.isi.length, 22); h.writeUInt16LE(nama.length, 26); h.writeUInt16LE(0, 28);
    lokal.push(h, nama, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10); c.writeUInt16LE(0, 12); c.writeUInt16LE(0x0021, 14);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(b.isi.length, 24); c.writeUInt16LE(nama.length, 28); c.writeUInt32LE(offset, 42);
    pusat.push(c, nama);
    offset += h.length + nama.length + data.length;
  }
  const ukuranPusat = pusat.reduce((s, x) => s + x.length, 0);
  const akhir = Buffer.alloc(22);
  akhir.writeUInt32LE(0x06054b50, 0); akhir.writeUInt16LE(berkas.length, 8); akhir.writeUInt16LE(berkas.length, 10); akhir.writeUInt32LE(ukuranPusat, 12); akhir.writeUInt32LE(offset, 16);
  return Buffer.concat([...lokal, ...pusat, akhir]);
}

export function buatXlsx(lembar: LembarXlsx[]): Buffer {
  if (!lembar.length) throw new RangeError('Minimal satu lembar');
  const nama = lembar.map((l) => namaLembar(l.nama));
  if (new Set(nama.map((n) => n.toLowerCase())).size !== nama.length) throw new RangeError('Nama lembar harus unik');
  const xml = (isi: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${isi}`;
  const berkas: Berkas[] = [
    { nama: '[Content_Types].xml', isi: Buffer.from(xml(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${lembar.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`)) },
    { nama: '_rels/.rels', isi: Buffer.from(xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`)) },
    { nama: 'xl/workbook.xml', isi: Buffer.from(xml(`<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${nama.map((n, i) => `<sheet name="${xmlAman(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`)) },
    { nama: 'xl/_rels/workbook.xml.rels', isi: Buffer.from(xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${lembar.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`)) },
    ...lembar.map((l, i) => ({ nama: `xl/worksheets/sheet${i + 1}.xml`, isi: Buffer.from(lembarXml(l.baris)) })),
  ];
  return zip(berkas);
}
