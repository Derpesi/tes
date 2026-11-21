import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { decodeKursor, encodeKursor } from '../admin/kursor';
import { AuditService } from '../audit/audit.service';
import { ScopedDb } from '../database/scoped-db';
import type { Akses } from '../rbac/akses.service';
import { DaftarTinjauanQuery, PeriksaBody, PutusanBody } from './schemas';

const TDK = () => new NotFoundException({ kode: 'REKAMAN_TIDAK_DITEMUKAN', message: 'Rekaman absensi tidak ditemukan' });
const konflik = (kode: string, message: string) => new ConflictException({ kode, message });
const SOD = () => new ForbiddenException({ kode: 'PEMISAHAN_TUGAS', message: 'Pemeriksa dan pemutus tinjauan harus orang berbeda' });
type Baris = Record<string, unknown>;

const TAHAP = `CASE WHEN EXISTS (SELECT 1 FROM attendance_reviews v WHERE v.record_id = r.id AND v.stage = 'PUTUSAN') THEN 'SELESAI'
                     WHEN EXISTS (SELECT 1 FROM attendance_reviews v WHERE v.record_id = r.id AND v.stage = 'PERIKSA') THEN 'MENUNGGU_PUTUSAN' ELSE 'MENUNGGU_PERIKSA' END`;
const KOLOM = `r.id, r.company_id, r.person_id, r.kind, r.status, r.shift_date::text AS shift_date, r.occurred_at, r.occurred_at::text AS occurred_txt, r.distance_m, r.accuracy_m, r.anomaly_score,
  l.name AS location_name, COALESCE(m.full_name, 'Tanpa nama') AS worker_name, d.status AS device_status, ${TAHAP} AS tahap,
  COALESCE((SELECT array_agg(f.code ORDER BY f.score DESC, f.code) FROM attendance_flags f WHERE f.record_id = r.id), '{}') AS flags`;
const DARI = `FROM attendance_records r LEFT JOIN partner_locations l ON l.id = r.location_id LEFT JOIN member_profiles m ON m.person_id = r.person_id LEFT JOIN device_registrations d ON d.id = r.device_id`;
const peta = (r: Baris) => ({
  id: r.id, companyId: r.company_id, personId: r.person_id, workerName: r.worker_name, locationName: r.location_name, kind: r.kind, status: r.status, shiftDate: r.shift_date, occurredAt: r.occurred_at,
  distanceM: r.distance_m === null ? null : Number(r.distance_m), accuracyM: r.accuracy_m === null ? null : Number(r.accuracy_m), anomalyScore: r.anomaly_score, flags: r.flags, deviceStatus: r.device_status, tahap: r.tahap,
});

/**
 * Tinjauan absensi dua langkah: pemeriksa (PayAbs/PayInt, attendance_anomaly.review) memeriksa, pemutus (Mgr Ops, attendance_anomaly.approve) memutuskan;
 * orang berbeda (aplikasi + database). Rekaman asli TIDAK diubah; putusan tercatat terpisah dan dipakai tampilan efektif. Scope perusahaan: RLS.
 */
@Injectable()
export class ReviewService {
  constructor(
    private readonly sdb: ScopedDb,
    private readonly audit: AuditService,
  ) {}

  private tx<T>(a: Akses, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    return this.sdb.tx({ companyIds: a.companyIds }, fn);
  }

  async daftar(a: Akses, q: z.infer<typeof DaftarTinjauanQuery>) {
    const k = decodeKursor(q.cursor);
    return this.tx(a, async (c) => {
      const r = await c.query(
        `SELECT * FROM (SELECT ${KOLOM} ${DARI} WHERE r.status = 'PERLU_VERIFIKASI' AND ($1::uuid IS NULL OR r.location_id = $1) AND ($2::timestamptz IS NULL OR (r.occurred_at, r.id) < ($2::timestamptz, $3::uuid))) x
          WHERE ($4::text IS NULL OR x.tahap = $4) ORDER BY x.occurred_at DESC, x.id DESC LIMIT $5`,
        [q.locationId ?? null, k?.t ?? null, k?.id ?? null, q.tahap ?? null, q.limit + 1],
      );
      const ada = r.rows.length > q.limit;
      const baris = r.rows.slice(0, q.limit);
      return { items: baris.map(peta), nextCursor: ada ? encodeKursor({ t: baris[baris.length - 1].occurred_txt, id: baris[baris.length - 1].id }) : null };
    });
  }

