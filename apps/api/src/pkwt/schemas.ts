import { z } from 'zod';
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
