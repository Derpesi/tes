/** Format Rupiah: Rp 1.234.567 */
export function formatRupiah(nilai: number): string {
  return 'Rp ' + new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 }).format(nilai);
}

/** Format tanggal: 20 November 2026 (zona waktu Asia/Jakarta). */
export function formatTanggal(tanggal: Date): string {
  return new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Jakarta' }).format(tanggal);
}

/** Tanggal ISO dari API (YYYY-MM-DD) -> "20 November 2026". Tanggal kalender tidak bergeser zona waktu. */
export function formatTanggalIso(iso: string): string {
  const [t, b, h] = iso.split('-').map(Number);
  return new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(t, b - 1, h)));
}
