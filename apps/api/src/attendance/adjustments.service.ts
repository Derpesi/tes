import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { decodeKursor, encodeKursor } from '../admin/kursor';
import { AuditService } from '../audit/audit.service';
import { ScopedDb } from '../database/scoped-db';
import type { Akses } from '../rbac/akses.service';
import { JAM_ABSENSI, JamAbsensi } from './jam';
import { DaftarKoreksiQuery, KoreksiBuat, KoreksiPutusan, KoreksiUbah } from './schemas';
import { tanggalWib } from './shift';

const TDK = () => new NotFoundException({ kode: 'KOREKSI_TIDAK_DITEMUKAN', message: 'Koreksi tidak ditemukan' });
const konflik = (kode: string, message: string) => new ConflictException({ kode, message });
const SOD = () => new ForbiddenException({ kode: 'PEMISAHAN_TUGAS', message: 'Penyetuju koreksi tidak boleh sama dengan pembuatnya' });
type Baris = Record<string, unknown>;

const KOLOM = `k.id, k.company_id, k.adjustment_no, k.person_id, COALESCE(m.full_name, 'Tanpa nama') AS worker_name, k.shift_date::text AS shift_date, k.record_id, k.effect, k.reason, k.status,
  k.created_by, k.decided_by, k.decided_at, k.decision_note, k.created_at, k.created_at::text AS created_at_txt`;
const DARI = `FROM attendance_adjustments k LEFT JOIN member_profiles m ON m.person_id = k.person_id`;
const peta = (r: Baris) => ({
  id: r.id, companyId: r.company_id, adjustmentNo: r.adjustment_no, personId: r.person_id, workerName: r.worker_name, shiftDate: r.shift_date, recordId: r.record_id, effect: r.effect, reason: r.reason,
  status: r.status, createdBy: r.created_by, decidedBy: r.decided_by, decidedAt: r.decided_at, decisionNote: r.decision_note, createdAt: r.created_at,
});

/**
 * Koreksi absensi bernomor: diajukan PayAbs/PayInt (attendance_adjustment.create/update), diputuskan Mgr Ops (attendance_adjustment.approve);
 * penyetuju ≠ pembuat (aplikasi + database). Rekaman asli TIDAK diubah; koreksi disetujui dipakai rekap. Scope perusahaan: RLS.
 */
@Injectable()
export class AdjustmentsService {
  constructor(
    private readonly sdb: ScopedDb,
    private readonly audit: AuditService,
    @Inject(JAM_ABSENSI) private readonly jam: JamAbsensi,
  ) {}

  private tx<T>(a: Akses, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    return this.sdb.tx({ companyIds: a.companyIds }, fn);
  }
  private async muat(c: PoolClient, id: string, kunci = false): Promise<Baris> {
    const r = await c.query(`SELECT ${KOLOM} ${DARI} WHERE k.id = $1 ${kunci ? 'FOR UPDATE OF k' : ''}`, [id]);
    if (!r.rowCount) throw TDK();
    return r.rows[0];
  }

  async daftar(a: Akses, q: z.infer<typeof DaftarKoreksiQuery>) {
    const k = decodeKursor(q.cursor);
    return this.tx(a, async (c) => {
      const r = await c.query(
        `SELECT ${KOLOM} ${DARI} WHERE ($1::text IS NULL OR k.status = $1) AND ($2::uuid IS NULL OR k.person_id = $2) AND ($3::timestamptz IS NULL OR (k.created_at, k.id) < ($3::timestamptz, $4::uuid))
          ORDER BY k.created_at DESC, k.id DESC LIMIT $5`,
        [q.status ?? null, q.personId ?? null, k?.t ?? null, k?.id ?? null, q.limit + 1],
      );
      const ada = r.rows.length > q.limit;
      const baris = r.rows.slice(0, q.limit);
      return { items: baris.map(peta), nextCursor: ada ? encodeKursor({ t: baris[baris.length - 1].created_at_txt, id: baris[baris.length - 1].id }) : null };
    });
  }
  detail(a: Akses, id: string) {
    return this.tx(a, async (c) => peta(await this.muat(c, id)));
  }

