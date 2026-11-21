import { z } from 'zod';

const teks = (nama: string, max: number) => z.string({ error: `${nama} wajib diisi` }).trim().min(1, `${nama} wajib diisi`).max(max, `${nama} terlalu panjang (maksimal ${max} karakter)`);
const opsi = (nama: string, max: number) =>
  z
    .string()
    .trim()
    .max(max, `${nama} terlalu panjang (maksimal ${max} karakter)`)
    .transform((v) => (v === '' ? undefined : v))
    .optional();

export const IdParam = z.string({ error: 'ID wajib diisi' }).uuid('ID tidak valid');

const telepon = z.string().trim().regex(/^[0-9+() -]{6,25}$/, 'Nomor telepon tidak valid').optional();
const email = z.string().trim().toLowerCase().max(254, 'Email terlalu panjang').email('Format email tidak valid').optional();
const npwp = z
  .string()
  .transform((v) => v.replace(/[^0-9]/g, ''))
  .refine((v) => /^[0-9]{15,16}$/.test(v), 'NPWP harus 15 atau 16 digit')
  .optional();
const kodeSingkat = z.string({ error: 'Kode singkat wajib diisi' }).trim().toUpperCase().regex(/^[A-Z0-9]{2,12}$/, 'Kode singkat harus 2–12 huruf besar atau angka');

/** Pengaturan payroll dan dokumen divalidasi ketat (tanpa JSON bebas). Bentuk final menunggu kebijakan pemilik (A-24). */
export const PengaturanPayroll = z.object({ periodType: z.enum(['BULANAN', 'MINGGUAN'], { error: 'Jenis periode tidak valid' }).optional(), cutOffDay: z.number({ error: 'Tanggal cut-off harus angka' }).int().min(1, 'Tanggal cut-off 1–28').max(28, 'Tanggal cut-off 1–28').optional() }).strict();
export const PengaturanDokumen = z.object({ contractNumberPrefix: z.string().regex(/^[A-Z0-9/.-]{1,20}$/, 'Prefiks nomor kontrak tidak valid').optional() }).strict();

export const PerusahaanBuat = z.object({
  name: teks('Nama perusahaan', 150),
  shortCode: kodeSingkat,
  legalName: opsi('Nama badan hukum', 200),
  npwp,
  address: opsi('Alamat', 300),
  city: opsi('Kota', 100),
  province: opsi('Provinsi', 100),
  phone: telepon,
  email,
});

export const PerusahaanUbah = z
  .object({
    name: teks('Nama perusahaan', 150),
    shortCode: kodeSingkat,
    legalName: opsi('Nama badan hukum', 200),
    npwp,
    address: opsi('Alamat', 300),
    city: opsi('Kota', 100),
    province: opsi('Provinsi', 100),
    phone: telepon,
    email,
    payrollSettings: PengaturanPayroll,
    documentSettings: PengaturanDokumen,
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Tidak ada perubahan yang dikirim');

export const DaftarQuery = z.object({
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1, 'limit minimal 1').max(100, 'limit maksimal 100').default(50),
});

export const JENIS_DOKUMEN_PERUSAHAAN = ['AKTA_PENDIRIAN', 'NIB', 'NPWP', 'SIUP', 'IZIN_ALIH_DAYA', 'LAINNYA'] as const;
export const DokumenPerusahaanBody = z.object({
  kind: z.enum(JENIS_DOKUMEN_PERUSAHAAN, { error: 'Jenis dokumen tidak valid' }),
  title: teks('Judul dokumen', 150),
  validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Format tanggal harus YYYY-MM-DD').optional(),
});
