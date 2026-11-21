import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { decodeKursor, encodeKursor } from '../admin/kursor';
import { AuditService } from '../audit/audit.service';
import { RecapService } from '../attendance/recap.service';
import { ScopedDb } from '../database/scoped-db';
import type { Akses } from '../rbac/akses.service';
import { JenisRekap, jenisTerlihat, punyaIzin, wajibIzin } from './akses';
import { DaftarPeriodeQuery, PeriodeBuat } from './schemas';
import { subtotalPerJenis } from './uang';

const konflik = (kode: string, message: string) => new ConflictException({ kode, message });
const tdk = (kode: string, message: string) => new NotFoundException({ kode, message });
type Baris = Record<string, unknown>;
export const BATAS_BARIS_TARIK = 20000;

const KOLOM_REKAP = `r.id, r.company_id, r.period_id, r.version_no, r.recap_number, r.correction_reason, r.status, r.created_by, r.last_edited_by, r.reviewed_by, r.reviewed_at, r.approved_by, r.approved_at,
  r.finalized_by, r.finalized_at, r.snapshot_hash, r.pulled_at, r.created_at, p.kind, p.label, p.start_date::text AS start_date, p.end_date::text AS end_date`;

/** Periode dan rekap payroll TAHAP AWAL: hanya rekap dan masukan. Tidak ada hitung gaji final, PPh 21, BPJS, slip, atau pembayaran. */
@Injectable()
export class PayrollService {
  constructor(
    private readonly sdb: ScopedDb,
    private readonly audit: AuditService,
    private readonly recap: RecapService,
  ) {}

  tx<T>(a: Akses, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    return this.sdb.tx({ companyIds: a.companyIds }, fn);
  }
  private perusahaan(a: Akses, id?: string): string {
    const companyId = id ?? (a.companyIds.length === 1 ? a.companyIds[0] : undefined);
    if (!companyId) throw konflik('PERUSAHAAN_WAJIB', 'Pilih perusahaan');
    if (!a.companyIds.includes(companyId)) throw tdk('PERUSAHAAN_TIDAK_DITEMUKAN', 'Perusahaan tidak ditemukan');
    return companyId;
  }

  async catatRiwayat(c: PoolClient, r: Baris, dari: string | null, ke: string, aktor: string, alasan?: string | null) {
    await c.query(`INSERT INTO payroll_recap_status_histories (company_id, recap_id, from_status, to_status, actor_user_id, reason) VALUES ($1, $2, $3, $4, $5, $6)`, [r.company_id, r.id, dari, ke, aktor, alasan ?? null]);
  }

  /** Memuat rekap beserta periode; memeriksa jenis boleh dilihat pemanggil. */
  async muatRekap(c: PoolClient, a: Akses, id: string, kunci = false): Promise<Baris> {
    const r = await c.query(`SELECT ${KOLOM_REKAP} FROM payroll_recaps r JOIN payroll_periods p ON p.id = r.period_id WHERE r.id = $1 ${kunci ? 'FOR UPDATE OF r' : ''}`, [id]);
    if (!r.rowCount) throw tdk('REKAP_TIDAK_DITEMUKAN', 'Rekap payroll tidak ditemukan');
    wajibIzin(a, r.rows[0].kind as JenisRekap, 'view', 'create', 'update', 'review', 'export');
    return r.rows[0];
  }

  private petaRekap = (r: Baris) => ({
    id: r.id, companyId: r.company_id, periodId: r.period_id, kind: r.kind, label: r.label, startDate: r.start_date, endDate: r.end_date, versionNo: r.version_no, recapNumber: r.recap_number,
    correctionReason: r.correction_reason, status: r.status, createdBy: r.created_by, lastEditedBy: r.last_edited_by, reviewedBy: r.reviewed_by, reviewedAt: r.reviewed_at, approvedBy: r.approved_by,
    approvedAt: r.approved_at, finalizedBy: r.finalized_by, finalizedAt: r.finalized_at, snapshotHash: r.snapshot_hash, pulledAt: r.pulled_at, createdAt: r.created_at,
  });

