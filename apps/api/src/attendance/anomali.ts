import { jarakMeter } from './geo';

/** Ambang deteksi anomali (asumsi A-34…; konstanta berdokumen, bukan data regulasi). */
export const AMBANG = {
  akurasiMaksM: 100,
  selisihWaktuKlienMenit: 5,
  kecepatanMaksKmJam: 150,
  koordinatIdentikBerulang: 5,
  akunPerPerangkatMaks: 3,
} as const;

export interface MasukanAnomali {
  sekarang: { lat: number | null; lng: number | null; akurasi: number | null; waktu: Date };
  /** Rekaman sebelumnya orang yang sama (bukan DITOLAK). */
  sebelumnya?: { lat: number; lng: number; waktu: Date } | null;
  waktuKlien?: Date | null;
  /** Berapa rekaman sebelumnya orang ini yang berkoordinat PERSIS sama. */
  koordinatIdentikSebelumnya: number;
  /** Jumlah akun berbeda yang memakai perangkat ini (termasuk akun ini). */
  akunPerPerangkat: number;
  perangkatBaru: boolean;
}
export interface BenderaAnomali { kode: string; skor: number }

/** Mengembalikan bendera anomali berskor. Daftar kosong = tidak ada yang mencurigakan. */
export function nilaiAnomali(m: MasukanAnomali): { bendera: BenderaAnomali[]; total: number } {
  const b: BenderaAnomali[] = [];
  const { lat, lng, akurasi, waktu } = m.sekarang;
  if (lat === null || lng === null) b.push({ kode: 'GPS_TIDAK_TERSEDIA', skor: 40 });
  else {
    if (akurasi !== null && akurasi > AMBANG.akurasiMaksM) b.push({ kode: 'AKURASI_BURUK', skor: 30 });
    if (m.sebelumnya) {
      const jam = Math.max((waktu.getTime() - m.sebelumnya.waktu.getTime()) / 3600000, 1 / 3600); // minimal 1 detik
      const kmJam = jarakMeter(m.sebelumnya.lat, m.sebelumnya.lng, lat, lng) / 1000 / jam;
      if (kmJam > AMBANG.kecepatanMaksKmJam) b.push({ kode: 'LOMPATAN_LOKASI', skor: 60 });
    }
    if (m.koordinatIdentikSebelumnya >= AMBANG.koordinatIdentikBerulang) b.push({ kode: 'KOORDINAT_IDENTIK_BERULANG', skor: 30 });
  }
  if (m.waktuKlien && Math.abs(m.waktuKlien.getTime() - waktu.getTime()) > AMBANG.selisihWaktuKlienMenit * 60000) b.push({ kode: 'WAKTU_KLIEN_MENYIMPANG', skor: 30 });
  if (m.akunPerPerangkat > AMBANG.akunPerPerangkatMaks) b.push({ kode: 'BANYAK_AKUN_SATU_PERANGKAT', skor: 40 });
  if (m.perangkatBaru) b.push({ kode: 'PERANGKAT_BARU', skor: 50 });
  return { bendera: b, total: b.reduce((s, x) => s + x.skor, 0) };
}
