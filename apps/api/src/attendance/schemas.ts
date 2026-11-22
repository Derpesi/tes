import { z } from 'zod';
import { tanggalValid } from '../common/tanggal';

const uuid = (nama: string) => z.string({ error: `${nama} wajib diisi` }).uuid(`${nama} tidak valid`);
const tanggal = (nama: string) =>
  z
    .string({ error: `${nama} wajib diisi` })
    .regex(/^\d{4}-\d{2}-\d{2}$/, `${nama}: format harus YYYY-MM-DD`)
    .refine((v) => tanggalValid(v), `${nama} bukan tanggal yang valid`);
const jam = (nama: string) => z.string({ error: `${nama} wajib diisi` }).regex(/^([01]\d|2[0-3]):[0-5]\d$/, `${nama}: format harus HH:MM (00:00-23:59)`);
const toleransi = (nama: string) => z.coerce.number({ error: `${nama} harus berupa angka` }).int(`${nama} harus bilangan bulat`).min(0, `${nama} minimal 0`).max(240, `${nama} maksimal 240 menit`);

export const IdParam = z.string({ error: 'ID wajib diisi' }).uuid('ID tidak valid');
const halaman = { cursor: z.string().max(500).optional(), limit: z.coerce.number().int().min(1, 'limit minimal 1').max(100, 'limit maksimal 100').default(50) };

export const DaftarTitikQuery = z.object({ ...halaman, locationId: uuid('ID lokasi').optional(), status: z.enum(['AKTIF', 'NONAKTIF'], { error: 'Status tidak valid' }).optional() });
export const TitikBuat = z.object({ locationId: uuid('ID lokasi') });

export const ShiftBuat = z.object({
  companyId: uuid('ID perusahaan').optional(),
  name: z.string({ error: 'Nama shift wajib diisi' }).trim().min(1, 'Nama shift wajib diisi').max(80, 'Nama shift terlalu panjang (maksimal 80 karakter)'),
  kind: z.enum(['FIXED', 'FLEXIBLE'], { error: 'Jenis harus FIXED atau FLEXIBLE' }).default('FIXED'),
  startTime: jam('Jam mulai'),
  endTime: jam('Jam selesai'),
  lateToleranceMin: toleransi('Toleransi terlambat').default(15),
  earlyToleranceMin: toleransi('Toleransi awal').default(30),
}).refine((v) => v.startTime !== v.endTime, { message: 'Jam mulai dan jam selesai tidak boleh sama', path: ['endTime'] });
export const ShiftUbah = z.object({ status: z.enum(['AKTIF', 'NONAKTIF'], { error: 'Status tidak valid' }).optional(), lateToleranceMin: toleransi('Toleransi terlambat').optional(), earlyToleranceMin: toleransi('Toleransi awal').optional() })
  .refine((v) => Object.keys(v).length > 0, 'Tidak ada perubahan');
export const DaftarShiftQuery = z.object({ ...halaman, companyId: uuid('ID perusahaan').optional() });

const HARI = z.array(z.number().int().min(1).max(7), { error: 'Hari kerja wajib diisi' }).min(1, 'Pilih minimal satu hari kerja').max(7).refine((a) => new Set(a).size === a.length, 'Hari kerja tidak boleh ganda');
export const JadwalBuat = z.object({
  placementId: uuid('ID penempatan'),
  shiftId: uuid('ID shift'),
  workDays: HARI,
  validFrom: tanggal('Berlaku dari'),
  validTo: tanggal('Berlaku sampai').optional(),
}).refine((v) => !v.validTo || v.validTo >= v.validFrom, { message: 'Berlaku sampai tidak boleh sebelum berlaku dari', path: ['validTo'] });
export const DaftarJadwalQuery = z.object({ ...halaman, placementId: uuid('ID penempatan').optional() });

export const LiburBuat = z.object({
  companyId: uuid('ID perusahaan').optional(),
  date: tanggal('Tanggal libur'),
  scope: z.enum(['NASIONAL', 'PERUSAHAAN', 'LOKASI'], { error: 'Cakupan harus NASIONAL, PERUSAHAAN, atau LOKASI' }),
  locationId: uuid('ID lokasi').optional(),
  name: z.string({ error: 'Nama libur wajib diisi' }).trim().min(1, 'Nama libur wajib diisi').max(120, 'Nama libur terlalu panjang (maksimal 120 karakter)'),
}).refine((v) => (v.scope === 'LOKASI') === !!v.locationId, { message: 'Lokasi wajib untuk cakupan LOKASI dan dilarang untuk cakupan lain', path: ['locationId'] });
export const DaftarLiburQuery = z.object({ ...halaman, year: z.coerce.number().int().min(2000).max(2100).optional() });

// ----- absen member (multipart: semua nilai berupa teks) -----
const angka = (nama: string, min: number, max: number) =>
  z.coerce.number({ error: `${nama} harus berupa angka` }).refine((v) => Number.isFinite(v), `${nama} harus berupa angka`).refine((v) => v >= min && v <= max, `${nama} harus antara ${min} dan ${max}`);