  async daftarPeriode(a: Akses, q: z.infer<typeof DaftarPeriodeQuery>) {
    const jenis = jenisTerlihat(a).filter((k) => !q.kind || q.kind === k);
    if (!jenis.length) return { items: [], nextCursor: null };
    const k = decodeKursor(q.cursor);
    return this.tx(a, async (c) => {
      const r = await c.query(
        `SELECT p.id, p.company_id, p.kind, p.label, p.start_date::text AS start_date, p.end_date::text AS end_date, p.created_at, p.created_at::text AS created_txt,
                (SELECT x.id FROM payroll_recaps x WHERE x.period_id = p.id ORDER BY x.version_no DESC LIMIT 1) AS recap_id,
                (SELECT x.status FROM payroll_recaps x WHERE x.period_id = p.id ORDER BY x.version_no DESC LIMIT 1) AS status,
                (SELECT max(x.version_no) FROM payroll_recaps x WHERE x.period_id = p.id) AS version_no
           FROM payroll_periods p WHERE p.kind = ANY($1::text[]) AND ($2::timestamptz IS NULL OR (p.created_at, p.id) < ($2::timestamptz, $3::uuid))
          ORDER BY p.created_at DESC, p.id DESC LIMIT $4`,
        [jenis, k?.t ?? null, k?.id ?? null, q.limit + 1],
      );
      const ada = r.rows.length > q.limit;
      const baris = r.rows.slice(0, q.limit);
      return {
        items: baris.map((x) => ({ id: x.id, companyId: x.company_id, kind: x.kind, label: x.label, startDate: x.start_date, endDate: x.end_date, recapId: x.recap_id, status: x.status, versionNo: x.version_no, createdAt: x.created_at })),
        nextCursor: ada ? encodeKursor({ t: baris[baris.length - 1].created_txt, id: baris[baris.length - 1].id }) : null,
      };
    });
  }

  async buatPeriode(a: Akses, b: z.infer<typeof PeriodeBuat>) {
    wajibIzin(a, b.kind, 'create');
    const companyId = this.perusahaan(a, b.companyId);
    const hasil = await this.tx(a, async (c) => {
      let periodId: string;
      try {
        periodId = (await c.query(`INSERT INTO payroll_periods (company_id, kind, label, start_date, end_date, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`, [companyId, b.kind, b.label, b.startDate, b.endDate, a.userId])).rows[0].id;
      } catch (e) {
        if ((e as { constraint?: string }).constraint === 'payroll_periods_tanpa_tumpang_tindih') throw konflik('PERIODE_TUMPANG_TINDIH', 'Periode tumpang tindih dengan periode lain untuk perusahaan dan jenis yang sama');
        throw e;
      }
      const id = (await c.query(`INSERT INTO payroll_recaps (company_id, period_id, version_no, created_by) VALUES ($1, $2, 1, $3) RETURNING id`, [companyId, periodId, a.userId])).rows[0].id as string;
      const rekap = await this.muatRekap(c, a, id);
      await this.catatRiwayat(c, rekap, null, 'DRAFT', a.userId, 'Periode dibuka');
      return rekap;
    });
    await this.audit.catat({ aksi: 'payroll.period.created', aktorId: a.userId, companyId, objek: 'payroll_recap', objekId: hasil.id as string, detail: { jenis: b.kind, mulai: b.startDate, akhir: b.endDate } });
    return this.petaRekap(hasil);
  }

  async detailPeriode(a: Akses, periodId: string) {
    return this.tx(a, async (c) => {
      const p = await c.query(`SELECT id, company_id, kind, label, start_date::text AS start_date, end_date::text AS end_date FROM payroll_periods WHERE id = $1`, [periodId]);
      if (!p.rowCount) throw tdk('PERIODE_TIDAK_DITEMUKAN', 'Periode payroll tidak ditemukan');
      wajibIzin(a, p.rows[0].kind, 'view', 'create', 'update', 'review', 'export');
      const v = await c.query(`SELECT id, version_no, recap_number, status, created_at FROM payroll_recaps WHERE period_id = $1 ORDER BY version_no DESC`, [periodId]);
      const x = p.rows[0];
      return { id: x.id, companyId: x.company_id, kind: x.kind, label: x.label, startDate: x.start_date, endDate: x.end_date, versions: v.rows.map((y) => ({ id: y.id, versionNo: y.version_no, recapNumber: y.recap_number, status: y.status, createdAt: y.created_at })) };
    });
  }

