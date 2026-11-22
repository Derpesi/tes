/**
 * Kategori audit diturunkan dari AWALAN aksi dan ditegakkan di SQL (bukan hanya UI):
 * - TEKNIS: `auth.*` dan `system.*` (login, peran, scope, MFA, bootstrap).
 * - TRANSAKSI: `payroll.*` dan `report.*` (ekspor laporan konsolidasi).
 * - OPERASIONAL: selain itu (master data, member, rekrutmen, PKWT, penempatan, absensi). Aksi baru yang tak terpetakan jatuh ke OPERASIONAL,
 *   sehingga TIDAK terlihat oleh IT dan Keuangan (deny-by-default bagi peran terbatas).
 */
export type KategoriAudit = 'TEKNIS' | 'TRANSAKSI' | 'OPERASIONAL';
export const SEMUA_KATEGORI: readonly KategoriAudit[] = ['TEKNIS', 'TRANSAKSI', 'OPERASIONAL'];
export const AWALAN_TEKNIS = ['auth.', 'system.'] as const;
export const AWALAN_TRANSAKSI = ['payroll.', 'report.'] as const;
/** Awalan teratas yang dikenal; aksi baru wajib memakai salah satunya (dijaga tes penelusuran sumber). */
export const AWALAN_DIKENAL = ['attendance', 'auth', 'master', 'member', 'payroll', 'pkwt', 'placement', 'recruitment', 'report', 'system'] as const;

export function kategoriAksi(aksi: string): KategoriAudit {
  if (AWALAN_TEKNIS.some((p) => aksi.startsWith(p))) return 'TEKNIS';
  if (AWALAN_TRANSAKSI.some((p) => aksi.startsWith(p))) return 'TRANSAKSI';
  return 'OPERASIONAL';
}

export interface KebijakanAudit { kategori: ReadonlySet<KategoriAudit>; detail: boolean }
/** Kebijakan per peran (matriks rbac.md: Direktur V; Mgr Ops V*; IT V teknis tanpa PII; Keuangan V transaksi). Peran lain: tidak ada (gagal-aman). */
const PER_PERAN: Record<string, KebijakanAudit> = {
  DIREKTUR: { kategori: new Set(SEMUA_KATEGORI), detail: true },
  MANAGER_OPERASIONAL: { kategori: new Set<KategoriAudit>(['OPERASIONAL', 'TRANSAKSI']), detail: true },
  IT_ADMIN: { kategori: new Set<KategoriAudit>(['TEKNIS']), detail: false },
  STAFF_KEUANGAN: { kategori: new Set<KategoriAudit>(['TRANSAKSI']), detail: true },
};

/** Gabungan kebijakan seluruh peran pemanggil (union). Tanpa peran yang dikenal: kosong. */
export function kebijakanUntuk(roles: string[]): KebijakanAudit {
  const kategori = new Set<KategoriAudit>();
  let detail = false;
  for (const r of roles) {
    const k = PER_PERAN[r];
    if (!k) continue;
    k.kategori.forEach((x) => kategori.add(x));
    detail = detail || k.detail;
  }
  return { kategori, detail };
}

/** Kunci `detail` yang boleh ditampilkan (lapis kedua; detail seharusnya sudah tanpa PII). Kunci lain (mis. email, subjek, emailRef) dibuang. */
export const KUNCI_DETAIL_BOLEH = new Set([
  'akhir', 'alasan', 'alasanTolak', 'baru', 'bendera', 'bidang', 'dari', 'dariVersi', 'efek', 'format', 'jenis', 'jumlah', 'jumlahBaris', 'jumlahOrang', 'ke', 'kind', 'kode', 'lokasi', 'mode',
  'mulai', 'nomor', 'pekerja', 'pengecualian', 'pengganti', 'perangkat', 'putusan', 'role', 'sampai', 'sha256', 'status', 'tipe', 'ukuran', 'versi', 'via',
]);
const NILAI_SAH = (v: unknown): v is string | number | boolean | null => v === null || ['string', 'number', 'boolean'].includes(typeof v);

export function saringDetail(detail: unknown): Record<string, unknown> {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return {};
  const keluar: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(detail as Record<string, unknown>)) {
    if (!KUNCI_DETAIL_BOLEH.has(k)) continue;
    if (NILAI_SAH(v)) keluar[k] = typeof v === 'string' ? v.slice(0, 300) : v;
    else if (Array.isArray(v) && v.every(NILAI_SAH)) keluar[k] = v.slice(0, 50).map((x) => (typeof x === 'string' ? x.slice(0, 100) : x));
  }
  return keluar;
}