export const AbsenBody = z.object({
  code: z.string({ error: 'Kode titik wajib diisi' }).uuid('Kode titik tidak valid'),
  kind: z.enum(['MASUK', 'PULANG'], { error: 'Jenis absen harus MASUK atau PULANG' }),
  latitude: angka('Lintang', -90, 90),
  longitude: angka('Bujur', -180, 180),
  accuracy: angka('Akurasi', 0, 100000).optional(),
  clientTime: z.string().datetime({ offset: true, error: 'Waktu perangkat harus berformat ISO 8601' }).optional(),
  deviceId: z.string({ error: 'ID perangkat wajib diisi' }).regex(/^[A-Za-z0-9_-]{16,100}$/, 'ID perangkat tidak valid'),
  idempotencyKey: z.string({ error: 'Kunci idempotensi wajib diisi' }).regex(/^[A-Za-z0-9_-]{8,100}$/, 'Kunci idempotensi tidak valid'),
});
export const RiwayatAbsenQuery = z.object({ ...halaman });

// ----- tinjauan, selfie, koreksi, rekap (staf) -----
const alasan = (nama: string) => z.string({ error: `${nama} wajib diisi` }).trim().min(3, `${nama} wajib diisi (minimal 3 karakter)`).max(500, `${nama} terlalu panjang (maksimal 500 karakter)`);
export const DaftarTinjauanQuery = z.object({
  ...halaman,
  tahap: z.enum(['MENUNGGU_PERIKSA', 'MENUNGGU_PUTUSAN', 'SELESAI'], { error: 'Tahap tidak valid' }).optional(),
  locationId: uuid('ID lokasi').optional(),
});
export const PeriksaBody = z.object({ reason: alasan('Catatan pemeriksaan') });
export const PutusanBody = z.object({
  decision: z.enum(['DISETUJUI', 'DITOLAK'], { error: 'Putusan harus DISETUJUI atau DITOLAK' }),
  reason: alasan('Alasan putusan'),
  /** Hanya bila perangkat rekaman masih PERLU_VERIFIKASI: sekaligus menyetujui/menolak perangkat itu. */
  device: z.enum(['SETUJUI', 'TOLAK'], { error: 'Tindakan perangkat harus SETUJUI atau TOLAK' }).optional(),
});
export const HoldBody = z.object({ hold: z.boolean({ error: 'hold harus true atau false' }), reason: alasan('Alasan') });

export const KoreksiBuat = z.object({
  personId: uuid('ID pekerja'),
  shiftDate: tanggal('Tanggal shift'),
  effect: z.enum(['HADIR', 'TIDAK_HADIR', 'IZIN', 'SAKIT'], { error: 'Efek koreksi tidak valid' }),
  reason: alasan('Alasan koreksi'),
  recordId: uuid('ID rekaman').optional(),
});
export const KoreksiUbah = z.object({ effect: z.enum(['HADIR', 'TIDAK_HADIR', 'IZIN', 'SAKIT'], { error: 'Efek koreksi tidak valid' }).optional(), reason: alasan('Alasan koreksi').optional() })
  .refine((v) => Object.keys(v).length > 0, 'Tidak ada perubahan');
export const KoreksiPutusan = z.object({ decision: z.enum(['DISETUJUI', 'DITOLAK'], { error: 'Putusan harus DISETUJUI atau DITOLAK' }), note: alasan('Catatan putusan') });
export const DaftarKoreksiQuery = z.object({
  ...halaman,
  status: z.enum(['DIAJUKAN', 'DISETUJUI', 'DITOLAK'], { error: 'Status tidak valid' }).optional(),
  personId: uuid('ID pekerja').optional(),
});

export const RekapQuery = z.object({
  ...halaman,
  from: tanggal('Dari tanggal'),
  to: tanggal('Sampai tanggal'),
  locationId: uuid('ID lokasi').optional(),
  personId: uuid('ID pekerja').optional(),
}).refine((v) => v.to >= v.from, { message: 'Sampai tanggal tidak boleh sebelum dari tanggal', path: ['to'] })
  .refine((v) => (Date.parse(v.to) - Date.parse(v.from)) / 86400000 <= 92, { message: 'Rentang rekap maksimal 93 hari', path: ['to'] });
export const RekapEksporQuery = z.object({
  from: tanggal('Dari tanggal'),
  to: tanggal('Sampai tanggal'),
  locationId: uuid('ID lokasi').optional(),
  personId: uuid('ID pekerja').optional(),
}).refine((v) => v.to >= v.from, { message: 'Sampai tanggal tidak boleh sebelum dari tanggal', path: ['to'] })
  .refine((v) => (Date.parse(v.to) - Date.parse(v.from)) / 86400000 <= 92, { message: 'Rentang rekap maksimal 93 hari', path: ['to'] });