  async buat(a: Akses, b: z.infer<typeof KoreksiBuat>) {
    const sekarang = this.jam();
    if (b.shiftDate > tanggalWib(sekarang)) throw new BadRequestException({ kode: 'TANGGAL_DI_MASA_DEPAN', message: 'Koreksi tidak dapat dibuat untuk tanggal yang belum tiba' });
    const hasil = await this.tx(a, async (c) => {
      const p = await c.query(`SELECT DISTINCT company_id FROM placements WHERE person_id = $1`, [b.personId]);
      if (!p.rowCount) throw new NotFoundException({ kode: 'PEKERJA_TIDAK_DITEMUKAN', message: 'Pekerja tidak ditemukan dalam perusahaan Anda' });
      if (p.rowCount > 1) throw konflik('PERUSAHAAN_AMBIGU', 'Pekerja memiliki penempatan di lebih dari satu perusahaan dalam scope Anda; pilih scope yang lebih sempit');
      const companyId = p.rows[0].company_id as string;
      if (b.recordId) {
        const r = await c.query(`SELECT 1 FROM attendance_records WHERE id = $1 AND person_id = $2 AND shift_date = $3::date`, [b.recordId, b.personId, b.shiftDate]);
        if (!r.rowCount) throw konflik('REKAMAN_TIDAK_SESUAI', 'Rekaman tidak sesuai dengan pekerja dan tanggal shift koreksi');
      }
      const dup = await c.query(`SELECT 1 FROM attendance_adjustments WHERE person_id = $1 AND shift_date = $2::date AND status = 'DIAJUKAN'`, [b.personId, b.shiftDate]);
      if (dup.rowCount) throw konflik('KOREKSI_SUDAH_DIAJUKAN', 'Sudah ada koreksi yang menunggu putusan untuk pekerja dan tanggal ini');
      await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`kor:${companyId}`]);
      const tahun = tanggalWib(sekarang).slice(0, 4);
      const urut = ((await c.query(`SELECT count(*)::int AS n FROM attendance_adjustments WHERE company_id = $1 AND adjustment_no LIKE $2`, [companyId, `KOR/${tahun}/%`])).rows[0].n as number) + 1;
      const nomor = `KOR/${tahun}/${String(urut).padStart(5, '0')}`;
      const id = (await c.query(
        `INSERT INTO attendance_adjustments (company_id, adjustment_no, person_id, shift_date, record_id, effect, reason, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [companyId, nomor, b.personId, b.shiftDate, b.recordId ?? null, b.effect, b.reason, a.userId],
      )).rows[0].id;
      return this.muat(c, id);
    });
    await this.audit.catat({ aksi: 'attendance.adjustment.created', aktorId: a.userId, companyId: hasil.company_id as string, objek: 'attendance_adjustment', objekId: hasil.id as string, detail: { nomor: hasil.adjustment_no, efek: b.effect } });
    return peta(hasil);
  }

  async ubah(a: Akses, id: string, b: z.infer<typeof KoreksiUbah>) {
    const hasil = await this.tx(a, async (c) => {
      const cur = await this.muat(c, id, true);
      if (cur.status !== 'DIAJUKAN') throw konflik('TRANSISI_TIDAK_VALID', 'Koreksi yang sudah diputuskan tidak dapat diubah');
      await c.query(`UPDATE attendance_adjustments SET effect = COALESCE($2, effect), reason = COALESCE($3, reason) WHERE id = $1 AND status = 'DIAJUKAN'`, [id, b.effect ?? null, b.reason ?? null]);
      return this.muat(c, id);
    });
    await this.audit.catat({ aksi: 'attendance.adjustment.updated', aktorId: a.userId, companyId: hasil.company_id as string, objek: 'attendance_adjustment', objekId: id, detail: { bidang: Object.keys(b) } });
    return peta(hasil);
  }

  async putuskan(a: Akses, id: string, b: z.infer<typeof KoreksiPutusan>) {
    const hasil = await this.tx(a, async (c) => {
      const cur = await this.muat(c, id, true);
      if (cur.status !== 'DIAJUKAN') throw konflik('TRANSISI_TIDAK_VALID', 'Koreksi ini sudah diputuskan');
      if (cur.created_by === a.userId) throw SOD();
      try {
        await c.query(`UPDATE attendance_adjustments SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4 WHERE id = $1 AND status = 'DIAJUKAN'`, [id, b.decision, a.userId, b.note]);
      } catch (e) {
        if ((e as { constraint?: string }).constraint === 'attendance_adjustments_sod') throw SOD();
        throw e;
      }
      return this.muat(c, id);
    });
    await this.audit.catat({ aksi: 'attendance.adjustment.decided', aktorId: a.userId, companyId: hasil.company_id as string, objek: 'attendance_adjustment', objekId: id, detail: { putusan: b.decision, nomor: hasil.adjustment_no } });
    return peta(hasil);
  }
}
