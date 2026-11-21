import { ForbiddenException } from '@nestjs/common';
import type { Akses } from '../rbac/akses.service';

export type JenisRekap = 'PARTNER' | 'INTERNAL';
export type AksiRekap = 'view' | 'create' | 'update' | 'review' | 'export';
const AWAL = (k: JenisRekap) => (k === 'PARTNER' ? 'payroll_recap_partner' : 'payroll_recap_internal');

/** Semua izin rekap payroll (untuk rute baca yang terbuka bagi pelaksana tindakan). */
export const SEMUA_IZIN_PAYROLL = [
  'payroll_recap_partner.view', 'payroll_recap_partner.create', 'payroll_recap_partner.update', 'payroll_recap_partner.review', 'payroll_recap_partner.export',
  'payroll_recap_internal.view', 'payroll_recap_internal.create', 'payroll_recap_internal.update', 'payroll_recap_internal.review', 'payroll_recap_internal.approve', 'payroll_recap_internal.export',
  'payroll_approval.approve', 'payroll_approval.finalize',
] as const;

/** Izin khusus jenis rekap (matriks rbac.md: rekanan dan internal dipisah). */
export const punyaIzin = (a: Akses, kind: JenisRekap, ...aksi: AksiRekap[]): boolean => aksi.some((x) => a.permissions.has(`${AWAL(kind)}.${x}`));
/** Jenis yang boleh dilihat: pemegang izin apa pun pada jenis itu. */
export const jenisTerlihat = (a: Akses): JenisRekap[] => (['PARTNER', 'INTERNAL'] as const).filter((k) => punyaIzin(a, k, 'view', 'create', 'update', 'review', 'export'));
export function wajibIzin(a: Akses, kind: JenisRekap, ...aksi: AksiRekap[]): void {
  if (!punyaIzin(a, kind, ...aksi)) throw new ForbiddenException({ kode: 'IZIN_DITOLAK', message: 'Anda tidak memiliki izin untuk tindakan ini' });
}
