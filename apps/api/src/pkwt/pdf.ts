import { PDFDocument, PDFFont, StandardFonts, rgb } from 'pdf-lib';

const BULAN = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
/** "2026-05-17" -> "17 Mei 2026" (tanggal kalender, tanpa pergeseran zona waktu). */
export function tanggalPanjang(iso: string): string {
  const [t, b, h] = iso.slice(0, 10).split('-').map(Number);
  return `${h} ${BULAN[b - 1]} ${t}`;
}

export interface OpsiPdf {
  /** Baris judul (mis. nomor kontrak). Bukan teks hukum. */
  judul: string;
  /** Isi hasil render template (disediakan pengguna). */
  isi: string;
  /** Catatan kaki dari SISTEM (bukan klausul hukum): status dokumen. */
  catatanKaki: string;
  /** Penanda peringatan di kepala halaman (mis. template belum diverifikasi). */
  peringatan?: string;
}

const A4 = { l: 595.28, t: 841.89 };
const TEPI = 56;

/** Hanya karakter yang dikenal font baku (WinAnsi); yang lain diganti '?' agar pembuatan PDF tidak gagal. */
function bersihkan(font: PDFFont, teks: string): string {
  const dikenal = new Set(font.getCharacterSet());
  return [...teks.replace(/\r/g, '')].map((ch) => (ch === '\n' || ch === '\t' || dikenal.has(ch.codePointAt(0)!) ? ch : '?')).join('').replace(/\t/g, '    ');
}

function bungkus(font: PDFFont, ukuran: number, teks: string, lebar: number): string[] {
  const baris: string[] = [];
  for (const paragraf of teks.split('\n')) {
    if (paragraf.trim() === '') {
      baris.push('');
      continue;
    }
    let cur = '';
    for (const kata of paragraf.split(/\s+/)) {
      let kandidat = cur ? `${cur} ${kata}` : kata;
      if (font.widthOfTextAtSize(kandidat, ukuran) <= lebar) {
        cur = kandidat;
        continue;
      }
      if (cur) baris.push(cur);
      // kata sangat panjang dipotong per karakter
      kandidat = kata;
      while (font.widthOfTextAtSize(kandidat, ukuran) > lebar) {
        let n = kandidat.length;
        while (n > 1 && font.widthOfTextAtSize(kandidat.slice(0, n), ukuran) > lebar) n--;
        baris.push(kandidat.slice(0, n));
        kandidat = kandidat.slice(n);
      }
      cur = kandidat;
    }
    if (cur) baris.push(cur);
  }
  return baris;
}

/** Membuat PDF A4 sederhana (font baku). Dihasilkan sesuai permintaan dan TIDAK disimpan. */
export async function buatPdf(o: OpsiPdf): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(o.judul);
  doc.setCreator('DAMARINDO GROUP HRIS');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const tebal = await doc.embedFont(StandardFonts.HelveticaBold);
  const ukuran = 11;
  const tinggiBaris = 16;
  const lebar = A4.l - TEPI * 2;
  const baris = bungkus(font, ukuran, bersihkan(font, o.isi), lebar);
  const kaki = bungkus(font, 8, bersihkan(font, o.catatanKaki), lebar);

  let halaman = doc.addPage([A4.l, A4.t]);
  let y = A4.t - TEPI;
  const kepala = () => {
    halaman.drawText(bersihkan(tebal, o.judul), { x: TEPI, y, size: 12, font: tebal });
    y -= 20;
    if (o.peringatan) {
      halaman.drawText(bersihkan(tebal, o.peringatan), { x: TEPI, y, size: 9, font: tebal, color: rgb(0.7, 0.1, 0.1) });
      y -= 16;
    }
  };
  kepala();
  const batasBawah = TEPI + 14 * kaki.length + 10;
  for (const b of baris) {
    if (y < batasBawah) {
      halaman = doc.addPage([A4.l, A4.t]);
      y = A4.t - TEPI;
      kepala();
    }
    if (b) halaman.drawText(b, { x: TEPI, y, size: ukuran, font });
    y -= tinggiBaris;
  }
  // Catatan kaki sistem di setiap halaman.
  for (const p of doc.getPages()) {
    kaki.forEach((k, i) => p.drawText(k, { x: TEPI, y: TEPI - 4 + (kaki.length - 1 - i) * 11, size: 8, font, color: rgb(0.3, 0.3, 0.3) }));
  }
  return Buffer.from(await doc.save());
}
