import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { dokumenCsv } from '../attendance/csv';
import { ScopedDb } from '../database/scoped-db';
import { jenisTerlihat } from '../payroll/akses';
import type { Akses } from '../rbac/akses.service';
import { LaporanQuery, NamaLaporan } from './schemas';

export const BATAS_BARIS_LAPORAN = 5000;
type Rentang = z.infer<typeof LaporanQuery>;
export interface BarisLaporan { companyId: string | null; companyName: string; location: string | null; measure: string; value: string | number }
type Bagian = Record<string, BarisLaporan[]>;

const IZIN_MEMBER = ['member.view', 'member.view_summary'];
const ada = (a: Akses, ...izin: string[]) => izin.some((i) => a.permissions.has(i));

/**
 * Laporan konsolidasi (hanya baca, agregat): ketenagakerjaan, rekrutmen, absensi, payroll. Tiap BAGIAN mensyaratkan izin domainnya selain
 * `report_consolidated.view`; bagian tanpa izin dihilangkan dari respons. Dihitung di bawah RLS scope pemanggil. Nominal payroll hanya subtotal rekap
 * DISETUJUI/DIFINALISASI (bukan gaji) dan hanya untuk pemegang izin payroll jenis itu. Tanpa nama pekerja, NIK, atau data pribadi lain.
 */
@Injectable()
export class ReportsService {
  /** Batas baris; dapat diubah tes agar penolakan ukuran teruji tanpa ribuan baris. */
  batasBaris = BATAS_BARIS_LAPORAN;
  constructor(
    private readonly sdb: ScopedDb,
    private readonly audit: AuditService,
  ) {}

  private batas(rows: unknown[]) {
    if (rows.length > this.batasBaris) throw new UnprocessableEntityException({ kode: 'LAPORAN_TERLALU_BESAR', message: `Laporan melebihi ${this.batasBaris} baris. Persempit rentang tanggal` });
  }

  private async namaPerusahaan(c: PoolClient, ids: string[]): Promise<Map<string, string>> {
    if (!ids.length) return new Map();
    return new Map((await c.query(`SELECT id, name FROM companies WHERE id = ANY($1::uuid[])`, [ids])).rows.map((r) => [r.id as string, r.name as string]));
  }
  private baris(nama: Map<string, string>, companyId: string | null, measure: string, value: string | number, location: string | null = null): BarisLaporan {
    return { companyId, companyName: companyId ? nama.get(companyId) ?? companyId : 'Seluruh Group', location, measure, value };
  }

  async ambil(a: Akses, laporan: NamaLaporan, r: Rentang): Promise<{ from: string; to: string; sections: Bagian }> {
    const sections = await this.sdb.tx({ companyIds: a.companyIds }, async (c) => {
      const nama = await this.namaPerusahaan(c, a.companyIds);
      if (laporan === 'workforce') return this.workforce(c, a, r, nama);
      if (laporan === 'recruitment') return this.recruitment(c, a, r, nama);
      if (laporan === 'attendance') return this.attendance(c, a, r, nama);
      return this.payroll(c, a, r, nama);
    });
    for (const rows of Object.values(sections)) this.batas(rows);
    return { from: r.from, to: r.to, sections };
  }

