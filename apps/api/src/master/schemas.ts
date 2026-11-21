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

// ---------------- Rekanan (master data internal; tanpa akun/login rekanan) ----------------
const tanggal = (nama: string) =>
  z
    .string({ error: `${nama} wajib diisi` })
    .regex(/^\d{4}-\d{2}-\d{2}$/, `${nama}: format harus YYYY-MM-DD`)
    .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v), `${nama} bukan tanggal yang valid`);
const lat = z.number({ error: 'Lintang harus angka' }).min(-90, 'Lintang harus antara -90 dan 90').max(90, 'Lintang harus antara -90 dan 90');
const lng = z.number({ error: 'Bujur harus angka' }).min(-180, 'Bujur harus antara -180 dan 180').max(180, 'Bujur harus antara -180 dan 180');
const radius = z.number({ error: 'Radius harus angka' }).int('Radius harus bilangan bulat').min(20, 'Radius minimal 20 meter').max(1000, 'Radius maksimal 1000 meter');
const jenisLayanan = z.array(z.string().trim().min(1).max(60, 'Jenis layanan terlalu panjang'), { error: 'Jenis layanan harus berupa daftar' }).max(20, 'Maksimal 20 jenis layanan');

export const DaftarRekananQuery = DaftarQuery.extend({
  companyId: z.string().uuid('ID perusahaan tidak valid').optional(),
  status: z.enum(['AKTIF', 'NONAKTIF'], { error: 'Status tidak valid' }).optional(),
});

export const RekananBuat = z.object({
  /** Wajib bila pengguna punya lebih dari satu perusahaan dalam scope; harus salah satu dari scope (divalidasi di server). */
  companyId: z.string().uuid('ID perusahaan tidak valid').optional(),
  name: teks('Nama rekanan', 150),
  legalName: opsi('Nama badan hukum', 200),
  address: opsi('Alamat', 300),
  city: opsi('Kota', 100),
  province: opsi('Provinsi', 100),
  serviceTypes: jenisLayanan.optional(),
  notes: opsi('Catatan', 1000),
});
export const RekananUbah = RekananBuat.omit({ companyId: true }).partial().strict().refine((v) => Object.keys(v).length > 0, 'Tidak ada perubahan yang dikirim');

export const KontakBuat = z.object({
  name: teks('Nama kontak', 100),
  roleTitle: opsi('Jabatan', 100),
  phone: telepon,
  email,
  isPrimary: z.boolean({ error: 'isPrimary harus true/false' }).optional(),
});
export const KontakUbah = KontakBuat.partial().strict().refine((v) => Object.keys(v).length > 0, 'Tidak ada perubahan yang dikirim');

const koordinatLengkap = (v: { latitude?: number | null; longitude?: number | null }) => (v.latitude === undefined) === (v.longitude === undefined) && (v.latitude === null) === (v.longitude === null);
const PESAN_KOORDINAT = 'Lintang dan bujur harus diisi bersamaan';
export const LokasiBuat = z
  .object({
    name: teks('Nama lokasi', 150),
    address: opsi('Alamat', 300),
    city: opsi('Kota', 100),
    province: opsi('Provinsi', 100),
    latitude: lat.optional(),
    longitude: lng.optional(),
    geofenceRadiusM: radius.optional(),
    notes: opsi('Catatan', 1000),
  })
  .refine(koordinatLengkap, PESAN_KOORDINAT);
export const LokasiUbah = z
  .object({
    name: teks('Nama lokasi', 150),
    address: opsi('Alamat', 300),
    city: opsi('Kota', 100),
    province: opsi('Provinsi', 100),
    latitude: lat.nullable(),
    longitude: lng.nullable(),
    geofenceRadiusM: radius,
    notes: opsi('Catatan', 1000),
  })
  .partial()
  .strict()
  .refine(koordinatLengkap, PESAN_KOORDINAT)
  .refine((v) => Object.keys(v).length > 0, 'Tidak ada perubahan yang dikirim');

export const KebutuhanBuat = z
  .object({
    position: teks('Posisi', 100),
    headcount: z.number({ error: 'Jumlah harus angka' }).int('Jumlah harus bilangan bulat').min(0, 'Jumlah tidak boleh negatif').max(100000, 'Jumlah terlalu besar'),
    validFrom: tanggal('Tanggal mulai'),
    validTo: tanggal('Tanggal selesai').optional(),
    notes: opsi('Catatan', 1000),
  })
  .refine((v) => !v.validTo || v.validTo >= v.validFrom, 'Tanggal selesai tidak boleh sebelum tanggal mulai');
