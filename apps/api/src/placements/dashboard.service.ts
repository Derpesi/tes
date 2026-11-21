import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { decodeKursor, encodeKursor } from '../admin/kursor';
import { ScopedDb } from '../database/scoped-db';
import { MemberContextService } from '../member/member-context.service';
import { hariIni } from '../pkwt/lifecycle.service';
import type { Akses } from '../rbac/akses.service';
import { DaftarKaryawanQuery } from './schemas';

type Baris = Record<string, unknown>;

/**
 * Dashboard. Member: hanya data miliknya (RLS memberPersonId) dan hanya status kontrak yang relevan bagi member (tanpa draf/pemeriksa internal).
 * Staff (karyawan aktif): terbatas scope perusahaan (RLS); hanya nama, jabatan, lokasi, kontrak, dan sisa hari — tanpa NIK/kontak/alamat.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly sdb: ScopedDb,
    private readonly ctx: MemberContextService,
  ) {}

  async member(userId: string) {
    const personId = await this.ctx.personId(userId);
    const hari = hariIni(new Date());
    return this.sdb.tx({ companyIds: [], memberPersonId: personId }, async (c) => {
      const prof = await c.query(`SELECT status FROM member_profiles WHERE person_id = $1`, [personId]);
      const k = await c.query(
        `SELECT contract_number, position, start_date::text AS start_date, end_date::text AS end_date, status, (end_date - $1::date) AS sisa
           FROM employment_contracts WHERE status IN ('AKTIF', 'DITANDATANGANI', 'BERAKHIR', 'DIAKHIRI_LEBIH_AWAL')
          ORDER BY CASE status WHEN 'AKTIF' THEN 0 WHEN 'DITANDATANGANI' THEN 1 ELSE 2 END, start_date DESC LIMIT 1`,
        [hari],
      );
      const pl = await c.query(
        `SELECT p.status, p.start_date::text AS start_date, p.end_date::text AS end_date, l.name AS location_name, l.city AS location_city
           FROM placements p JOIN partner_locations l ON l.id = p.location_id WHERE p.status IN ('AKTIF', 'DITANGGUHKAN', 'MENUNGGU_KONTRAK')
          ORDER BY CASE p.status WHEN 'AKTIF' THEN 0 WHEN 'DITANGGUHKAN' THEN 1 ELSE 2 END, p.start_date DESC LIMIT 1`,
      );
      const lam = await c.query(`SELECT count(*)::int AS n FROM job_applications WHERE status = 'MENUNGGU_PKWT'`);
      const kr = k.rows[0] as Baris | undefined;
      const pr = pl.rows[0] as Baris | undefined;
      return {
        status: (prof.rows[0]?.status as string | undefined) ?? 'TERDAFTAR',
        contract: kr ? { number: kr.contract_number, position: kr.position, startDate: kr.start_date, endDate: kr.end_date, status: kr.status, daysLeft: kr.status === 'AKTIF' ? Number(kr.sisa) : null } : null,
        placement: pr ? { status: pr.status, startDate: pr.start_date, endDate: pr.end_date, locationName: pr.location_name, locationCity: pr.location_city } : null,
        applicationsAwaitingContract: lam.rows[0].n as number,
      };
    });
  }

  async karyawan(a: Akses, q: z.infer<typeof DaftarKaryawanQuery>) {
    const k = decodeKursor(q.cursor);
    const hari = hariIni(new Date());
    return this.sdb.tx({ companyIds: a.companyIds }, async (c) => {
      const r = await c.query(
        `SELECT p.id, p.company_id, p.status AS placement_status, p.created_at::text AS created_at_txt, m.full_name, m.status AS member_status, kn.contract_number, kn.position, kn.end_date::text AS contract_end,
                (kn.end_date - $1::date) AS sisa, l.name AS location_name, l.id AS location_id,
                EXISTS (SELECT 1 FROM employment_contracts n WHERE n.extends_contract_id = kn.id AND n.status IN ('DITANDATANGANI', 'AKTIF')) AS ada_lanjutan
           FROM placements p JOIN employment_contracts kn ON kn.id = p.contract_id AND kn.status = 'AKTIF' JOIN partner_locations l ON l.id = p.location_id LEFT JOIN member_profiles m ON m.person_id = p.person_id
          WHERE p.status IN ('AKTIF', 'DITANGGUHKAN') AND ($2::uuid IS NULL OR p.location_id = $2)
            AND ($3::boolean IS NOT TRUE OR ((kn.end_date - $1::date) <= 30 AND NOT EXISTS (SELECT 1 FROM employment_contracts n WHERE n.extends_contract_id = kn.id AND n.status IN ('DITANDATANGANI', 'AKTIF'))))
            AND ($4::timestamptz IS NULL OR (p.created_at, p.id) < ($4::timestamptz, $5::uuid))
          ORDER BY p.created_at DESC, p.id DESC LIMIT $6`,
        [hari, q.locationId ?? null, q.akanBerakhir ?? null, k?.t ?? null, k?.id ?? null, q.limit + 1],
      );
      const ada = r.rows.length > q.limit;
      const baris = r.rows.slice(0, q.limit);
      return {
        items: baris.map((x) => ({
          placementId: x.id, companyId: x.company_id, workerName: x.full_name, position: x.position, locationId: x.location_id, locationName: x.location_name, contractNumber: x.contract_number,
          contractEndDate: x.contract_end, daysLeft: Number(x.sisa), hasContinuation: x.ada_lanjutan, placementStatus: x.placement_status, memberStatus: x.member_status,
        })),
        nextCursor: ada ? encodeKursor({ t: baris[baris.length - 1].created_at_txt, id: baris[baris.length - 1].id }) : null,
      };
    });
  }

  async ringkasan(a: Akses) {
    const hari = hariIni(new Date());
    return this.sdb.tx({ companyIds: a.companyIds }, async (c) => {
      const t = await c.query(
        `SELECT count(*) FILTER (WHERE p.status = 'AKTIF')::int AS aktif, count(*) FILTER (WHERE p.status = 'DITANGGUHKAN')::int AS ditangguhkan,
                count(*) FILTER (WHERE (kn.end_date - $1::date) <= 30 AND NOT EXISTS (SELECT 1 FROM employment_contracts n WHERE n.extends_contract_id = kn.id AND n.status IN ('DITANDATANGANI', 'AKTIF')))::int AS akan_berakhir
           FROM placements p JOIN employment_contracts kn ON kn.id = p.contract_id AND kn.status = 'AKTIF' WHERE p.status IN ('AKTIF', 'DITANGGUHKAN')`,
        [hari],
      );
      const l = await c.query(
        `SELECT l.id, l.name, count(*)::int AS jumlah FROM placements p JOIN employment_contracts kn ON kn.id = p.contract_id AND kn.status = 'AKTIF' JOIN partner_locations l ON l.id = p.location_id
          WHERE p.status IN ('AKTIF', 'DITANGGUHKAN') GROUP BY l.id, l.name ORDER BY jumlah DESC, l.name LIMIT 50`,
      );
      return { active: t.rows[0].aktif as number, suspended: t.rows[0].ditangguhkan as number, expiringWithin30Days: t.rows[0].akan_berakhir as number, perLocation: l.rows.map((x) => ({ locationId: x.id, locationName: x.name, count: x.jumlah })) };
    });
  }
}
