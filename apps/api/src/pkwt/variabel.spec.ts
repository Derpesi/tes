import { ekstrakVariabel, isiTemplate, variabelTidakDikenal, VARIABEL_TEMPLATE } from './variabel';

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
});
