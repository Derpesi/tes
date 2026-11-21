export const LABEL_STATUS_ABSEN: Record<string, string> = { VALID: 'Valid', PERLU_VERIFIKASI: 'Perlu verifikasi', DITOLAK: 'Ditolak', DISETUJUI: 'Disetujui' };
export const LABEL_JENIS_ABSEN: Record<string, string> = { MASUK: 'Masuk', PULANG: 'Pulang' };
export const LABEL_FLAG: Record<string, string> = {
  TERLAMBAT: 'Terlambat',
  PULANG_CEPAT: 'Pulang lebih awal',
  GPS_TIDAK_TERSEDIA: 'GPS tidak tersedia',
  AKURASI_BURUK: 'Akurasi GPS rendah',
  LOMPATAN_LOKASI: 'Lompatan lokasi',
  KOORDINAT_IDENTIK_BERULANG: 'Koordinat identik berulang',
  WAKTU_KLIEN_MENYIMPANG: 'Jam perangkat menyimpang',
  BANYAK_AKUN_SATU_PERANGKAT: 'Banyak akun satu perangkat',
  PERANGKAT_BARU: 'Perangkat baru',
  TANPA_JADWAL: 'Tanpa jadwal',
  HARI_LIBUR: 'Hari libur',
  PULANG_TANPA_MASUK: 'Pulang tanpa masuk',
};
export const LABEL_STATUS_HARI: Record<string, string> = { HADIR: 'Hadir', TIDAK_HADIR: 'Tidak hadir', IZIN: 'Izin', SAKIT: 'Sakit', MENUNGGU_VERIFIKASI: 'Menunggu verifikasi' };
export const LABEL_TAHAP: Record<string, string> = { MENUNGGU_PERIKSA: 'Menunggu pemeriksaan', MENUNGGU_PUTUSAN: 'Menunggu putusan', SELESAI: 'Selesai' };
export const NAMA_HARI = ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'];

/** Waktu dari API (ISO) -> "20 November 2026 07.02 WIB" (zona waktu Asia/Jakarta ditampilkan jelas). */
export function formatWaktuWib(iso: string): string {
  const d = new Date(iso);
  const tgl = new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Jakarta' }).format(d);
  const jam = new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Jakarta' }).format(d);
  return `${tgl} ${jam} WIB`;
}
