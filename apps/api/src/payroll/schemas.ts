import { z } from 'zod';

const uuid = (nama: string) => z.string({ error: `${nama} wajib diisi` }).uuid(`${nama} tidak valid`);
const tanggal = (nama: string) =>
  z
    .string({ error: `${nama} wajib diisi` })
    .regex(/^\d{4}-\d{2}-\d{2}$/, `${nama}: format harus YYYY-MM-DD`)
    .refine((v) => new Date(`${v}T00:00:00Z`).toISOString().startsWith(v), `${nama} bukan tanggal yang valid`);
const alasan = (nama: string) => z.string({ error: `${nama} wajib diisi` }).trim().min(3, `${nama} wajib diisi (minimal 3 karakter)`).max(500, `${nama} terlalu panjang (maksimal 500 karakter)`);

export const IdParam = z.string({ error: 'ID wajib diisi' }).uuid('ID tidak valid');
export const JENIS_REKAP = ['PARTNER', 'INTERNAL'] as const;
const halaman = { cursor: z.string().max(500).optional(), limit: z.coerce.number().int().min(1, 'limit minimal 1').max(100, 'limit maksimal 100').default(50) };

export const DaftarPeriodeQuery = z.object({ ...halaman, kind: z.enum(JENIS_REKAP, { error: 'Jenis harus PARTNER atau INTERNAL' }).optional() });
export const PeriodeBuat = z
  .object({
    companyId: uuid('ID perusahaan').optional(),
    kind: z.enum(JENIS_REKAP, { error: 'Jenis harus PARTNER atau INTERNAL' }),
    label: z.string({ error: 'Label periode wajib diisi' }).trim().min(1, 'Label periode wajib diisi').max(100, 'Label periode terlalu panjang (maksimal 100 karakter)'),
    startDate: tanggal('Tanggal mulai'),
    endDate: tanggal('Tanggal akhir'),
  })
  .refine((v) => v.endDate >= v.startDate, { message: 'Tanggal akhir tidak boleh sebelum tanggal mulai', path: ['endDate'] })
  .refine((v) => (Date.parse(v.endDate) - Date.parse(v.startDate)) / 86400000 <= 92, { message: 'Rentang periode maksimal 93 hari', path: ['endDate'] });

export type AlasanBody = z.infer<typeof AlasanBody>;
export const AlasanBody = z.object({ reason: alasan('Alasan') });
