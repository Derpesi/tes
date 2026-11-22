import { z } from 'zod';
import { tanggalValid } from '../common/tanggal';

const uuid = (nama: string) => z.string({ error: `${nama} wajib diisi` }).uuid(`${nama} tidak valid`);
const tanggal = (nama: string) =>
  z
    .string({ error: `${nama} wajib diisi` })
    .regex(/^\d{4}-\d{2}-\d{2}$/, `${nama}: format harus YYYY-MM-DD`)
    .refine((v) => tanggalValid(v), `${nama} bukan tanggal yang valid`);
const alasan = (nama: string) => z.string({ error: `${nama} wajib diisi` }).trim().min(3, `${nama} wajib diisi (minimal 3 karakter)`).max(500, `${nama} terlalu panjang (maksimal 500 karakter)`);

export const IdParam = z.string({ error: 'ID wajib diisi' }).uuid('ID tidak valid');
export const STATUS_PENEMPATAN = ['DIRENCANAKAN', 'MENUNGGU_KONTRAK', 'AKTIF', 'DITANGGUHKAN', 'DIPINDAHKAN', 'SELESAI', 'DIBATALKAN'] as const;
export const DaftarPenempatanQuery = z.object({
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1, 'limit minimal 1').max(100, 'limit maksimal 100').default(50),
  status: z.enum(STATUS_PENEMPATAN, { error: 'Status tidak valid' }).optional(),
  contractId: uuid('ID kontrak').optional(),
  locationId: uuid('ID lokasi').optional(),
});
export const PenempatanBuat = z
  .object({
    contractId: uuid('ID kontrak'),
    locationId: uuid('ID lokasi'),
    startDate: tanggal('Tanggal mulai'),
    /** Bawaan: tanggal akhir kontrak. */
    endDate: tanggal('Tanggal selesai').optional(),
    note: z.string().trim().max(500, 'Catatan terlalu panjang (maksimal 500 karakter)').optional(),
  })
  .refine((v) => !v.endDate || v.endDate >= v.startDate, 'Tanggal selesai tidak boleh sebelum tanggal mulai');
export const AlasanBody = z.object({ reason: alasan('Alasan') });
export const PindahBody = z.object({ locationId: uuid('ID lokasi baru'), moveDate: tanggal('Tanggal pindah'), reason: alasan('Alasan') });

export const DaftarKaryawanQuery = z.object({
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1, 'limit minimal 1').max(100, 'limit maksimal 100').default(50),
  locationId: uuid('ID lokasi').optional(),
  akanBerakhir: z.enum(['true', 'false'], { error: 'akanBerakhir harus true atau false' }).transform((v) => v === 'true').optional(),
});
