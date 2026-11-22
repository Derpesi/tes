import { ekstrakVariabel, isiTemplate, isiTemplateLengkap, TITIK_ISIAN, variabelTidakDikenal, VARIABEL_ISIAN_TANGAN, VARIABEL_TEMPLATE, VARIABEL_WAJIB } from './variabel';

describe('variabel template PKWT', () => {
  it('mengekstrak variabel unik dengan spasi opsional', () => {
    expect(ekstrakVariabel('Halo {{nama}}, {{ nomor }} dan {{nama}}')).toEqual(['nama', 'nomor']);
    expect(ekstrakVariabel('tanpa variabel')).toEqual([]);
  });
  it('menolak variabel di luar daftar putih', () => {
    expect(variabelTidakDikenal('{{nama}} {{gaji_pokok}} {{password}}')).toEqual(['gaji_pokok', 'password']);
    expect(variabelTidakDikenal(VARIABEL_TEMPLATE.map((v) => `{{${v}}}`).join(' '))).toEqual([]);
  });
  it('mengisi variabel; variabel tanpa nilai melempar galat (tidak dibiarkan kosong)', () => {
    expect(isiTemplate('A {{nama}} B {{ jabatan }}', { nama: 'X', jabatan: 'Y' })).toBe('A X B Y');
    expect(() => isiTemplate('{{nama}} {{nik}}', { nama: 'X' })).toThrow(/nik/);
  });
  it('nilai yang berisi pola variabel tidak diperluas ulang (tanpa injeksi templat)', () => {
    expect(isiTemplate('{{nama}}', { nama: '{{nik}}' })).toBe('{{nik}}');
  });
  it('variabel inti tetap WAJIB; variabel isian-tangan tanpa nilai menjadi titik-titik dan dilaporkan (nama saja)', () => {
    const h = isiTemplateLengkap('{{nama}} di {{pengguna_jasa}}; legalitas: {{perusahaan_legalitas}}; {{pengguna_jasa}}', { nama: 'X' });
    expect(h.teks).toBe(`X di ${TITIK_ISIAN}; legalitas: ${TITIK_ISIAN}; ${TITIK_ISIAN}`);
    expect(h.isianTangan).toEqual(['pengguna_jasa', 'perusahaan_legalitas']);
    expect(() => isiTemplateLengkap('{{nama}} {{nomor}}', { nama: 'X' })).toThrow(/nomor/);
    expect(isiTemplateLengkap('{{pengguna_jasa}}', { pengguna_jasa: '   ' }).isianTangan).toEqual(['pengguna_jasa']); // spasi saja dianggap kosong
  });
  it('daftar wajib dan isian-tangan tidak tumpang tindih dan gabungannya = daftar putih', () => {
    expect(VARIABEL_WAJIB.filter((v) => (VARIABEL_ISIAN_TANGAN as readonly string[]).includes(v))).toEqual([]);
    expect([...VARIABEL_WAJIB, ...VARIABEL_ISIAN_TANGAN]).toEqual([...VARIABEL_TEMPLATE]);
  });
});
