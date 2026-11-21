import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { decodeKursor, encodeKursor } from '../admin/kursor';
import { AuditService } from '../audit/audit.service';
import { ScopedDb } from '../database/scoped-db';
import type { Akses } from '../rbac/akses.service';
import { dokumenCsv } from './csv';
import { RekapEksporQuery, RekapQuery } from './schemas';

export const BATAS_EKSPOR_BARIS = 10000;
const jam = (d: Date | null) => (d ? new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', hour12: false }).format(d).replace('.', ':') : null);
type Baris = Record<string, unknown>;

export interface Saring { from: string; to: string; locationId?: string; personId?: string }

/**
 * Rekap absensi per orang-hari (tanggal-shift) dari REKAMAN EFEKTIF: putusan tinjauan menggantikan status asli, koreksi bernomor yang disetujui menggantikan
 * hasil hari itu. Hanya hari yang memiliki rekaman atau koreksi yang muncul (hari tanpa absen belum diturunkan dari jadwal: Fase 8). Ekspor hanya CSV.
 * Bukan perhitungan gaji (tahap awal payroll = rekap dan ekspor). Scope perusahaan: RLS.
 */
@Injectable()
export class RecapService {
  /** Batas baris ekspor; dapat diubah tes agar penolakan ukuran dapat diuji tanpa 10.000 baris. */
  batasEkspor = BATAS_EKSPOR_BARIS;
  constructor(
    private readonly sdb: ScopedDb,
    private readonly audit: AuditService,
  ) {}

  /** Baris rekap per orang-hari (mentah). Dipakai juga oleh snapshot payroll (Fase 8) agar satu sumber kebenaran. */
  async ambil(c: PoolClient, f: Saring, batas: number, kursor: { t: string; id: string } | null): Promise<Baris[]> {
    const r = await c.query(
      `WITH rek AS (
         SELECT e.id, e.person_id, e.shift_date, e.location_id, e.kind, e.occurred_at, e.effective_status
           FROM attendance_effective e
          WHERE e.shift_date BETWEEN $1::date AND $2::date AND ($3::uuid IS NULL OR e.location_id = $3) AND ($4::uuid IS NULL OR e.person_id = $4)
       ), hari AS (
         SELECT person_id, shift_date, (array_agg(location_id ORDER BY occurred_at))[1] AS location_id,
                min(occurred_at) FILTER (WHERE kind = 'MASUK' AND effective_status IN ('VALID', 'DISETUJUI')) AS masuk_at,
                max(occurred_at) FILTER (WHERE kind = 'PULANG' AND effective_status IN ('VALID', 'DISETUJUI')) AS pulang_at,
                count(*) FILTER (WHERE effective_status = 'PERLU_VERIFIKASI')::int AS menunggu,
                COALESCE(array_agg(DISTINCT f.code) FILTER (WHERE f.code IN ('TERLAMBAT', 'PULANG_CEPAT') AND rek.effective_status IN ('VALID', 'DISETUJUI')), '{}') AS penanda
           FROM rek LEFT JOIN attendance_flags f ON f.record_id = rek.id GROUP BY person_id, shift_date
       ), kor AS (
         SELECT DISTINCT ON (k.person_id, k.shift_date) k.person_id, k.shift_date, k.effect, k.adjustment_no
           FROM attendance_adjustments k
          WHERE k.status = 'DISETUJUI' AND k.shift_date BETWEEN $1::date AND $2::date AND ($4::uuid IS NULL OR k.person_id = $4)
            AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM placements p WHERE p.person_id = k.person_id AND p.location_id = $3))
          ORDER BY k.person_id, k.shift_date, k.decided_at DESC, k.id DESC
       ), gab AS (
         SELECT COALESCE(h.person_id, k.person_id) AS person_id, COALESCE(h.shift_date, k.shift_date) AS shift_date, h.location_id, h.masuk_at, h.pulang_at, COALESCE(h.menunggu, 0) AS menunggu,
                COALESCE(h.penanda, '{}') AS penanda, k.effect AS efek_koreksi, k.adjustment_no,
                COALESCE(k.effect, CASE WHEN h.masuk_at IS NOT NULL THEN 'HADIR' WHEN COALESCE(h.menunggu, 0) > 0 THEN 'MENUNGGU_VERIFIKASI' ELSE 'TIDAK_HADIR' END) AS status_hari
           FROM hari h FULL OUTER JOIN kor k ON k.person_id = h.person_id AND k.shift_date = h.shift_date
       )
       SELECT g.person_id, g.shift_date::text AS shift_date, COALESCE(m.full_name, 'Tanpa nama') AS worker_name, l.name AS location_name, g.masuk_at, g.pulang_at, g.status_hari, g.penanda, g.menunggu,
              g.efek_koreksi IS NOT NULL AS dikoreksi, g.adjustment_no
         FROM gab g LEFT JOIN member_profiles m ON m.person_id = g.person_id LEFT JOIN partner_locations l ON l.id = g.location_id
        WHERE ($5::timestamptz IS NULL OR (g.shift_date, g.person_id) < (($5::timestamptz AT TIME ZONE 'UTC')::date, $6::uuid))
        ORDER BY g.shift_date DESC, g.person_id DESC LIMIT $7`,
      [f.from, f.to, f.locationId ?? null, f.personId ?? null, kursor?.t ?? null, kursor?.id ?? null, batas],
    );
    return r.rows;
  }

  private peta = (r: Baris) => ({
    personId: r.person_id, workerName: r.worker_name, shiftDate: r.shift_date, locationName: r.location_name, masuk: jam(r.masuk_at as Date | null), pulang: jam(r.pulang_at as Date | null),
    status: r.status_hari, flags: r.penanda, pendingVerification: r.menunggu, corrected: r.dikoreksi, adjustmentNo: r.adjustment_no,
  });

  async daftar(a: Akses, q: z.infer<typeof RekapQuery>) {
    const k = decodeKursor(q.cursor);
    return this.sdb.tx({ companyIds: a.companyIds }, async (c) => {
      const baris = await this.ambil(c, q, q.limit + 1, k);
      const ada = baris.length > q.limit;
      const sisa = baris.slice(0, q.limit);
      const akhir = sisa[sisa.length - 1];
      return { items: sisa.map(this.peta), nextCursor: ada ? encodeKursor({ t: `${akhir.shift_date} 00:00:00+00`, id: akhir.person_id as string }) : null };
    });
  }

  async ekspor(a: Akses, q: z.infer<typeof RekapEksporQuery>): Promise<string> {
    const baris = await this.sdb.tx({ companyIds: a.companyIds }, (c) => this.ambil(c, q, this.batasEkspor + 1, null));
    if (baris.length > this.batasEkspor) throw new UnprocessableEntityException({ kode: 'REKAP_TERLALU_BESAR', message: `Rekap melebihi ${this.batasEkspor} baris. Persempit rentang tanggal atau filter lokasi` });
    for (const companyId of a.companyIds) {
      await this.audit.catat({
        aksi: 'attendance.recap.exported', aktorId: a.userId, companyId, objek: 'attendance_recap',
        detail: { dari: q.from, sampai: q.to, lokasi: q.locationId ?? null, pekerja: q.personId ?? null, jumlahBaris: baris.length, format: 'csv' },
      });
    }
    const kepala = ['Tanggal Shift', 'Nama', 'Lokasi', 'Masuk (WIB)', 'Pulang (WIB)', 'Status', 'Penanda', 'Menunggu Verifikasi', 'Dikoreksi', 'Nomor Koreksi'];
    return dokumenCsv(kepala, baris.map((r) => {
      const x = this.peta(r);
      return [x.shiftDate, x.workerName, x.locationName, x.masuk, x.pulang, x.status, (x.flags as string[]).join(' '), x.pendingVerification, x.corrected ? 'Ya' : 'Tidak', x.adjustmentNo];
    }));
  }
}
