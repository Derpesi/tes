import type { PoolClient } from 'pg';

export interface Butir { key: string; label: string; value: number }
export interface Widget {
  id: string;
  title: string;
  link: string;
  /** Pemegang SALAH SATU izin ini boleh melihat widget. Widget hanya berisi angka agregat (tanpa nama, NIK, nominal). */
  izin: readonly string[];
  hitung: (c: PoolClient, k: { hari: string; jenisPayroll: ('PARTNER' | 'INTERNAL')[] }) => Promise<Butir[]>;
}

const satu = async (c: PoolClient, sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows[0] as Record<string, number>;
const butir = (key: string, label: string, value: unknown): Butir => ({ key, label, value: Number(value) });

/**
 * Daftar widget dashboard staf. Semua kueri berjalan di bawah RLS scope pemanggil (ScopedDb): angka tidak melintasi perusahaan.
 * Tabel tanpa company_id (member, pengguna, permintaan persetujuan) dibaca hanya oleh pemegang izin domainnya.
 */
export const WIDGET: readonly Widget[] = [
  {
    id: 'karyawan', title: 'Karyawan aktif', link: '/staff/karyawan', izin: ['placement.view'],
    hitung: async (c, { hari }) => {
      const r = await satu(
        c,
        `SELECT count(*) FILTER (WHERE p.status = 'AKTIF')::int AS aktif, count(*) FILTER (WHERE p.status = 'DITANGGUHKAN')::int AS tangguh,
                count(*) FILTER (WHERE (kn.end_date - $1::date) <= 30 AND NOT EXISTS (SELECT 1 FROM employment_contracts n WHERE n.extends_contract_id = kn.id AND n.status IN ('DITANDATANGANI', 'AKTIF')))::int AS akan
           FROM placements p JOIN employment_contracts kn ON kn.id = p.contract_id AND kn.status = 'AKTIF' WHERE p.status IN ('AKTIF', 'DITANGGUHKAN')`,
        [hari],
      );
      return [butir('aktif', 'Karyawan aktif', r.aktif), butir('ditangguhkan', 'Ditangguhkan', r.tangguh), butir('akan_berakhir', 'Kontrak berakhir dalam 30 hari', r.akan)];
    },
  },
  {
    id: 'penempatan', title: 'Penempatan menunggu', link: '/staff/penempatan', izin: ['placement.approve'],
    hitung: async (c) => {
      const r = await satu(c, `SELECT count(*) FILTER (WHERE status = 'DIRENCANAKAN')::int AS rencana, count(*) FILTER (WHERE status = 'MENUNGGU_KONTRAK')::int AS kontrak FROM placements`);
      return [butir('direncanakan', 'Menunggu persetujuan', r.rencana), butir('menunggu_kontrak', 'Menunggu kontrak aktif', r.kontrak)];
    },
  },
  {
    id: 'member', title: 'Member', link: '/staff/anggota', izin: ['member.view'],
    hitung: async (c) => {
      const r = await satu(
        c,
        `SELECT count(*) FILTER (WHERE status = 'MENUNGGU_VERIFIKASI')::int AS verif, count(*) FILTER (WHERE status = 'BELUM_DITEMPATKAN')::int AS belum, count(*) FILTER (WHERE status IN ('KARYAWAN_AKTIF', 'KONTRAK_AKAN_BERAKHIR'))::int AS aktif,
                count(*) FILTER (WHERE status = 'KONTRAK_BERAKHIR')::int AS berakhir FROM member_profiles`,
      );
      return [butir('menunggu_verifikasi', 'Menunggu verifikasi HRD', r.verif), butir('belum_ditempatkan', 'Belum ditempatkan', r.belum), butir('karyawan', 'Karyawan', r.aktif), butir('kontrak_berakhir', 'Kontrak berakhir', r.berakhir)];
    },
  },
  {
    id: 'lamaran', title: 'Rekrutmen', link: '/staff/lamaran', izin: ['vacancy_application.view'],
    hitung: async (c) => {
      const r = await satu(
        c,
        `SELECT (SELECT count(*) FROM job_vacancies WHERE status = 'DIBUKA')::int AS buka,
                count(*) FILTER (WHERE status = 'DIAJUKAN')::int AS diajukan, count(*) FILTER (WHERE status = 'SELEKSI_ADMINISTRASI')::int AS seleksi,
                count(*) FILTER (WHERE status = 'INTERVIEW')::int AS interview, count(*) FILTER (WHERE status = 'MENUNGGU_PKWT')::int AS pkwt FROM job_applications`,
      );
      return [butir('lowongan_dibuka', 'Lowongan dibuka', r.buka), butir('diajukan', 'Lamaran diajukan', r.diajukan), butir('seleksi', 'Seleksi administrasi', r.seleksi), butir('interview', 'Interview', r.interview), butir('menunggu_pkwt', 'Diterima, menunggu PKWT', r.pkwt)];
    },
  },
  {
    id: 'pkwt', title: 'Kontrak PKWT', link: '/staff/pkwt', izin: ['pkwt.view'],
    hitung: async (c) => {
      const r = await satu(
        c,
        `SELECT count(*) FILTER (WHERE status = 'DRAFT')::int AS draf, count(*) FILTER (WHERE status = 'REVIEW')::int AS periksa, count(*) FILTER (WHERE status = 'PERSETUJUAN')::int AS setuju,
                count(*) FILTER (WHERE status = 'PENANDATANGANAN')::int AS ttd, count(*) FILTER (WHERE status = 'MENUNGGU_VERIFIKASI_DOKUMEN')::int AS dok, count(*) FILTER (WHERE status = 'AKTIF')::int AS aktif FROM employment_contracts`,
      );
      return [butir('draf', 'Draf', r.draf), butir('review', 'Menunggu pemeriksaan', r.periksa), butir('persetujuan', 'Menunggu persetujuan', r.setuju), butir('penandatanganan', 'Menunggu tanda tangan basah', r.ttd), butir('verifikasi_dokumen', 'Menunggu verifikasi scan', r.dok), butir('aktif', 'Aktif', r.aktif)];
    },
  },
  {
    id: 'absensi_hari_ini', title: 'Absensi hari ini', link: '/staff/rekap-absensi', izin: ['attendance_recap.view'],
    hitung: async (c, { hari }) => {
      const r = await satu(
        c,
        `SELECT count(*) FILTER (WHERE status = 'VALID')::int AS valid, count(*) FILTER (WHERE status = 'PERLU_VERIFIKASI')::int AS perlu, count(*) FILTER (WHERE status = 'DITOLAK')::int AS tolak,
                count(DISTINCT person_id) FILTER (WHERE kind = 'MASUK' AND status <> 'DITOLAK')::int AS masuk
           FROM attendance_records WHERE shift_date = $1::date`,
        [hari],
      );
      return [butir('masuk', 'Karyawan sudah masuk', r.masuk), butir('valid', 'Rekaman valid', r.valid), butir('perlu_verifikasi', 'Perlu verifikasi', r.perlu), butir('ditolak', 'Ditolak', r.tolak)];
    },
  },
  {
    id: 'tinjauan_absensi', title: 'Tinjauan absensi', link: '/staff/tinjauan-absensi', izin: ['attendance_anomaly.view', 'attendance_anomaly.review', 'attendance_anomaly.approve'],
    hitung: async (c) => {
      const r = await satu(
        c,
        `SELECT count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM attendance_reviews v WHERE v.record_id = r.id AND v.stage = 'PERIKSA'))::int AS periksa,
                count(*) FILTER (WHERE EXISTS (SELECT 1 FROM attendance_reviews v WHERE v.record_id = r.id AND v.stage = 'PERIKSA') AND NOT EXISTS (SELECT 1 FROM attendance_reviews v WHERE v.record_id = r.id AND v.stage = 'PUTUSAN'))::int AS putus
           FROM attendance_records r WHERE r.status = 'PERLU_VERIFIKASI'`,
      );
      return [butir('menunggu_periksa', 'Menunggu pemeriksaan', r.periksa), butir('menunggu_putusan', 'Menunggu putusan', r.putus)];
    },
  },
  {
    id: 'koreksi_absensi', title: 'Koreksi absensi', link: '/staff/koreksi-absensi', izin: ['attendance_adjustment.view', 'attendance_adjustment.create', 'attendance_adjustment.update', 'attendance_adjustment.approve'],
    hitung: async (c) => [butir('diajukan', 'Menunggu putusan', (await satu(c, `SELECT count(*)::int AS n FROM attendance_adjustments WHERE status = 'DIAJUKAN'`)).n)],
  },
  {
    id: 'titik_absensi', title: 'Titik absensi', link: '/staff/titik-absensi', izin: ['attendance_point.view', 'attendance_point.create', 'attendance_point.update', 'attendance_point.export'],
    hitung: async (c) => [butir('aktif', 'Titik aktif', (await satu(c, `SELECT count(*)::int AS n FROM attendance_points WHERE status = 'AKTIF'`)).n)],
  },
  {
    id: 'payroll', title: 'Rekap payroll', link: '/staff/payroll',
    izin: ['payroll_recap_partner.view', 'payroll_recap_partner.create', 'payroll_recap_partner.update', 'payroll_recap_partner.review', 'payroll_recap_partner.export', 'payroll_recap_internal.view', 'payroll_recap_internal.create',
      'payroll_recap_internal.update', 'payroll_recap_internal.review', 'payroll_recap_internal.export'],
    hitung: async (c, { jenisPayroll }) => {
      const hasil: Butir[] = [];
      for (const kind of jenisPayroll) {
        const r = await satu(
          c,
          `SELECT count(*) FILTER (WHERE r.status = 'DRAFT')::int AS draf, count(*) FILTER (WHERE r.status = 'DIVERIFIKASI')::int AS verif, count(*) FILTER (WHERE r.status = 'DISETUJUI')::int AS setuju, count(*) FILTER (WHERE r.status = 'DIFINALISASI')::int AS final
             FROM payroll_recaps r JOIN payroll_periods p ON p.id = r.period_id WHERE p.kind = $1 AND r.status <> 'DIGANTIKAN'`,
          [kind],
        );
        const awal = kind === 'PARTNER' ? 'Rekanan' : 'Internal';
        const k = kind.toLowerCase();
        hasil.push(butir(`${k}_draf`, `${awal}: draf`, r.draf), butir(`${k}_diverifikasi`, `${awal}: menunggu persetujuan`, r.verif), butir(`${k}_disetujui`, `${awal}: menunggu finalisasi`, r.setuju), butir(`${k}_difinalisasi`, `${awal}: difinalisasi`, r.final));
      }
      return hasil;
    },
  },
  {
    id: 'pengguna', title: 'Pengguna staf', link: '/staff/persetujuan', izin: ['user_role.view'],
    hitung: async (c) => {
      const r = await satu(
        c,
        `SELECT (SELECT count(*) FROM users WHERE realm = 'staff' AND status = 'AKTIF')::int AS aktif, (SELECT count(*) FROM users WHERE realm = 'staff' AND status = 'DIUNDANG')::int AS undangan,
                (SELECT count(*) FROM approval_requests WHERE status = 'MENUNGGU' AND expires_at > now())::int AS menunggu`,
      );
      return [butir('aktif', 'Staf aktif', r.aktif), butir('diundang', 'Undangan tertunda', r.undangan), butir('persetujuan_menunggu', 'Persetujuan menunggu', r.menunggu)];
    },
  },
  {
    id: 'rekanan', title: 'Rekanan', link: '/staff/rekanan', izin: ['partner.view'],
    hitung: async (c) => {
      const r = await satu(c, `SELECT (SELECT count(*) FROM partners WHERE status = 'AKTIF')::int AS rek, (SELECT count(*) FROM partner_locations WHERE status = 'AKTIF')::int AS lok, (SELECT count(*) FROM partner_contracts WHERE status = 'AKTIF')::int AS ktr, (SELECT count(*) FROM partner_contracts WHERE status = 'DRAFT')::int AS draf`);
      return [butir('rekanan_aktif', 'Rekanan aktif', r.rek), butir('lokasi_aktif', 'Lokasi aktif', r.lok), butir('kontrak_aktif', 'Kontrak layanan aktif', r.ktr), butir('kontrak_menunggu', 'Kontrak layanan draf', r.draf)];
    },
  },
];
