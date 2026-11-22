import { RENTANG_REKAP_MAKS_HARI, RENTANG_REKAP_TANPA_FILTER_HARI, RekapEksporQuery, RekapQuery } from './schemas';

const LOK = '11111111-1111-4111-8111-111111111111';
const ORANG = '22222222-2222-4222-8222-222222222222';
const tambahHari = (dari: string, n: number) => new Date(Date.parse(dari) + n * 86400000).toISOString().slice(0, 10);
const D = '2026-03-01';

describe('aturan rentang rekap absensi (A-62)', () => {
  it('konstanta: 7 hari tanpa filter, 93 hari dengan filter', () => {
    expect(RENTANG_REKAP_TANPA_FILTER_HARI).toBe(7);
    expect(RENTANG_REKAP_MAKS_HARI).toBe(93);
  });
  for (const [nama, skema] of [['daftar', RekapQuery], ['ekspor', RekapEksporQuery]] as const) {
    describe(nama, () => {
      it('tanpa filter: tepat 7 hari (inklusif) diterima, 8 hari ditolak dengan pesan yang menyuruh memilih lokasi/pekerja', () => {
        expect(skema.safeParse({ from: D, to: tambahHari(D, 6) }).success).toBe(true);
        const r = skema.safeParse({ from: D, to: tambahHari(D, 7) });
        expect(r.success).toBe(false);
        expect(JSON.stringify(r.error?.issues)).toMatch(/maksimal 7 hari.*Pilih lokasi atau pekerja/);
      });
      it('dengan locationId atau personId: sampai 93 hari diterima, 94 hari ditolak', () => {
        for (const f of [{ locationId: LOK }, { personId: ORANG }]) {
          expect(skema.safeParse({ from: D, to: tambahHari(D, 92), ...f }).success).toBe(true);
          const r = skema.safeParse({ from: D, to: tambahHari(D, 93), ...f });
          expect(r.success).toBe(false);
          expect(JSON.stringify(r.error?.issues)).toMatch(/maksimal 93 hari/);
        }
      });
      it('urutan tanggal dan tanggal rusak tetap ditolak (400), bukan galat internal', () => {
        expect(skema.safeParse({ from: tambahHari(D, 1), to: D, locationId: LOK }).success).toBe(false);
        expect(skema.safeParse({ from: '2026-02-30', to: D, locationId: LOK }).success).toBe(false);
      });
    });
  }
});
