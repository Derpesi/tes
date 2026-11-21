import { inflateSync } from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import { buatPdf, tanggalPanjang } from './pdf';

/** Mengambil teks yang digambar (string heksa di operator Tj) dari seluruh aliran konten yang dapat didekompresi. */
function teksPdf(pdf: Buffer): string {
  const mentah = pdf.toString('latin1');
  const hasil: string[] = [];
  for (const m of mentah.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let isi: string;
    try {
      isi = inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1');
    } catch {
      isi = m[1];
    }
    for (const t of isi.matchAll(/<([0-9a-fA-F]+)>\s*Tj/g)) hasil.push(Buffer.from(t[1], 'hex').toString('latin1'));
  }
  return hasil.join('\n').replace(/\u0097/g, '—'); // WinAnsi 0x97 = tanda pisah panjang
}

describe('PDF PKWT', () => {
  it('menghasilkan PDF sah satu halaman dengan isi, judul, dan catatan kaki sistem', async () => {
    const pdf = await buatPdf({ judul: 'Nomor: PKWT/DMR/2026/0001', isi: 'CONTOH UJI — BUKAN DOKUMEN HUKUM\nNama: SINTETIS Pekerja', catatanKaki: 'DRAF — belum sah sebelum ditandatangani basah dan diverifikasi' });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect((await PDFDocument.load(pdf)).getPageCount()).toBe(1);
    const teks = teksPdf(pdf);
    expect(teks).toContain('PKWT/DMR/2026/0001');
    expect(teks).toContain('Nama: SINTETIS Pekerja');
    expect(teks).toContain('DRAF — belum sah sebelum ditandatangani basah');
    expect(teks).toContain('CONTOH UJI — BUKAN DOKUMEN HUKUM');
  });
  it('isi panjang dipecah ke beberapa halaman; karakter di luar font diganti, bukan gagal', async () => {
    const isi = Array.from({ length: 120 }, (_, i) => `Baris uji ${i} ${'kata '.repeat(12)}`).join('\n') + '\nEmoji 😀 dan 漢字';
    const pdf = await buatPdf({ judul: 'J', isi, catatanKaki: 'k' });
    expect((await PDFDocument.load(pdf)).getPageCount()).toBeGreaterThan(2);
    expect(teksPdf(pdf)).toContain('Emoji ? dan ??');
  });
  it('kata sangat panjang tidak melebihi tepi halaman (tidak gagal)', async () => {
    const pdf = await buatPdf({ judul: 'J', isi: 'x'.repeat(500), catatanKaki: 'k', peringatan: 'TEMPLATE BELUM DIVERIFIKASI' });
    expect(teksPdf(pdf)).toContain('TEMPLATE BELUM DIVERIFIKASI');
  });
  it('tanggal panjang Indonesia tanpa pergeseran zona waktu', () => {
    expect(tanggalPanjang('2026-05-17')).toBe('17 Mei 2026');
    expect(tanggalPanjang('2026-01-01')).toBe('1 Januari 2026');
    expect(tanggalPanjang('2026-12-31T00:00:00.000Z')).toBe('31 Desember 2026');
  });
});