  /** Rekap lengkap (baris + komponen + subtotal per jenis). Nominal berupa teks desimal; tidak ada total gaji/neto. */
  async detailRekap(a: Akses, id: string) {
    return this.tx(a, async (c) => {
      const r = await this.muatRekap(c, a, id);
      return this.penuh(c, r);
    });
  }
  async penuh(c: PoolClient, r: Baris) {
    const baris = (await c.query(
      `SELECT l.id, l.person_id, l.worker_name, l.source, l.days_present, l.days_absent, l.days_permit, l.days_sick, l.days_leave, l.late_count, l.early_leave_count, l.pending_count,
              l.hours_worked::text AS hours_worked, l.overtime_hours::text AS overtime_hours, l.note
         FROM payroll_recap_lines l WHERE l.recap_id = $1 ORDER BY l.worker_name, l.person_id LIMIT 5001`,
      [r.id],
    )).rows;
    if (baris.length > 5000) throw new UnprocessableEntityException({ kode: 'REKAP_TERLALU_BESAR', message: 'Rekap melebihi 5.000 baris' });
    const komp = (await c.query(`SELECT k.id, k.line_id, k.kind, k.name, k.amount::text AS amount FROM payroll_components k JOIN payroll_recap_lines l ON l.id = k.line_id WHERE l.recap_id = $1 ORDER BY k.kind, k.name, k.id`, [r.id])).rows;
    const per = new Map<string, Baris[]>();
    for (const k of komp) per.set(k.line_id as string, [...(per.get(k.line_id as string) ?? []), k]);
    const lines = baris.map((l) => {
      const ks = per.get(l.id as string) ?? [];
      return {
        id: l.id, personId: l.person_id, workerName: l.worker_name, source: l.source, daysPresent: l.days_present, daysAbsent: l.days_absent, daysPermit: l.days_permit, daysSick: l.days_sick, daysLeave: l.days_leave,
        lateCount: l.late_count, earlyLeaveCount: l.early_leave_count, pendingCount: l.pending_count, hoursWorked: l.hours_worked, overtimeHours: l.overtime_hours, note: l.note,
        components: ks.map((k) => ({ id: k.id, kind: k.kind, name: k.name, amount: k.amount })),
        subtotals: subtotalPerJenis(ks as { kind: 'TUNJANGAN' | 'POTONGAN' | 'INSENTIF'; amount: string }[]),
      };
    });
    return { ...this.petaRekap(r), lineCount: lines.length, pendingCount: lines.reduce((s, l) => s + (l.pendingCount as number), 0), totals: subtotalPerJenis(komp as { kind: 'TUNJANGAN' | 'POTONGAN' | 'INSENTIF'; amount: string }[]), lines };
  }

