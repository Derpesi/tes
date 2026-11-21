/**
 * Resolusi shift dan tanggal-shift. Fungsi MURNI: jam disuntikkan (tidak membaca waktu sistem) sehingga diuji deterministik.
 * Zona waktu Asia/Jakarta (WIB, UTC+7, tanpa DST). Tanggal-shift = tanggal MULAI shift (shift malam yang berakhir lewat tengah malam
 * tetap milik tanggal mulai).
 */
export type JenisAbsen = 'MASUK' | 'PULANG';

export interface PolaShift {
  id: string;
  /** "HH:MM" */
  mulai: string;
  /** "HH:MM" */
  selesai: string;
  menyeberangTengahMalam: boolean;
  toleransiTerlambatMenit: number;
  toleransiAwalMenit: number;
  /** Jadwal fleksibel: jam target dalam jendela waktu; tanpa penanda terlambat/pulang cepat. */
  fleksibel: boolean;
}
export interface JadwalKerja {
  shift: PolaShift;
  /** ISO: 1 = Senin ... 7 = Minggu */
  hariKerja: number[];
  berlakuDari: string;
  berlakuSampai: string | null;
}
export interface HasilShift {
  tanggalShift: string;
  shift: PolaShift;
  /** TERLAMBAT (masuk lewat toleransi) atau PULANG_CEPAT (pulang sebelum selesai - toleransi). */
  bendera: string[];
}

const WIB_MENIT = 7 * 60;
const MENIT_HARI = 24 * 60;

/** Menit sejak epoch (UTC) untuk tanggal "YYYY-MM-DD" dan jam "HH:MM" pada zona WIB. */
export function epochMenitWib(tanggal: string, jam: string, tambahHari = 0): number {
  const [y, m, d] = tanggal.split('-').map(Number);
  const [hh, mm] = jam.split(':').map(Number);
  return Date.UTC(y, m - 1, d + tambahHari, hh, mm) / 60000 - WIB_MENIT;
}
/** Tanggal kalender WIB ("YYYY-MM-DD") dari sebuah instan, digeser `tambahHari`. */
export function tanggalWib(waktu: Date, tambahHari = 0): string {
  const t = new Date(waktu.getTime() + WIB_MENIT * 60000 + tambahHari * MENIT_HARI * 60000);
  return t.toISOString().slice(0, 10);
}
/** Hari dalam pekan ISO (1 = Senin ... 7 = Minggu) untuk tanggal kalender. */
export function hariIso(tanggal: string): number {
  const [y, m, d] = tanggal.split('-').map(Number);
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return w === 0 ? 7 : w;
}

interface Kandidat {
  tanggalShift: string;
  shift: PolaShift;
  mulaiAt: number;
  selesaiAt: number;
}

/**
 * Menentukan shift yang berlaku pada `waktu` untuk jenis absen tertentu, atau null (tanpa jadwal pada jendela itu).
 * Jendela MASUK: [mulai - toleransiAwal, selesai]. Jendela PULANG: [mulai, selesai + toleransiTerlambat].
 * `override` = toleransi per lokasi (menggantikan toleransi pola shift).
 */
export function tentukanShift(waktu: Date, jenis: JenisAbsen, jadwal: JadwalKerja[], override: { terlambat?: number | null; awal?: number | null } = {}): HasilShift | null {
  const nowMenit = Math.floor(waktu.getTime() / 60000);
  const kandidat: Kandidat[] = [];
  for (const tambah of [-1, 0, 1]) {
    const tgl = tanggalWib(waktu, tambah);
    const hari = hariIso(tgl);
    for (const j of jadwal) {
      if (!j.hariKerja.includes(hari)) continue;
      if (tgl < j.berlakuDari || (j.berlakuSampai && tgl > j.berlakuSampai)) continue;
      const mulaiAt = epochMenitWib(tgl, j.shift.mulai);
      const selesaiAt = epochMenitWib(tgl, j.shift.selesai, j.shift.menyeberangTengahMalam ? 1 : 0);
      const awal = override.awal ?? j.shift.toleransiAwalMenit;
      const terlambat = override.terlambat ?? j.shift.toleransiTerlambatMenit;
      const dari = jenis === 'MASUK' ? mulaiAt - awal : mulaiAt;
      const sampai = jenis === 'MASUK' ? selesaiAt : selesaiAt + terlambat;
      if (nowMenit >= dari && nowMenit <= sampai) kandidat.push({ tanggalShift: tgl, shift: j.shift, mulaiAt, selesaiAt });
    }
  }
  if (!kandidat.length) return null;
  // Pilih shift yang sudah dimulai paling akhir; bila belum ada yang dimulai, yang paling awal.
  const sudahMulai = kandidat.filter((k) => k.mulaiAt <= nowMenit).sort((a, b) => b.mulaiAt - a.mulaiAt);
  const pilih = sudahMulai[0] ?? kandidat.sort((a, b) => a.mulaiAt - b.mulaiAt)[0];
  const bendera: string[] = [];
  const awal = override.awal ?? pilih.shift.toleransiAwalMenit;
  const terlambat = override.terlambat ?? pilih.shift.toleransiTerlambatMenit;
  if (!pilih.shift.fleksibel) {
    if (jenis === 'MASUK' && nowMenit > pilih.mulaiAt + terlambat) bendera.push('TERLAMBAT');
    if (jenis === 'PULANG' && nowMenit < pilih.selesaiAt - awal) bendera.push('PULANG_CEPAT');
  }
  return { tanggalShift: pilih.tanggalShift, shift: pilih.shift, bendera };
}

export interface Libur { tanggal: string; cakupan: 'NASIONAL' | 'PERUSAHAAN' | 'LOKASI'; lokasiId: string | null; nama: string }
/** Hari libur yang berlaku pada tanggal-shift untuk lokasi tertentu (nasional, perusahaan, atau lokasi itu). */
export function liburBerlaku(tanggalShift: string, libur: Libur[], lokasiId: string): Libur | null {
  return libur.find((l) => l.tanggal === tanggalShift && (l.cakupan !== 'LOKASI' || l.lokasiId === lokasiId)) ?? null;
}