  private async muat(c: PoolClient, id: string, kunci = false): Promise<Baris> {
    const r = await c.query(`SELECT ${KOLOM} ${DARI} WHERE r.id = $1 ${kunci ? 'FOR UPDATE OF r' : ''}`, [id]);
    if (!r.rowCount) throw TDK();
    return r.rows[0];
  }

  async detail(a: Akses, id: string) {
    return this.tx(a, async (c) => {
      const r = await this.muat(c, id);
      const geo = (await c.query(`SELECT latitude, longitude, client_time FROM attendance_records WHERE id = $1`, [id])).rows[0];
      const v = await c.query(`SELECT stage, decision, actor_id, reason, created_at FROM attendance_reviews WHERE record_id = $1 ORDER BY created_at, id`, [id]);
      const s = (await c.query(`SELECT purge_after, legal_hold, purged_at FROM attendance_selfies WHERE record_id = $1`, [id])).rows[0];
      return {
        ...peta(r),
        latitude: geo.latitude === null ? null : Number(geo.latitude), longitude: geo.longitude === null ? null : Number(geo.longitude), clientTime: geo.client_time,
        reviews: v.rows.map((x) => ({ stage: x.stage, decision: x.decision, actorId: x.actor_id, reason: x.reason, createdAt: x.created_at })),
        selfie: s ? { available: !s.purged_at, purged: !!s.purged_at, legalHold: s.legal_hold, purgeAfter: s.purge_after } : null, // tanpa isi foto; foto hanya lewat endpoint selfie (diaudit)
      };
    });
  }

  async periksa(a: Akses, id: string, b: z.infer<typeof PeriksaBody>) {
    const rec = await this.tx(a, async (c) => {
      const r = await this.muat(c, id, true);
      if (r.status !== 'PERLU_VERIFIKASI') throw konflik('TIDAK_PERLU_TINJAUAN', 'Rekaman ini tidak menunggu verifikasi');
      if (r.tahap !== 'MENUNGGU_PERIKSA') throw konflik('SUDAH_DIPERIKSA', 'Rekaman ini sudah diperiksa');
      await c.query(`INSERT INTO attendance_reviews (company_id, record_id, stage, decision, actor_id, reason) VALUES ($1, $2, 'PERIKSA', 'DIPERIKSA', $3, $4)`, [r.company_id, id, a.userId, b.reason]);
      return r;
    });
    await this.audit.catat({ aksi: 'attendance.review.checked', aktorId: a.userId, companyId: rec.company_id as string, objek: 'attendance_record', objekId: id });
    return { tahap: 'MENUNGGU_PUTUSAN' };
  }

  async putuskan(a: Akses, id: string, b: z.infer<typeof PutusanBody>) {
    const rec = await this.tx(a, async (c) => {
      const r = await this.muat(c, id, true);
      if (r.status !== 'PERLU_VERIFIKASI') throw konflik('TIDAK_PERLU_TINJAUAN', 'Rekaman ini tidak menunggu verifikasi');
      if (r.tahap === 'SELESAI') throw konflik('SUDAH_DIPUTUSKAN', 'Rekaman ini sudah diputuskan');
      if (r.tahap !== 'MENUNGGU_PUTUSAN') throw konflik('BELUM_DIPERIKSA', 'Rekaman harus diperiksa lebih dulu');
      const p = (await c.query(`SELECT actor_id FROM attendance_reviews WHERE record_id = $1 AND stage = 'PERIKSA'`, [id])).rows[0];
      if (p.actor_id === a.userId) throw SOD();
      if (b.device) {
        if (r.device_status !== 'PERLU_VERIFIKASI') throw konflik('PERANGKAT_TIDAK_MENUNGGU', 'Perangkat rekaman ini tidak menunggu verifikasi');
        await c.query(`UPDATE device_registrations SET status = $2 WHERE id = (SELECT device_id FROM attendance_records WHERE id = $1) AND status = 'PERLU_VERIFIKASI'`, [id, b.device === 'SETUJUI' ? 'DISETUJUI' : 'DITOLAK']);
      }
      try {
        await c.query(`INSERT INTO attendance_reviews (company_id, record_id, stage, decision, actor_id, reason) VALUES ($1, $2, 'PUTUSAN', $3, $4, $5)`, [r.company_id, id, b.decision, a.userId, b.reason]);
      } catch (e) {
        if ((e as { code?: string }).code === '23514') throw SOD();
        throw e;
      }
      return r;
    });
    await this.audit.catat({
      aksi: 'attendance.review.decided', aktorId: a.userId, companyId: rec.company_id as string, objek: 'attendance_record', objekId: id,
      detail: { putusan: b.decision, perangkat: b.device ?? null },
    });
    return { tahap: 'SELESAI', decision: b.decision };
  }
}
