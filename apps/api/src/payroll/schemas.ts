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

// ----- komponen dan masukan (nominal selalu TEKS desimal; angka JS/float ditolak) -----
const UANG_PESAN = 'Nominal harus berupa angka desimal, maksimal 12 digit dan 2 angka di belakang koma (contoh 1500000.50)';
const nominal = z.string({ error: UANG_PESAN }).regex(/^\d{1,12}(\.\d{1,2})?$/, UANG_PESAN);
const jam = (nama: string) => z.string({ error: `${nama} harus berupa teks desimal` }).regex(/^\d{1,4}(\.\d{1,2})?$/, `${nama}: gunakan angka desimal, maksimal 4 digit dan 2 angka di belakang koma`);
const hari = (nama: string) => z.number({ error: `${nama} harus berupa angka` }).int(`${nama} harus bilangan bulat`).min(0, `${nama} minimal 0`).max(93, `${nama} maksimal 93`);
const hitung = (nama: string) => z.number({ error: `${nama} harus berupa angka` }).int(`${nama} harus bilangan bulat`).min(0, `${nama} minimal 0`).max(100000, `${nama} terlalu besar`);

export const KomponenBody = z.object({
  kind: z.enum(['TUNJANGAN', 'POTONGAN', 'INSENTIF'], { error: 'Jenis komponen harus TUNJANGAN, POTONGAN, atau INSENTIF' }),
  name: z.string({ error: 'Nama komponen wajib diisi' }).trim().min(1, 'Nama komponen wajib diisi').max(80, 'Nama komponen terlalu panjang (maksimal 80 karakter)'),
  amount: nominal,
});
export const KomponenUbah = KomponenBody.partial().strict().refine((v) => Object.keys(v).length > 0, 'Tidak ada perubahan');

export const GarisUbah = z
  .object({
    daysLeave: hari('Hari cuti'),
    overtimeHours: jam('Jam lembur'),
    note: z.string().trim().max(300, 'Catatan terlalu panjang (maksimal 300 karakter)').nullable(),
    // Hanya baris MANUAL (rekap internal):
    daysPresent: hari('Hari hadir'), daysAbsent: hari('Hari tidak hadir'), daysPermit: hari('Hari izin'), daysSick: hari('Hari sakit'),
    lateCount: hitung('Jumlah terlambat'), earlyLeaveCount: hitung('Jumlah pulang cepat'), hoursWorked: jam('Jam kerja'),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Tidak ada perubahan');
export const GarisManualBuat = z.object({
  personId: uuid('ID orang'),
  workerName: z.string({ error: 'Nama wajib diisi' }).trim().min(1, 'Nama wajib diisi').max(150, 'Nama terlalu panjang (maksimal 150 karakter)'),
});
export const KoreksiRekapBody = z.object({ reason: alasan('Alasan koreksi') });