  private async workforce(c: PoolClient, a: Akses, r: Rentang, nama: Map<string, string>): Promise<Bagian> {
    const hasil: Bagian = {};
    if (ada(a, 'placement.view')) {
      const t = await c.query(
        `SELECT p.company_id, count(*) FILTER (WHERE p.status = 'AKTIF')::int AS aktif, count(*) FILTER (WHERE p.status = 'DITANGGUHKAN')::int AS tangguh,
                count(*) FILTER (WHERE (kn.end_date - $1::date) <= 30 AND NOT EXISTS (SELECT 1 FROM employment_contracts n WHERE n.extends_contract_id = kn.id AND n.status IN ('DITANDATANGANI', 'AKTIF')))::int AS akan
           FROM placements p JOIN employment_contracts kn ON kn.id = p.contract_id AND kn.status = 'AKTIF' WHERE p.status IN ('AKTIF', 'DITANGGUHKAN') GROUP BY p.company_id ORDER BY p.company_id`,
        [r.to],
      );
      const l = await c.query(
        `SELECT p.company_id, pt.name AS rekanan, l.name AS lokasi, count(*)::int AS n FROM placements p JOIN employment_contracts kn ON kn.id = p.contract_id AND kn.status = 'AKTIF'
           JOIN partner_locations l ON l.id = p.location_id JOIN partners pt ON pt.id = l.partner_id WHERE p.status IN ('AKTIF', 'DITANGGUHKAN') GROUP BY p.company_id, pt.name, l.name ORDER BY p.company_id, n DESC, l.name LIMIT 2000`,
      );
      hasil.karyawan = [
        ...t.rows.flatMap((x) => [this.baris(nama, x.company_id, 'Karyawan aktif', x.aktif), this.baris(nama, x.company_id, 'Karyawan ditangguhkan', x.tangguh), this.baris(nama, x.company_id, 'Kontrak berakhir dalam 30 hari sejak tanggal akhir', x.akan)]),
        ...l.rows.map((x) => this.baris(nama, x.company_id, 'Karyawan per lokasi', x.n, `${x.rekanan} — ${x.lokasi}`)),
      ];
    }
    if (ada(a, 'pkwt.view')) {
      const k = await c.query(`SELECT company_id, status, count(*)::int AS n FROM employment_contracts GROUP BY company_id, status ORDER BY company_id, status`);
      const d = await c.query(
        `SELECT company_id, count(*) FILTER (WHERE start_date BETWEEN $1::date AND $2::date AND status IN ('AKTIF', 'BERAKHIR', 'DIAKHIRI_LEBIH_AWAL'))::int AS mulai,
                count(*) FILTER (WHERE end_date BETWEEN $1::date AND $2::date AND status IN ('AKTIF', 'BERAKHIR'))::int AS berakhir FROM employment_contracts GROUP BY company_id ORDER BY company_id`,
        [r.from, r.to],
      );
      hasil.kontrak = [
        ...k.rows.map((x) => this.baris(nama, x.company_id, `Kontrak status ${x.status}`, x.n)),
        ...d.rows.flatMap((x) => [this.baris(nama, x.company_id, 'Kontrak dimulai dalam rentang', x.mulai), this.baris(nama, x.company_id, 'Kontrak berakhir dalam rentang', x.berakhir)]),
      ];
    }
    if (ada(a, ...IZIN_MEMBER)) {
      const m = await c.query(`SELECT status, count(*)::int AS n FROM member_profiles GROUP BY status ORDER BY status`); // member bersifat global (tanpa perusahaan)
      hasil.statusMember = m.rows.map((x) => this.baris(nama, null, `Member status ${x.status}`, x.n));
    }
    return hasil;
  }

  private async recruitment(c: PoolClient, a: Akses, r: Rentang, nama: Map<string, string>): Promise<Bagian> {
    if (!ada(a, 'vacancy_application.view')) return {};
    const v = await c.query(`SELECT company_id, status, count(*)::int AS n FROM job_vacancies GROUP BY company_id, status ORDER BY company_id, status`);
    const l = await c.query(
      `SELECT company_id, status, count(*)::int AS n FROM job_applications WHERE (created_at AT TIME ZONE 'Asia/Jakarta')::date BETWEEN $1::date AND $2::date GROUP BY company_id, status ORDER BY company_id, status`,
      [r.from, r.to],
    );
    return {
      lowongan: v.rows.map((x) => this.baris(nama, x.company_id, `Lowongan status ${x.status}`, x.n)),
      lamaran: l.rows.map((x) => this.baris(nama, x.company_id, `Lamaran dibuat dalam rentang, status ${x.status}`, x.n)),
    };
  }

  private async attendance(c: PoolClient, a: Akses, r: Rentang, nama: Map<string, string>): Promise<Bagian> {
    if (!ada(a, 'attendance_recap.view')) return {};
    const t = await c.query(
      `SELECT e.company_id, pt.name AS rekanan, l.name AS lokasi,
              count(*) FILTER (WHERE e.original_status = 'VALID')::int AS valid, count(*) FILTER (WHERE e.original_status = 'PERLU_VERIFIKASI')::int AS perlu, count(*) FILTER (WHERE e.original_status = 'DITOLAK')::int AS tolak,
              count(DISTINCT (e.person_id, e.shift_date)) FILTER (WHERE e.kind = 'MASUK' AND e.effective_status IN ('VALID', 'DISETUJUI'))::int AS hadir,
              count(*) FILTER (WHERE e.kind = 'MASUK' AND e.effective_status IN ('VALID', 'DISETUJUI') AND EXISTS (SELECT 1 FROM attendance_flags f WHERE f.record_id = e.id AND f.code = 'TERLAMBAT'))::int AS telat
         FROM attendance_effective e JOIN partner_locations l ON l.id = e.location_id JOIN partners pt ON pt.id = l.partner_id
        WHERE e.shift_date BETWEEN $1::date AND $2::date GROUP BY e.company_id, pt.name, l.name ORDER BY e.company_id, pt.name, l.name LIMIT 2000`,
      [r.from, r.to],
    );
    const f = await c.query(
      `SELECT x.company_id, x.code, x.n FROM (
         SELECT r.company_id, f.code, count(*)::int AS n, row_number() OVER (PARTITION BY r.company_id ORDER BY count(*) DESC, f.code) AS urut
           FROM attendance_flags f JOIN attendance_records r ON r.id = f.record_id WHERE r.shift_date BETWEEN $1::date AND $2::date AND f.code NOT IN ('TERLAMBAT', 'PULANG_CEPAT') GROUP BY r.company_id, f.code) x
        WHERE x.urut <= 5 ORDER BY x.company_id, x.urut`,
      [r.from, r.to],
    );
    return {
      absensi: t.rows.flatMap((x) => {
        const lok = `${x.rekanan} — ${x.lokasi}`;
        return [this.baris(nama, x.company_id, 'Rekaman valid', x.valid, lok), this.baris(nama, x.company_id, 'Rekaman perlu verifikasi', x.perlu, lok), this.baris(nama, x.company_id, 'Rekaman ditolak', x.tolak, lok),
          this.baris(nama, x.company_id, 'Hari hadir (orang-hari, rekaman efektif)', x.hadir, lok), this.baris(nama, x.company_id, 'Masuk terlambat', x.telat, lok)];
      }),
      penandaAnomali: f.rows.map((x) => this.baris(nama, x.company_id, `Penanda ${x.code}`, x.n)),
    };
  }

