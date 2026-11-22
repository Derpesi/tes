import { z } from 'zod';
import { tanggalValid } from '../common/tanggal';
import { variabelTidakDikenal } from './variabel';

const uuid = (nama: string) => z.string({ error: `${nama} wajib diisi` }).uuid(`${nama} tidak valid`);
const isiTemplateSkema = z
  .string({ error: 'Isi template wajib diisi' })
  .trim()
  .min(1, 'Isi template wajib diisi')
  .max(50000, 'Isi template terlalu panjang (maksimal 50000 karakter)')
  .superRefine((v, ctx) => {
    const buruk = variabelTidakDikenal(v);
    if (buruk.length) ctx.addIssue({ code: 'custom', message: `Variabel tidak dikenal: ${buruk.join(', ')}` });
  });
const namaTemplate = z.string({ error: 'Nama template wajib diisi' }).trim().min(1, 'Nama template wajib diisi').max(150, 'Nama template terlalu panjang (maksimal 150 karakter)');

export const IdParam = uuid('ID');
export const Halaman = z.object({ cursor: z.string().max(500).optional(), limit: z.coerce.number().int().min(1, 'limit minimal 1').max(100, 'limit maksimal 100').default(50) });

export const DaftarTemplateQuery = Halaman.extend({
  companyId: uuid('ID perusahaan').optional(),
  status: z.enum(['BELUM_DIVERIFIKASI', 'TERVERIFIKASI', 'DIARSIPKAN'], { error: 'Status tidak valid' }).optional(),
});
/** Membuat versi baru dari template bernama `name` (versi otomatis = terakhir + 1). */
export const TemplateBuat = z.object({ companyId: uuid('ID perusahaan').optional(), name: namaTemplate, body: isiTemplateSkema });
export const TemplateUbah = z.object({ name: namaTemplate, body: isiTemplateSkema }).partial().strict().refine((v) => Object.keys(v).length > 0, 'Tidak ada perubahan yang dikirim');
export const VerifikasiTemplateBody = z.object({ note: z.string({ error: 'Catatan verifikasi wajib diisi' }).trim().min(3, 'Catatan verifikasi wajib diisi (minimal 3 karakter)').max(500, 'Catatan terlalu panjang (maksimal 500 karakter)') });

// ---------------- Kontrak PKWT ----------------
const tanggal = (nama: string) =>
  z
    .string({ error: `${nama} wajib diisi` })
    .regex(/^\d{4}-\d{2}-\d{2}$/, `${nama}: format harus YYYY-MM-DD`)
    .refine((v) => tanggalValid(v), `${nama} bukan tanggal yang valid`);
const jabatan = z.string({ error: 'Jabatan wajib diisi' }).trim().min(1, 'Jabatan wajib diisi').max(100, 'Jabatan terlalu panjang (maksimal 100 karakter)');
const periodeOk = (v: { startDate?: string; endDate?: string }) => !v.startDate || !v.endDate || v.endDate >= v.startDate;
const PESAN_PERIODE = 'Tanggal berakhir tidak boleh sebelum tanggal mulai';
const alasan = (nama: string) => z.string({ error: `${nama} wajib diisi` }).trim().min(3, `${nama} wajib diisi (minimal 3 karakter)`).max(500, `${nama} terlalu panjang (maksimal 500 karakter)`);

export const STATUS_KONTRAK = ['DRAFT', 'REVIEW', 'PERSETUJUAN', 'PENANDATANGANAN', 'MENUNGGU_VERIFIKASI_DOKUMEN', 'DITANDATANGANI', 'AKTIF', 'BERAKHIR', 'DIAKHIRI_LEBIH_AWAL', 'DIBATALKAN'] as const;
export const DaftarKontrakQuery = Halaman.extend({
  status: z.enum(STATUS_KONTRAK, { error: 'Status tidak valid' }).optional(),
  applicationId: uuid('ID lamaran').optional(),
});
export const KontrakBuat = z
  .object({
    applicationId: uuid('ID lamaran'),
    templateId: uuid('ID template'),
    position: jabatan,
    startDate: tanggal('Tanggal mulai'),
    endDate: tanggal('Tanggal berakhir'),
    /** Perpanjangan: kontrak lanjutan bertaut (alur penuh, tidak menimpa kontrak yang berjalan). */
    extendsContractId: uuid('ID kontrak sebelumnya').optional(),
  })
  .refine(periodeOk, PESAN_PERIODE);
export const KontrakUbah = z
  .object({ templateId: uuid('ID template'), position: jabatan, startDate: tanggal('Tanggal mulai'), endDate: tanggal('Tanggal berakhir'), reason: alasan('Alasan perubahan') })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).filter((k) => k !== 'reason').length > 0, 'Tidak ada perubahan yang dikirim')
  .refine(periodeOk, PESAN_PERIODE);
export const AlasanBody = z.object({ reason: alasan('Alasan') });
export const DokumenScanBody = z.object({ versionNo: z.coerce.number().int().min(1, 'Versi tidak valid').optional() });
