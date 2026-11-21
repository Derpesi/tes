import { z } from 'zod';

const teks = (nama: string, max: number) => z.string({ error: `${nama} wajib diisi` }).trim().min(1, `${nama} wajib diisi`).max(max, `${nama} terlalu panjang (maksimal ${max} karakter)`);
const opsi = (nama: string, max: number) =>
  z
    .string()
    .trim()
    .max(max, `${nama} terlalu panjang (maksimal ${max} karakter)`)
    .transform((v) => (v === '' ? undefined : v))
    .optional();
const tanggal = (nama: string) =>
  z
    .string({ error: `${nama} harus berupa teks` })
    .regex(/^\d{4}-\d{2}-\d{2}$/, `${nama}: format harus YYYY-MM-DD`)
    .refine((v) => new Date(`${v}T00:00:00Z`).toISOString().startsWith(v), `${nama} bukan tanggal yang valid`);
const uuid = (nama: string) => z.string({ error: `${nama} wajib diisi` }).uuid(`${nama} tidak valid`);

export const IdParam = z.string({ error: 'ID wajib diisi' }).uuid('ID tidak valid');
const Halaman = z.object({ cursor: z.string().max(500).optional(), limit: z.coerce.number().int().min(1, 'limit minimal 1').max(100, 'limit maksimal 100').default(50) });

// ----- lowongan (staff) -----
export const STATUS_LOWONGAN = ['DRAFT', 'DIBUKA', 'DITUTUP'] as const;
export const DaftarLowonganQuery = Halaman.extend({ companyId: uuid('ID perusahaan').optional(), status: z.enum(STATUS_LOWONGAN, { error: 'Status tidak valid' }).optional() });
export const LowonganBuat = z.object({
  /** Wajib bila scope pengguna lebih dari satu perusahaan; harus salah satu dari scope (divalidasi server). */
  companyId: uuid('ID perusahaan').optional(),
  title: teks('Judul lowongan', 150),
  description: teks('Deskripsi lowongan', 5000),
  locationId: uuid('ID lokasi').optional(),
  positions: z.number({ error: 'Jumlah posisi harus angka' }).int('Jumlah posisi harus bilangan bulat').min(1, 'Jumlah posisi minimal 1').max(10000, 'Jumlah posisi terlalu besar').optional(),
  closesOn: tanggal('Batas pendaftaran').optional(),
  internalNotes: opsi('Catatan internal', 1000),
});
export const LowonganUbah = z
  .object({
    title: teks('Judul lowongan', 150),
    description: teks('Deskripsi lowongan', 5000),
    locationId: uuid('ID lokasi').nullable(),
    positions: z.number({ error: 'Jumlah posisi harus angka' }).int('Jumlah posisi harus bilangan bulat').min(1, 'Jumlah posisi minimal 1').max(10000, 'Jumlah posisi terlalu besar'),
    closesOn: tanggal('Batas pendaftaran').nullable(),
    internalNotes: z.string().trim().max(1000, 'Catatan internal terlalu panjang (maksimal 1000 karakter)').nullable(),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Tidak ada perubahan yang dikirim');

// ----- lamaran (staff) -----
export const STATUS_LAMARAN = ['DIAJUKAN', 'SELEKSI_ADMINISTRASI', 'INTERVIEW', 'DITERIMA', 'MENUNGGU_PKWT', 'DITOLAK', 'DITARIK'] as const;
export const DaftarLamaranQuery = Halaman.extend({ vacancyId: uuid('ID lowongan').optional(), status: z.enum(STATUS_LAMARAN, { error: 'Status tidak valid' }).optional() });
export const TahapBody = z.object({ status: z.enum(['SELEKSI_ADMINISTRASI', 'INTERVIEW'], { error: 'Tahap tidak valid' }), note: opsi('Catatan', 500) });
export const TerimaBody = z.object({ note: opsi('Catatan', 500) });
export const TolakBody = z.object({ reason: z.string({ error: 'Alasan wajib diisi' }).trim().min(3, 'Alasan wajib diisi (minimal 3 karakter)').max(500, 'Alasan terlalu panjang (maksimal 500 karakter)') });

// ----- sisi member -----
export const DaftarMemberLowonganQuery = Halaman;
export const MelamarBody = z.object({ vacancyId: uuid('ID lowongan') });
