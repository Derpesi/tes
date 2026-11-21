export const LABEL_STATUS_REKAP: Record<string, string> = { DRAFT: 'Draf (disusun)', DIVERIFIKASI: 'Diverifikasi', DISETUJUI: 'Disetujui', DIFINALISASI: 'Difinalisasi', DIGANTIKAN: 'Digantikan versi koreksi' };
export const LABEL_JENIS_REKAP: Record<string, string> = { PARTNER: 'Rekanan', INTERNAL: 'Internal' };
export const LABEL_KOMPONEN: Record<string, string> = { TUNJANGAN: 'Tunjangan', POTONGAN: 'Potongan', INSENTIF: 'Insentif' };
export const IZIN_PAYROLL_LIHAT = [
  'payroll_recap_partner.view', 'payroll_recap_partner.create', 'payroll_recap_partner.update', 'payroll_recap_partner.review', 'payroll_recap_partner.export',
  'payroll_recap_internal.view', 'payroll_recap_internal.create', 'payroll_recap_internal.update', 'payroll_recap_internal.review', 'payroll_recap_internal.export',
  'payroll_approval.approve', 'payroll_approval.finalize',
];
/** Izin per jenis rekap (matriks rbac.md: rekanan dan internal dipisah). Menu hanya kemudahan; penegakan di backend. */
export const izinJenis = (kind: string, aksi: string) => `payroll_recap_${kind === 'PARTNER' ? 'partner' : 'internal'}.${aksi}`;
