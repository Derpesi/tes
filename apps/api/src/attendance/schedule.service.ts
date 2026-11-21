import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { decodeKursor, encodeKursor } from '../admin/kursor';
import { AuditService } from '../audit/audit.service';
import { ScopedDb } from '../database/scoped-db';
import type { Akses } from '../rbac/akses.service';
import { DaftarJadwalQuery, DaftarLiburQuery, DaftarShiftQuery, JadwalBuat, LiburBuat, ShiftBuat, ShiftUbah } from './schemas';

const konflik = (kode: string, message: string) => new ConflictException({ kode, message });
const tdk = (kode: string, message: string) => new NotFoundException({ kode, message });
type Baris = Record<string, unknown>;

const petaShift = (r: Baris) => ({
  id: r.id, companyId: r.company_id, name: r.name, kind: r.kind, startTime: r.start, endTime: r.finish, crossesMidnight: r.crosses_midnight,
  lateToleranceMin: r.late_tolerance_min, earlyToleranceMin: r.early_tolerance_min, status: r.status, createdAt: r.created_at,
});
const KOLOM_SHIFT = `id, company_id, name, kind, to_char(start_time, 'HH24:MI') AS start, to_char(end_time, 'HH24:MI') AS finish, crosses_midnight, late_tolerance_min, early_tolerance_min, status, created_at, created_at::text AS created_at_txt`;

/** Shift, jadwal kerja per penempatan, dan hari libur. Izin placement.* (docs/rbac.md); scope perusahaan ditegakkan RLS. */
@Injectable()
export class ScheduleService {
  constructor(
    private readonly sdb: ScopedDb,
    private readonly audit: AuditService,
  ) {}

  private tx<T>(a: Akses, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    return this.sdb.tx({ companyIds: a.companyIds }, fn);
  }
  private perusahaan(a: Akses, id?: string): string {
    const companyId = id ?? (a.companyIds.length === 1 ? a.companyIds[0] : undefined);
    if (!companyId) throw konflik('PERUSAHAAN_WAJIB', 'Pilih perusahaan');
    if (!a.companyIds.includes(companyId)) throw tdk('PERUSAHAAN_TIDAK_DITEMUKAN', 'Perusahaan tidak ditemukan');
    return companyId;
  }
  private async halaman(a: Akses, tabel: string, kolom: string, kursor: string | undefined, limit: number, kondisi: string, nilai: unknown[], urut: string, peta: (r: Baris) => unknown) {
    const k = decodeKursor(kursor);
    return this.tx(a, async (c) => {
      const n = nilai.length;
      const r = await c.query(
        `SELECT ${kolom} FROM ${tabel} WHERE ${kondisi} AND ($${n + 1}::timestamptz IS NULL OR (created_at, id) < ($${n + 1}::timestamptz, $${n + 2}::uuid)) ORDER BY ${urut} LIMIT $${n + 3}`,
        [...nilai, k?.t ?? null, k?.id ?? null, limit + 1],
      );
      const ada = r.rows.length > limit;
      const baris = r.rows.slice(0, limit);
      return { items: baris.map(peta), nextCursor: ada ? encodeKursor({ t: baris[baris.length - 1].created_at_txt, id: baris[baris.length - 1].id }) : null };
    });
  }

