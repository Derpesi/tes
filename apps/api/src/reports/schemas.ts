import { z } from 'zod';
import { tanggalValid } from '../common/tanggal';

const tanggal = (nama: string) =>
  z
    .string({ error: `${nama} wajib diisi` })
    .regex(/^\d{4}-\d{2}-\d{2}$/, `${nama}: format harus YYYY-MM-DD`)
    .refine((v) => tanggalValid(v), `${nama} bukan tanggal yang valid`);

export const NAMA_LAPORAN = ['workforce', 'recruitment', 'attendance', 'payroll'] as const;
export type NamaLaporan = (typeof NAMA_LAPORAN)[number];
export const NamaParam = z.enum(NAMA_LAPORAN, { error: 'Laporan tidak dikenal. Pilih workforce, recruitment, attendance, atau payroll' });

export const LaporanQuery = z
  .object({ from: tanggal('Dari tanggal'), to: tanggal('Sampai tanggal') })
  .refine((v) => v.to >= v.from, { message: 'Sampai tanggal tidak boleh sebelum dari tanggal', path: ['to'] })
  .refine((v) => (Date.parse(v.to) - Date.parse(v.from)) / 86400000 <= 365, { message: 'Rentang laporan maksimal 366 hari', path: ['to'] });
