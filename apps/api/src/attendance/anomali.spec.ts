import { AMBANG, MasukanAnomali, nilaiAnomali } from './anomali';

const T0 = new Date('2026-03-10T00:00:00Z');
const dasar = (o: Partial<MasukanAnomali> = {}): MasukanAnomali => ({
  sekarang: { lat: -6.2, lng: 106.8, akurasi: 20, waktu: T0 },
  sebelumnya: null,
  waktuKlien: T0,
  koordinatIdentikSebelumnya: 0,
  akunPerPerangkat: 1,
  perangkatBaru: false,
  ...o,
});
const kode = (m: MasukanAnomali) => nilaiAnomali(m).bendera.map((b) => b.kode);

describe('nilaiAnomali', () => {
  it('normal: tanpa bendera', () => expect(nilaiAnomali(dasar())).toEqual({ bendera: [], total: 0 }));
  it('GPS tidak tersedia dan akurasi buruk (batas tepat 100 m aman)', () => {
    expect(kode(dasar({ sekarang: { lat: null, lng: null, akurasi: null, waktu: T0 } }))).toEqual(['GPS_TIDAK_TERSEDIA']);
    expect(kode(dasar({ sekarang: { lat: -6.2, lng: 106.8, akurasi: AMBANG.akurasiMaksM, waktu: T0 } }))).toEqual([]);
    expect(kode(dasar({ sekarang: { lat: -6.2, lng: 106.8, akurasi: AMBANG.akurasiMaksM + 0.1, waktu: T0 } }))).toEqual(['AKURASI_BURUK']);
  });
  it('lompatan lokasi: >150 km/jam ditandai, perjalanan wajar tidak', () => {
    const jam = (j: number) => new Date(T0.getTime() - j * 3600000);
    expect(kode(dasar({ sebelumnya: { lat: -6.9, lng: 107.6, waktu: jam(0.5) } }))).toEqual(['LOMPATAN_LOKASI']); // ~116 km dalam 30 mnt
    expect(kode(dasar({ sebelumnya: { lat: -6.9, lng: 107.6, waktu: jam(4) } }))).toEqual([]); // ~29 km/jam
    expect(kode(dasar({ sebelumnya: { lat: -6.2, lng: 106.8, waktu: jam(0.001) } }))).toEqual([]); // titik sama
  });
  it('waktu klien menyimpang > 5 menit, koordinat identik berulang, banyak akun, perangkat baru', () => {
    expect(kode(dasar({ waktuKlien: new Date(T0.getTime() + 6 * 60000) }))).toEqual(['WAKTU_KLIEN_MENYIMPANG']);
    expect(kode(dasar({ waktuKlien: new Date(T0.getTime() - 5 * 60000) }))).toEqual([]);
    expect(kode(dasar({ koordinatIdentikSebelumnya: AMBANG.koordinatIdentikBerulang }))).toEqual(['KOORDINAT_IDENTIK_BERULANG']);
    expect(kode(dasar({ koordinatIdentikSebelumnya: AMBANG.koordinatIdentikBerulang - 1 }))).toEqual([]);
    expect(kode(dasar({ akunPerPerangkat: AMBANG.akunPerPerangkatMaks + 1 }))).toEqual(['BANYAK_AKUN_SATU_PERANGKAT']);
    expect(kode(dasar({ akunPerPerangkat: AMBANG.akunPerPerangkatMaks }))).toEqual([]);
    expect(kode(dasar({ perangkatBaru: true }))).toEqual(['PERANGKAT_BARU']);
  });
  it('skor dijumlahkan; tanpa waktu klien tidak ditandai', () => {
    const r = nilaiAnomali(dasar({ perangkatBaru: true, akunPerPerangkat: 9, waktuKlien: null }));
    expect(r.total).toBe(90);
    expect(r.bendera.map((b) => b.kode)).toEqual(['BANYAK_AKUN_SATU_PERANGKAT', 'PERANGKAT_BARU']);
  });
});