  // ----- shift -----
  daftarShift(a: Akses, q: z.infer<typeof DaftarShiftQuery>) {
    return this.halaman(a, 'shift_patterns', KOLOM_SHIFT, q.cursor, q.limit, `($1::uuid IS NULL OR company_id = $1)`, [q.companyId ?? null], 'created_at DESC, id DESC', petaShift);
  }
  async buatShift(a: Akses, b: z.infer<typeof ShiftBuat>) {
    const companyId = this.perusahaan(a, b.companyId);
    const menyeberang = b.endTime <= b.startTime;
    const hasil = await this.tx(a, async (c) => {
      try {
        const r = await c.query(
          `INSERT INTO shift_patterns (company_id, name, kind, start_time, end_time, crosses_midnight, late_tolerance_min, early_tolerance_min, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${KOLOM_SHIFT}`,
          [companyId, b.name, b.kind, b.startTime, b.endTime, menyeberang, b.lateToleranceMin, b.earlyToleranceMin, a.userId],
        );
        return r.rows[0];
      } catch (e) {
        if ((e as { constraint?: string }).constraint === 'shift_patterns_nama_unik') throw konflik('SHIFT_NAMA_SUDAH_ADA', 'Nama shift sudah dipakai');
        throw e;
      }
    });
    await this.audit.catat({ aksi: 'attendance.shift.created', aktorId: a.userId, companyId, objek: 'shift_pattern', objekId: hasil.id });
    return petaShift(hasil);
  }
  async ubahShift(a: Akses, id: string, b: z.infer<typeof ShiftUbah>) {
    const hasil = await this.tx(a, async (c) => {
      const r = await c.query(
        `UPDATE shift_patterns SET status = COALESCE($2, status), late_tolerance_min = COALESCE($3, late_tolerance_min), early_tolerance_min = COALESCE($4, early_tolerance_min) WHERE id = $1 RETURNING ${KOLOM_SHIFT}`,
        [id, b.status ?? null, b.lateToleranceMin ?? null, b.earlyToleranceMin ?? null],
      );
      if (!r.rowCount) throw tdk('SHIFT_TIDAK_DITEMUKAN', 'Shift tidak ditemukan');
      return r.rows[0];
    });
    await this.audit.catat({ aksi: 'attendance.shift.updated', aktorId: a.userId, companyId: hasil.company_id, objek: 'shift_pattern', objekId: id, detail: { bidang: Object.keys(b) } });
    return petaShift(hasil);
  }

  // ----- jadwal kerja -----
  private static petaJadwal = (r: Baris) => ({ id: r.id, companyId: r.company_id, placementId: r.placement_id, shiftId: r.shift_id, workDays: r.work_days, validFrom: r.valid_from, validTo: r.valid_to, createdAt: r.created_at });
  private static KOLOM_JADWAL = `id, company_id, placement_id, shift_id, work_days, valid_from::text AS valid_from, valid_to::text AS valid_to, created_at, created_at::text AS created_at_txt`;
  daftarJadwal(a: Akses, q: z.infer<typeof DaftarJadwalQuery>) {
    return this.halaman(a, 'work_schedules', ScheduleService.KOLOM_JADWAL, q.cursor, q.limit, `($1::uuid IS NULL OR placement_id = $1)`, [q.placementId ?? null], 'created_at DESC, id DESC', ScheduleService.petaJadwal);
  }
  async buatJadwal(a: Akses, b: z.infer<typeof JadwalBuat>) {
    const hasil = await this.tx(a, async (c) => {
      const p = await c.query(`SELECT company_id, status FROM placements WHERE id = $1`, [b.placementId]);
      if (!p.rowCount) throw tdk('PENEMPATAN_TIDAK_DITEMUKAN', 'Penempatan tidak ditemukan');
      if (!['DIRENCANAKAN', 'MENUNGGU_KONTRAK', 'AKTIF', 'DITANGGUHKAN'].includes(p.rows[0].status as string)) throw konflik('PENEMPATAN_TIDAK_BERJALAN', 'Penempatan sudah selesai atau dibatalkan');
      const s = await c.query(`SELECT 1 FROM shift_patterns WHERE id = $1 AND company_id = $2 AND status = 'AKTIF'`, [b.shiftId, p.rows[0].company_id]);
      if (!s.rowCount) throw tdk('SHIFT_TIDAK_DITEMUKAN', 'Shift tidak ditemukan atau tidak aktif');
      // Dua jadwal berlaku bersamaan untuk satu penempatan bertabrakan hari kerjanya: tolak agar penentuan shift tidak ambigu.
      const t = await c.query(
        `SELECT 1 FROM work_schedules WHERE placement_id = $1 AND work_days && $2::smallint[] AND daterange(valid_from, valid_to, '[]') && daterange($3::date, $4::date, '[]') LIMIT 1`,
        [b.placementId, b.workDays, b.validFrom, b.validTo ?? null],
      );
      if (t.rowCount) throw konflik('JADWAL_BERTABRAKAN', 'Jadwal tumpang tindih pada hari kerja dan periode yang sama');
      const r = await c.query(
        `INSERT INTO work_schedules (company_id, placement_id, shift_id, work_days, valid_from, valid_to, created_by) VALUES ($1, $2, $3, $4::smallint[], $5, $6, $7) RETURNING ${ScheduleService.KOLOM_JADWAL}`,
        [p.rows[0].company_id, b.placementId, b.shiftId, b.workDays, b.validFrom, b.validTo ?? null, a.userId],
      );
      return r.rows[0];
    });
    await this.audit.catat({ aksi: 'attendance.schedule.created', aktorId: a.userId, companyId: hasil.company_id, objek: 'work_schedule', objekId: hasil.id });
    return ScheduleService.petaJadwal(hasil);
  }
  async hapusJadwal(a: Akses, id: string) {
    const hasil = await this.tx(a, async (c) => {
      const r = await c.query(`DELETE FROM work_schedules WHERE id = $1 RETURNING company_id`, [id]);
      if (!r.rowCount) throw tdk('JADWAL_TIDAK_DITEMUKAN', 'Jadwal tidak ditemukan');
      return r.rows[0];
    });
    await this.audit.catat({ aksi: 'attendance.schedule.deleted', aktorId: a.userId, companyId: hasil.company_id, objek: 'work_schedule', objekId: id });
  }

