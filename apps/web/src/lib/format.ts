/** Format Rupiah: Rp 1.234.567 */
export function formatRupiah(nilai: number): string {
  return 'Rp ' + new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 }).format(nilai);
}

/** Format tanggal: 20 November 2026 (zona waktu Asia/Jakarta). */
export function formatTanggal(tanggal: Date): string {
  return new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Jakarta' }).format(tanggal);
}
