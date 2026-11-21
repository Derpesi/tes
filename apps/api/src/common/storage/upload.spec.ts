import { deteksiMime, periksaUnggahan, sanitasiNamaBerkas } from './upload';

const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
const berkas = (buffer: Buffer, originalname: string) => ({ buffer, originalname, size: buffer.length });

describe('deteksiMime (magic bytes)', () => {
  it('mengenali PDF, PNG, dan JPEG dari isinya', () => {
    expect(deteksiMime(PDF)).toBe('application/pdf');
    expect(deteksiMime(PNG)).toBe('image/png');
    expect(deteksiMime(JPG)).toBe('image/jpeg');
  });
  it('menolak yang lain: eksekutabel, skrip, HTML, SVG, teks, zip', () => {
    for (const isi of ['MZ\x90\x00 program windows', '#!/bin/sh\nrm -rf /', '<html><script>alert(1)</script>', '<svg onload=alert(1)>', 'teks biasa', 'PK\x03\x04']) {
      expect(deteksiMime(Buffer.from(isi, 'latin1'))).toBeNull();
    }
  });
  it('tidak melempar untuk buffer sangat pendek', () => {
    expect(deteksiMime(Buffer.alloc(0))).toBeNull();
    expect(deteksiMime(Buffer.from('%PD'))).toBeNull();
  });
});

describe('periksaUnggahan', () => {
  it('menerima berkas sah dan menghitung SHA-256', () => {
    const r = periksaUnggahan(berkas(PDF, 'Akta Pendirian.pdf'));
    expect(r).toMatchObject({ mime: 'application/pdf', ukuran: PDF.length, namaAsli: 'Akta Pendirian.pdf' });
    expect(r.sha256).toHaveLength(32);
  });
  it('JPEG boleh berekstensi jpg atau jpeg (huruf besar juga) dan tanpa ekstensi', () => {
    for (const n of ['a.jpg', 'a.JPEG', 'foto']) expect(periksaUnggahan(berkas(JPG, n)).mime).toBe('image/jpeg');
  });
  it('menolak penyamaran: eksekutabel bernama .pdf (isi bukan PDF)', () => {
    expect(() => periksaUnggahan(berkas(Buffer.from('MZ\x90\x00'), 'laporan.pdf'))).toThrow(/Jenis berkas tidak didukung/);
  });
  it('menolak ekstensi yang tidak sesuai isi (PNG bernama .pdf, PDF bernama .exe)', () => {
    expect(() => periksaUnggahan(berkas(PNG, 'x.pdf'))).toThrow(/Ekstensi berkas tidak sesuai/);
    expect(() => periksaUnggahan(berkas(PDF, 'x.exe'))).toThrow(/Ekstensi berkas tidak sesuai/);
  });
  it('menolak berkas kosong, tanpa berkas, dan melebihi 10 MB', () => {
    expect(() => periksaUnggahan(berkas(Buffer.alloc(0), 'a.pdf'))).toThrow(/Berkas kosong/);
    expect(() => periksaUnggahan(undefined)).toThrow(/wajib diunggah/);
    const besar = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(10 * 1024 * 1024)]);
    expect(() => periksaUnggahan(berkas(besar, 'besar.pdf'))).toThrow(/melebihi batas 10 MB/);
  });
  it('tepat 10 MB masih diterima', () => {
    const batas = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(10 * 1024 * 1024 - 5)]);
    expect(periksaUnggahan(berkas(batas, 'batas.pdf')).ukuran).toBe(10 * 1024 * 1024);
  });
});

describe('sanitasiNamaBerkas', () => {
  it('membuang jalur, traversal, dan karakter kontrol/berbahaya', () => {
    expect(sanitasiNamaBerkas('../../etc/passwd')).toBe('passwd');
    expect(sanitasiNamaBerkas('C:\\Windows\\system32\\a.pdf')).toBe('a.pdf');
    expect(sanitasiNamaBerkas('a\u0000b\nc<>:"|?*.pdf')).toBe('abc.pdf');
    expect(sanitasiNamaBerkas('...tersembunyi.pdf')).toBe('tersembunyi.pdf');
  });
  it('membatasi panjang dan memberi nama bawaan', () => {
    expect(sanitasiNamaBerkas('a'.repeat(500) + '.pdf').length).toBeLessThanOrEqual(120);
    expect(sanitasiNamaBerkas('')).toBe('dokumen');
    expect(sanitasiNamaBerkas('/')).toBe('dokumen');
  });
});