  // ----- hari libur -----
  private static petaLibur = (r: Baris) => ({ id: r.id, companyId: r.company_id, date: r.holiday_date, scope: r.scope, locationId: r.location_id, name: r.name, createdAt: r.created_at });
  private static KOLOM_LIBUR = `id, company_id, holiday_date::text AS holiday_date, scope, location_id, name, created_at, created_at::text AS created_at_txt`;
  daftarLibur(a: Akses, q: z.infer<typeof DaftarLiburQuery>) {
    return this.halaman(a, 'holidays', ScheduleService.KOLOM_LIBUR, q.cursor, q.limit, `($1::int IS NULL OR extract(year FROM holiday_date) = $1)`, [q.year ?? null], 'created_at DESC, id DESC', ScheduleService.petaLibur);
  }
  async buatLibur(a: Akses, b: z.infer<typeof LiburBuat>) {
    const hasil = await this.tx(a, async (c) => {
      let companyId: string;
      if (b.scope === 'LOKASI') {
        const l = await c.query(`SELECT company_id FROM partner_locations WHERE id = $1`, [b.locationId]);
        if (!l.rowCount) throw tdk('LOKASI_TIDAK_DITEMUKAN', 'Lokasi tidak ditemukan');
        companyId = l.rows[0].company_id as string;
      } else companyId = this.perusahaan(a, b.companyId);
      try {
        const r = await c.query(`INSERT INTO holidays (company_id, holiday_date, scope, location_id, name, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${ScheduleService.KOLOM_LIBUR}`, [companyId, b.date, b.scope, b.locationId ?? null, b.name, a.userId]);
        return r.rows[0];
      } catch (e) {
        if ((e as { constraint?: string }).constraint === 'holidays_unik') throw konflik('LIBUR_SUDAH_ADA', 'Hari libur untuk tanggal dan cakupan ini sudah ada');
        throw e;
      }
    });
    await this.audit.catat({ aksi: 'attendance.holiday.created', aktorId: a.userId, companyId: hasil.company_id, objek: 'holiday', objekId: hasil.id });
    return ScheduleService.petaLibur(hasil);
  }
  async hapusLibur(a: Akses, id: string) {
    const hasil = await this.tx(a, async (c) => {
      const r = await c.query(`DELETE FROM holidays WHERE id = $1 RETURNING company_id`, [id]);
      if (!r.rowCount) throw tdk('LIBUR_TIDAK_DITEMUKAN', 'Hari libur tidak ditemukan');
      return r.rows[0];
    });
    await this.audit.catat({ aksi: 'attendance.holiday.deleted', aktorId: a.userId, companyId: hasil.company_id, objek: 'holiday', objekId: id });
  }
}
