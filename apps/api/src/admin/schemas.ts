import { z } from 'zod';

const uuid = z.string({ error: 'ID wajib diisi' }).uuid('ID tidak valid');
const kodePeran = z.string({ error: 'Kode peran wajib diisi' }).regex(/^[A-Z_]{2,60}$/, 'Kode peran tidak valid');

export const UndangBody = z.object({
  email: z.string({ error: 'Email wajib diisi' }).trim().min(3, 'Email wajib diisi').max(254, 'Email terlalu panjang').email('Format email tidak valid'),
  displayName: z.string({ error: 'Nama wajib diisi' }).trim().min(1, 'Nama wajib diisi').max(100, 'Nama terlalu panjang'),
  roles: z.array(kodePeran).max(5, 'Maksimal 5 peran').default([]),
  companyIds: z.array(uuid).max(50, 'Maksimal 50 perusahaan').default([]),
});

export const BeriPeranBody = z.object({
  roleCode: kodePeran,
  expiresAt: z
    .string()
    .datetime({ message: 'Format tanggal tidak valid' })
    .refine((v) => new Date(v).getTime() > Date.now(), 'Tanggal kedaluwarsa harus di masa depan')
    .refine((v) => new Date(v).getTime() < Date.now() + 366 * 24 * 3600 * 1000, 'Masa berlaku maksimal 1 tahun')
    .optional(),
});

export const BeriScopeBody = z.object({ companyId: uuid });
export const KeputusanBody = z.object({ note: z.string().trim().max(500, 'Catatan terlalu panjang').optional() });

export const IdParam = uuid;
export const KodePeranParam = kodePeran;

export const DaftarQuery = z.object({
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1, 'limit minimal 1').max(100, 'limit maksimal 100').default(50),
});

export const ApprovalQuery = z.object({ status: z.enum(['MENUNGGU', 'DISETUJUI', 'DITOLAK', 'KEDALUWARSA', 'DIBATALKAN'], { error: 'Status tidak valid' }).default('MENUNGGU') });

export const AuditQuery = z.object({
  action: z.string().trim().max(100).optional(),
  kategori: z.enum(['TEKNIS', 'TRANSAKSI', 'OPERASIONAL'], { error: 'Kategori harus TEKNIS, TRANSAKSI, atau OPERASIONAL' }).optional(),
  objectType: z.string().trim().max(60).optional(),
  objectId: z.string().trim().max(100).optional(),
  actorId: z.string().uuid('ID aktor tidak valid').optional(),
  companyId: z.string().uuid('ID perusahaan tidak valid').optional(),
  from: z.string().datetime({ message: 'Format "from" tidak valid' }).optional(),
  to: z.string().datetime({ message: 'Format "to" tidak valid' }).optional(),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1, 'limit minimal 1').max(100, 'limit maksimal 100').default(50),
});
