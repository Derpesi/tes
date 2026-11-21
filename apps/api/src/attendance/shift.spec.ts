import { epochMenitWib, hariIso, JadwalKerja, liburBerlaku, PolaShift, tanggalWib, tentukanShift } from './shift';

const pola = (o: Partial<PolaShift> & { id: string; mulai: string; selesai: string }): PolaShift => ({ menyeberangTengahMalam: false, toleransiTerlambatMenit: 15, toleransiAwalMenit: 30, fleksibel: false, ...o });
const SEMUA = [1, 2, 3, 4, 5, 6, 7];
const jadwal = (shift: PolaShift, hari = SEMUA, dari = '2026-01-01', sampai: string | null = null): JadwalKerja => ({ shift, hariKerja: hari, berlakuDari: dari, berlakuSampai: sampai });
/** Instan dari waktu WIB "YYYY-MM-DD HH:MM". */
const wib = (s: string) => new Date(`${s.replace(' ', 'T')}:00+07:00`);

const PAGI = pola({ id: 'pagi', mulai: '07:00', selesai: '15:00' });
const SIANG = pola({ id: 'siang', mulai: '15:00', selesai: '23:00' });
const MALAM = pola({ id: 'malam', mulai: '22:00', selesai: '06:00', menyeberangTengahMalam: true });

describe('utilitas tanggal WIB', () => {
  it('tanggal WIB berbeda dari UTC setelah 17:00 UTC', () => {
    expect(tanggalWib(new Date('2026-03-10T17:30:00Z'))).toBe('2026-03-11');
    expect(tanggalWib(new Date('2026-03-10T16:59:00Z'))).toBe('2026-03-10');
    expect(tanggalWib(new Date('2026-03-10T10:00:00Z'), -1)).toBe('2026-03-09');
  });
  it('hari ISO dan epoch WIB', () => {
    expect(hariIso('2026-03-09')).toBe(1); // Senin
    expect(hariIso('2026-03-15')).toBe(7); // Minggu
    expect(epochMenitWib('2026-03-10', '00:00') * 60000).toBe(Date.parse('2026-03-09T17:00:00Z'));
  });
});

