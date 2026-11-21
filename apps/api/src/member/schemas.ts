import { z } from 'zod';

const teks = (nama: string, max: number) =>
  z
    .string({ error: `${nama} harus berupa teks` })
    .trim()
    .max(max, `${nama} terlalu panjang (maksimal ${max} karakter)`)
    .transform((v) => (v === '' ? undefined : v))
    .optional();
const telepon = (nama: string) =>
  z
    .string({ error: `${nama} harus berupa teks` })
    .trim()
    .regex(/^[0-9+() -]{6,25}$/, `${nama} tidak valid`)
    .optional();

export const PENDIDIKAN = ['SD', 'SMP', 'SMA/SMK', 'D1-D3', 'D4/S1', 'S2', 'S3'] as const;

/** Biodata minimal (asumsi A-27). Semua bidang opsional agar draf dapat disimpan bertahap; kelengkapan diperiksa saat diajukan. */
export const BiodataSimpan = z
  .object({
    fullName: teks('Nama lengkap', 150),
    nik: z
      .string({ error: 'NIK harus berupa teks' })
      .trim()
      .regex(/^[0-9]{16}$/, 'NIK harus 16 digit angka')
      .optional(),
    birthPlace: teks('Tempat lahir', 100),
    birthDate: z
      .string({ error: 'Tanggal lahir harus berupa teks' })
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Tanggal lahir: format harus YYYY-MM-DD')
      .refine((v) => new Date(`${v}T00:00:00Z`).toISOString().startsWith(v), 'Tanggal lahir bukan tanggal yang valid')
      .refine((v) => v >= '1900-01-01' && v <= new Date().toISOString().slice(0, 10), 'Tanggal lahir di luar rentang yang wajar')
      .optional(),
    gender: z.enum(['L', 'P'], { error: 'Jenis kelamin harus L atau P' }).optional(),
    address: teks('Alamat', 300),
    city: teks('Kota', 100),
    province: teks('Provinsi', 100),
    phone: telepon('Nomor telepon'),
    education: z.enum(PENDIDIKAN, { error: 'Pendidikan terakhir tidak valid' }).optional(),
    emergencyContactName: teks('Nama kontak darurat', 100),
    emergencyContactPhone: telepon('Telepon kontak darurat'),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'Tidak ada perubahan yang dikirim');

export const JENIS_DOKUMEN_MEMBER = ['KTP', 'FOTO_DIRI', 'IJAZAH', 'LAINNYA'] as const;
export const DokumenMemberBody = z.object({ kind: z.enum(JENIS_DOKUMEN_MEMBER, { error: 'Jenis dokumen tidak valid' }) });
export const IdParam = z.string({ error: 'ID wajib diisi' }).uuid('ID tidak valid');