  private async payroll(c: PoolClient, a: Akses, r: Rentang, nama: Map<string, string>): Promise<Bagian> {
    const hasil: Bagian = {};
    for (const kind of jenisTerlihat(a)) {
      const awal = kind === 'PARTNER' ? 'Rekanan' : 'Internal';
      const per = await c.query(
        `SELECT p.company_id, rr.status, count(*)::int AS n FROM payroll_periods p JOIN LATERAL (SELECT x.status FROM payroll_recaps x WHERE x.period_id = p.id AND x.status <> 'DIGANTIKAN' ORDER BY x.version_no DESC LIMIT 1) rr ON true
          WHERE p.kind = $1 AND daterange(p.start_date, p.end_date, '[]') && daterange($2::date, $3::date, '[]') GROUP BY p.company_id, rr.status ORDER BY p.company_id, rr.status`,
        [kind, r.from, r.to],
      );
      const sub = await c.query(
        `SELECT p.company_id, k.kind AS jenis, sum(k.amount)::text AS total FROM payroll_periods p JOIN payroll_recaps rc ON rc.period_id = p.id AND rc.status IN ('DISETUJUI', 'DIFINALISASI')
           JOIN payroll_recap_lines l ON l.recap_id = rc.id JOIN payroll_components k ON k.line_id = l.id
          WHERE p.kind = $1 AND daterange(p.start_date, p.end_date, '[]') && daterange($2::date, $3::date, '[]') GROUP BY p.company_id, k.kind ORDER BY p.company_id, k.kind`,
        [kind, r.from, r.to],
      );
      const bar = await c.query(
        `SELECT p.company_id, count(DISTINCT l.id)::int AS n FROM payroll_periods p JOIN payroll_recaps rc ON rc.period_id = p.id AND rc.status IN ('DISETUJUI', 'DIFINALISASI') JOIN payroll_recap_lines l ON l.recap_id = rc.id
          WHERE p.kind = $1 AND daterange(p.start_date, p.end_date, '[]') && daterange($2::date, $3::date, '[]') GROUP BY p.company_id ORDER BY p.company_id`,
        [kind, r.from, r.to],
      );
      hasil[kind === 'PARTNER' ? 'rekanan' : 'internal'] = [
        ...per.rows.map((x) => this.baris(nama, x.company_id, `${awal}: periode dengan rekap status ${x.status}`, x.n)),
        ...bar.rows.map((x) => this.baris(nama, x.company_id, `${awal}: baris pada rekap disetujui`, x.n)),
        ...sub.rows.map((x) => this.baris(nama, x.company_id, `${awal}: subtotal ${String(x.jenis).toLowerCase()} (rekap disetujui, bukan gaji)`, x.total)),
      ];
    }
    return hasil;
  }

  /** CSV format panjang (Bagian, Perusahaan, Lokasi, Ukuran, Nilai). Nama perusahaan/lokasi dianggap tak tepercaya (formula injection dinetralkan). Diaudit. */
  async ekspor(a: Akses, laporan: NamaLaporan, r: Rentang): Promise<string> {
    const d = await this.ambil(a, laporan, r);
    const baris = Object.entries(d.sections).flatMap(([bagian, rows]) => rows.map((x) => [bagian, x.companyName, x.location ?? '', x.measure, x.value]));
    this.batas(baris);
    for (const companyId of a.companyIds) {
      await this.audit.catat({ aksi: 'report.exported', aktorId: a.userId, companyId, objek: 'report', objekId: laporan, detail: { jenis: laporan, mulai: r.from, sampai: r.to, jumlahBaris: baris.length, format: 'csv' } });
    }
    return dokumenCsv(['Bagian', 'Perusahaan', 'Lokasi', 'Ukuran', 'Nilai'], baris);
  }
}