describe('tentukanShift', () => {
  it('shift pagi: masuk tepat waktu, terlambat, dan terlalu awal', () => {
    const j = [jadwal(PAGI)];
    expect(tentukanShift(wib('2026-03-10 06:45'), 'MASUK', j)).toMatchObject({ tanggalShift: '2026-03-10', bendera: [] }); // dalam toleransi awal 30 mnt
    expect(tentukanShift(wib('2026-03-10 07:15'), 'MASUK', j)!.bendera).toEqual([]); // tepat di batas toleransi terlambat
    expect(tentukanShift(wib('2026-03-10 07:16'), 'MASUK', j)!.bendera).toEqual(['TERLAMBAT']);
    expect(tentukanShift(wib('2026-03-10 06:29'), 'MASUK', j)).toBeNull(); // lebih awal dari jendela
    expect(tentukanShift(wib('2026-03-10 15:01'), 'MASUK', j)).toBeNull(); // setelah shift selesai
  });

  it('pulang: normal, pulang cepat, dan jendela pulang setelah selesai', () => {
    const j = [jadwal(PAGI)];
    expect(tentukanShift(wib('2026-03-10 15:00'), 'PULANG', j)!.bendera).toEqual([]);
    expect(tentukanShift(wib('2026-03-10 14:29'), 'PULANG', j)!.bendera).toEqual(['PULANG_CEPAT']);
    expect(tentukanShift(wib('2026-03-10 15:10'), 'PULANG', j)).toMatchObject({ tanggalShift: '2026-03-10' });
    expect(tentukanShift(wib('2026-03-10 15:16'), 'PULANG', j)).toBeNull();
  });

  it('SHIFT LINTAS TENGAH MALAM: tanggal-shift = tanggal mulai (masuk 22:00 hari D, pulang 06:00 hari D+1 tetap milik D)', () => {
    const j = [jadwal(MALAM)];
    expect(tentukanShift(wib('2026-03-10 21:45'), 'MASUK', j)).toMatchObject({ tanggalShift: '2026-03-10', bendera: [] });
    expect(tentukanShift(wib('2026-03-10 23:59'), 'MASUK', j)).toMatchObject({ tanggalShift: '2026-03-10', bendera: ['TERLAMBAT'] });
    expect(tentukanShift(wib('2026-03-11 00:30'), 'MASUK', j)).toMatchObject({ tanggalShift: '2026-03-10' }); // masuk sangat terlambat setelah tengah malam
    expect(tentukanShift(wib('2026-03-11 05:59'), 'PULANG', j)).toMatchObject({ tanggalShift: '2026-03-10', bendera: [] });
    expect(tentukanShift(wib('2026-03-11 06:00'), 'PULANG', j)).toMatchObject({ tanggalShift: '2026-03-10', bendera: [] });
    expect(tentukanShift(wib('2026-03-11 06:10'), 'PULANG', j)).toMatchObject({ tanggalShift: '2026-03-10' });
    expect(tentukanShift(wib('2026-03-11 02:00'), 'PULANG', j)!.bendera).toEqual(['PULANG_CEPAT']);
    expect(tentukanShift(wib('2026-03-11 07:00'), 'PULANG', j)).toBeNull();
  });

  it('shift malam hari Jumat: pulang Sabtu pagi tetap milik Jumat meski Sabtu bukan hari kerja', () => {
    const j = [jadwal(MALAM, [5])]; // hanya Jumat
    expect(tentukanShift(wib('2026-03-13 22:05'), 'MASUK', j)).toMatchObject({ tanggalShift: '2026-03-13' }); // Jumat
    expect(tentukanShift(wib('2026-03-14 05:50'), 'PULANG', j)).toMatchObject({ tanggalShift: '2026-03-13' });
    expect(tentukanShift(wib('2026-03-14 22:05'), 'MASUK', j)).toBeNull(); // Sabtu malam: tidak dijadwalkan
  });

  it('masuk sebelum tengah malam untuk shift yang mulai 00:30 esok hari milik tanggal esok', () => {
    const dini = pola({ id: 'dini', mulai: '00:30', selesai: '08:30', toleransiAwalMenit: 60 });
    expect(tentukanShift(wib('2026-03-10 23:45'), 'MASUK', [jadwal(dini)])).toMatchObject({ tanggalShift: '2026-03-11' });
  });

  it('dua shift berurutan: dipilih yang sudah dimulai paling akhir', () => {
    const j = [jadwal(PAGI), jadwal(SIANG)];
    expect(tentukanShift(wib('2026-03-10 14:50'), 'MASUK', j)).toMatchObject({ shift: { id: 'pagi' } }); // pagi berjalan; siang belum dimulai
    expect(tentukanShift(wib('2026-03-10 15:05'), 'MASUK', j)).toMatchObject({ shift: { id: 'siang' }, bendera: [] });
    expect(tentukanShift(wib('2026-03-10 14:20'), 'PULANG', j)!.bendera).toEqual(['PULANG_CEPAT']);
  });

  it('hari kerja dan masa berlaku jadwal dihormati', () => {
    const j = [jadwal(PAGI, [1, 2, 3, 4, 5], '2026-03-10', '2026-03-12')];
    expect(tentukanShift(wib('2026-03-09 07:00'), 'MASUK', j)).toBeNull(); // sebelum berlaku
    expect(tentukanShift(wib('2026-03-10 07:00'), 'MASUK', j)).not.toBeNull();
    expect(tentukanShift(wib('2026-03-12 07:00'), 'MASUK', j)).not.toBeNull();
    expect(tentukanShift(wib('2026-03-13 07:00'), 'MASUK', j)).toBeNull(); // setelah berakhir
    expect(tentukanShift(wib('2026-03-14 07:00'), 'MASUK', [jadwal(PAGI, [1, 2, 3, 4, 5])])).toBeNull(); // Sabtu
  });

  it('override toleransi per lokasi menggantikan toleransi pola', () => {
    const j = [jadwal(PAGI)];
    expect(tentukanShift(wib('2026-03-10 07:40'), 'MASUK', j, { terlambat: 60 })!.bendera).toEqual([]);
    expect(tentukanShift(wib('2026-03-10 06:20'), 'MASUK', j, { awal: 60 })).not.toBeNull();
    expect(tentukanShift(wib('2026-03-10 07:40'), 'MASUK', j, {})!.bendera).toEqual(['TERLAMBAT']);
  });

  it('jadwal fleksibel: tanpa penanda terlambat/pulang cepat', () => {
    const f = pola({ id: 'fleks', mulai: '06:00', selesai: '20:00', fleksibel: true });
    expect(tentukanShift(wib('2026-03-10 12:00'), 'MASUK', [jadwal(f)])!.bendera).toEqual([]);
    expect(tentukanShift(wib('2026-03-10 12:00'), 'PULANG', [jadwal(f)])!.bendera).toEqual([]);
  });

  it('tanpa jadwal sama sekali -> null', () => expect(tentukanShift(wib('2026-03-10 07:00'), 'MASUK', [])).toBeNull());
});

describe('liburBerlaku', () => {
  const libur = [
    { tanggal: '2026-03-20', cakupan: 'NASIONAL' as const, lokasiId: null, nama: 'Libur Nasional' },
    { tanggal: '2026-03-21', cakupan: 'LOKASI' as const, lokasiId: 'L1', nama: 'Libur Lokasi 1' },
  ];
  it('nasional berlaku untuk semua lokasi; libur lokasi hanya untuk lokasinya', () => {
    expect(liburBerlaku('2026-03-20', libur, 'L9')?.nama).toBe('Libur Nasional');
    expect(liburBerlaku('2026-03-21', libur, 'L1')?.nama).toBe('Libur Lokasi 1');
    expect(liburBerlaku('2026-03-21', libur, 'L2')).toBeNull();
    expect(liburBerlaku('2026-03-22', libur, 'L1')).toBeNull();
  });
});