  /**
   * Snapshot absensi (hanya DRAFT, jenis PARTNER, idempoten): menyalin per orang hari hadir/tidak hadir/izin/sakit, terlambat, pulang cepat, jam kerja, dan jumlah rekaman
   * menunggu verifikasi dari REKAP ABSENSI yang sama (rekaman efektif + putusan tinjauan + koreksi disetujui). Komponen dan masukan manual dipertahankan.
   */
  async tarikAbsensi(a: Akses, id: string) {
    const hasil = await this.tx(a, async (c) => {
      const r = await this.muatRekap(c, a, id, true);
      wajibIzin(a, r.kind as JenisRekap, 'create', 'update');
      if (r.status !== 'DRAFT') throw konflik('REKAP_TERKUNCI', 'Absensi hanya dapat ditarik saat rekap berstatus DRAFT');
      if (r.kind !== 'PARTNER') throw konflik('REKAP_INTERNAL_MANUAL', 'Rekap internal tidak memiliki sumber absensi QR; isi masukan secara manual');
      const rows = await this.recap.ambil(c, { from: r.start_date as string, to: r.end_date as string }, BATAS_BARIS_TARIK + 1, null);
      if (rows.length > BATAS_BARIS_TARIK) throw new UnprocessableEntityException({ kode: 'ABSENSI_TERLALU_BESAR', message: 'Data absensi periode ini terlalu besar untuk ditarik sekaligus' });
      const orang = new Map<string, { nama: string; hadir: number; tidak: number; izin: number; sakit: number; telat: number; cepat: number; tunggu: number; menit: number }>();
      for (const x of rows) {
        const o = orang.get(x.person_id as string) ?? { nama: x.worker_name as string, hadir: 0, tidak: 0, izin: 0, sakit: 0, telat: 0, cepat: 0, tunggu: 0, menit: 0 };
        const s = x.status_hari as string;
        if (s === 'HADIR') o.hadir += 1;
        else if (s === 'TIDAK_HADIR') o.tidak += 1;
        else if (s === 'IZIN') o.izin += 1;
        else if (s === 'SAKIT') o.sakit += 1;
        const penanda = (x.penanda as string[]) ?? [];
        if (penanda.includes('TERLAMBAT')) o.telat += 1;
        if (penanda.includes('PULANG_CEPAT')) o.cepat += 1;
        o.tunggu += x.menunggu as number;
        if (!x.dikoreksi && x.masuk_at && x.pulang_at) o.menit += Math.max(0, Math.round(((x.pulang_at as Date).getTime() - (x.masuk_at as Date).getTime()) / 60000));
        orang.set(x.person_id as string, o);
      }
      const jam = (menit: number) => `${Math.floor(menit / 60)}.${String(Math.round(((menit % 60) * 100) / 60)).padStart(2, '0')}`; // menit -> jam desimal tanpa float biner
      for (const [personId, o] of orang) {
        await c.query(
          `INSERT INTO payroll_recap_lines (company_id, recap_id, person_id, worker_name, source, days_present, days_absent, days_permit, days_sick, late_count, early_leave_count, pending_count, hours_worked)
           VALUES ($1, $2, $3, $4, 'ATTENDANCE', $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (recap_id, person_id) DO UPDATE SET worker_name = EXCLUDED.worker_name, days_present = EXCLUDED.days_present, days_absent = EXCLUDED.days_absent, days_permit = EXCLUDED.days_permit,
             days_sick = EXCLUDED.days_sick, late_count = EXCLUDED.late_count, early_leave_count = EXCLUDED.early_leave_count, pending_count = EXCLUDED.pending_count, hours_worked = EXCLUDED.hours_worked`,
          [r.company_id, id, personId, o.nama, o.hadir, o.tidak, o.izin, o.sakit, o.telat, o.cepat, o.tunggu, jam(o.menit)],
        );
      }
      // Orang yang sebelumnya ada tetapi kini tidak punya data: angka absensi dinolkan (komponen dan masukan manual tetap).
      await c.query(
        `UPDATE payroll_recap_lines SET days_present = 0, days_absent = 0, days_permit = 0, days_sick = 0, late_count = 0, early_leave_count = 0, pending_count = 0, hours_worked = 0
          WHERE recap_id = $1 AND source = 'ATTENDANCE' AND NOT (person_id = ANY($2::uuid[]))`,
        [id, [...orang.keys()]],
      );
      await c.query(`UPDATE payroll_recaps SET pulled_at = now(), last_edited_by = $2, updated_at = now() WHERE id = $1`, [id, a.userId]);
      return { r, jumlah: orang.size };
    });
    await this.audit.catat({ aksi: 'payroll.recap.pulled', aktorId: a.userId, companyId: hasil.r.company_id as string, objek: 'payroll_recap', objekId: id, detail: { jumlahOrang: hasil.jumlah } });
    return this.detailRekap(a, id);
  }

  /** Dipakai layanan alur (8C): memastikan pemanggil boleh menyunting jenis rekap. */
  bolehSunting(a: Akses, kind: JenisRekap) {
    if (!punyaIzin(a, kind, 'create', 'update')) throw new ForbiddenException({ kode: 'IZIN_DITOLAK', message: 'Anda tidak memiliki izin untuk tindakan ini' });
  }
  paksaBadRequest(pesan: string): never {
    throw new BadRequestException({ kode: 'PERMINTAAN_TIDAK_VALID', message: pesan });
  }
}
