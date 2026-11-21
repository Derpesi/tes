import { crc32, inflateRawSync } from 'node:zlib';
import { buatXlsx, namaLembar, xmlAman, zip } from './xlsx';

/** Pembaca ZIP minimal untuk tes (membaca direktori pusat, memeriksa CRC). */
export function bacaZip(buf: Buffer): Record<string, string> {
  const akhir = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const n = buf.readUInt16LE(akhir + 10);
  let p = buf.readUInt32LE(akhir + 16);
  const hasil: Record<string, string> = {};
  for (let i = 0; i < n; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const csize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const crc = buf.readUInt32LE(p + 16);
    const nl = buf.readUInt16LE(p + 28);
    const off = buf.readUInt32LE(p + 42);
    const nama = buf.subarray(p + 46, p + 46 + nl).toString('utf8');
    expect(buf.readUInt32LE(off)).toBe(0x04034b50);
    const ds = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const isi = inflateRawSync(buf.subarray(ds, ds + csize));
    expect(isi.length).toBe(size);
    expect(crc32(isi)).toBe(crc);
    hasil[nama] = isi.toString('utf8');
    p += 46 + nl + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return hasil;
}

describe('xlsx minimal', () => {
  it('menghasilkan paket OOXML sah: tipe konten, relasi, buku kerja, dan lembar; CRC dan ukuran benar', () => {
    const f = bacaZip(buatXlsx([{ nama: 'Rekap', baris: [['Nama', 'Nominal'], ['Budi', { angka: '150000.50' }]] }, { nama: 'Info', baris: [['k', 'v']] }]));
    expect(Object.keys(f).sort()).toEqual(['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']);
    expect(f['xl/workbook.xml']).toMatch(/<sheet name="Rekap" sheetId="1" r:id="rId1"\/><sheet name="Info" sheetId="2" r:id="rId2"\/>/);
    expect(f['xl/worksheets/sheet1.xml']).toContain('<c r="B2"><v>150000.50</v></c>'); // nominal tepat sebagai teks desimal, bukan hasil hitung float
    expect(f['xl/worksheets/sheet1.xml']).toContain('<c r="A2" t="inlineStr"><is><t xml:space="preserve">Budi</t></is></c>');
    expect(f['[Content_Types].xml']).toContain('worksheet+xml');
  });
  it.each(['=1+1', '+cmd|x', '-2+3', '@SUM(A1)', '\tTAB', '\rCR'])('teks berbahaya %j: apostrof dan tetap STRING (bukan rumus)', (v) => {
    const x = bacaZip(buatXlsx([{ nama: 'S', baris: [[v]] }]))['xl/worksheets/sheet1.xml'];
    expect(x).toMatch(/t="inlineStr"/);
    expect(x).not.toMatch(/<f>/);
    expect(x).toContain(`&apos;${xmlAman(v)}`.replace('&apos;&apos;', '&apos;'));
  });
  it('XML aman: karakter khusus di-escape dan kontrol dibuang; unicode tetap', () => {
    expect(xmlAman(`<a href="x">&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&apos;&lt;/a&gt;');
    expect(xmlAman('a\u0000b\u0008c\u001Fd')).toBe('abcd');
    const x = bacaZip(buatXlsx([{ nama: 'S', baris: [['Rp 1.000 — ünïcode 日本']] }]))['xl/worksheets/sheet1.xml'];
    expect(x).toContain('Rp 1.000 — ünïcode 日本');
  });
  it('angka tidak valid diperlakukan sebagai teks (tanpa injeksi XML); sel kosong dilewati; kolom di atas Z', () => {
    const x = bacaZip(buatXlsx([{ nama: 'S', baris: [[{ angka: '1</v><f>2' }, null, '', 5, Number.NaN, ...Array(30).fill('x')]] }]))['xl/worksheets/sheet1.xml'];
    expect(x).not.toContain('<f>');
    expect(x).toContain('t="inlineStr"');
    expect(x).toContain('<c r="D1"><v>5</v></c>');
    expect(x).toContain('r="AE1"'); // kolom ke-31
    expect(x).not.toContain('r="B1"');
  });
  it('nama lembar dibersihkan, dibatasi 31 karakter, dan harus unik', () => {
    expect(namaLembar('Rekap: a/b?*[c]')).toBe('Rekap  a b   c');
    expect(namaLembar('x'.repeat(40))).toHaveLength(31);
    expect(() => buatXlsx([{ nama: 'A', baris: [] }, { nama: 'a', baris: [] }])).toThrow(/unik/);
    expect(() => buatXlsx([])).toThrow();
  });
  it('zip deterministik dan dapat dibaca ulang untuk isi besar', () => {
    const besar = 'x'.repeat(100000);
    const a = zip([{ nama: 'a.txt', isi: Buffer.from(besar) }]);
    expect(zip([{ nama: 'a.txt', isi: Buffer.from(besar) }]).equals(a)).toBe(true);
    expect(bacaZip(a)['a.txt']).toBe(besar);
    expect(a.length).toBeLessThan(2000);
  });
});
