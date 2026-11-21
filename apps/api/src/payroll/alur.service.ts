import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { JAM_ABSENSI, JamAbsensi } from '../attendance/jam';
import { tanggalWib } from '../attendance/shift';
import type { Akses } from '../rbac/akses.service';
import { JenisRekap, wajibIzin } from './akses';
import { PayrollService } from './payroll.service';
import { GarisManualBuat, GarisUbah, KomponenBody, KomponenUbah } from './schemas';
import { BarisSnapshot, hashSnapshot, JenisKomponen } from './uang';

const konflik = (kode: string, message: string) => new ConflictException({ kode, message });
const tdk = (kode: string, message: string) => new NotFoundException({ kode, message });
const SOD = (pesan: string) => new ForbiddenException({ kode: 'PEMISAHAN_TUGAS', message: pesan });
type Baris = Record<string, unknown>;

const KOLOM_GARIS: Record<string, string> = {
  daysLeave: 'days_leave', overtimeHours: 'overtime_hours', note: 'note', daysPresent: 'days_present', daysAbsent: 'days_absent', daysPermit: 'days_permit', daysSick: 'days_sick',
  lateCount: 'late_count', earlyLeaveCount: 'early_leave_count', hoursWorked: 'hours_worked',
};
const KOLOM_MANUAL_SAJA = ['daysPresent', 'daysAbsent', 'daysPermit', 'daysSick', 'lateCount', 'earlyLeaveCount', 'hoursWorked'];

/**
 * Alur rekap payroll: penyuntingan masukan (DRAFT), verifikasi, persetujuan, finalisasi, dan koreksi resmi bernomor versi.
 * Pembuat, pemeriksa, penyetuju, dan finalisator HARUS orang berbeda (aplikasi + CHECK database); penyunting terakhir bukan pemeriksa.
 * Setelah diverifikasi isi dikunci trigger database; perubahan hanya lewat versi koreksi. Audit hanya memuat ID, versi, status, dan jenis (tanpa nominal).
 */
@Injectable()
export class AlurService {
  constructor(
    private readonly pay: PayrollService,
    private readonly audit: AuditService,
    @Inject(JAM_ABSENSI) private readonly jam: JamAbsensi,
  ) {}

  /** Isi kanonik rekap dari database (untuk hash). Nominal sebagai teks NUMERIC. */
  async snapshot(c: PoolClient, recapId: string): Promise<BarisSnapshot[]> {
    const l = (await c.query(
      `SELECT id, person_id, worker_name, source, days_present, days_absent, days_permit, days_sick, days_leave, late_count, early_leave_count, pending_count, hours_worked::text AS hw, overtime_hours::text AS ot, note
         FROM payroll_recap_lines WHERE recap_id = $1`,
      [recapId],
    )).rows;
    const k = (await c.query(`SELECT k.line_id, k.kind, k.name, k.amount::text AS amount FROM payroll_components k JOIN payroll_recap_lines l ON l.id = k.line_id WHERE l.recap_id = $1`, [recapId])).rows;
    return l.map((x) => ({
      personId: x.person_id, workerName: x.worker_name, source: x.source, daysPresent: x.days_present, daysAbsent: x.days_absent, daysPermit: x.days_permit, daysSick: x.days_sick, daysLeave: x.days_leave,
      lateCount: x.late_count, earlyLeaveCount: x.early_leave_count, pendingCount: x.pending_count, hoursWorked: x.hw, overtimeHours: x.ot, note: x.note,
      components: k.filter((y) => y.line_id === x.id).map((y) => ({ kind: y.kind as JenisKomponen, name: y.name, amount: y.amount })),
    }));
  }

  // ----- penyuntingan (DRAFT) -----
  private async draf(c: PoolClient, a: Akses, id: string): Promise<Baris> {
    const r = await this.pay.muatRekap(c, a, id, true);
    wajibIzin(a, r.kind as JenisRekap, 'create', 'update');
    if (r.status !== 'DRAFT') throw konflik('REKAP_TERKUNCI', 'Rekap hanya dapat disunting saat berstatus DRAFT; gunakan koreksi resmi setelah disetujui');
    return r;
  }
  private sentuh(c: PoolClient, id: string, userId: string) {
    return c.query(`UPDATE payroll_recaps SET last_edited_by = $2, updated_at = now() WHERE id = $1`, [id, userId]);
  }
  private async garis(c: PoolClient, recapId: string, lineId: string): Promise<Baris> {
    const r = await c.query(`SELECT id, company_id, source FROM payroll_recap_lines WHERE id = $1 AND recap_id = $2 FOR UPDATE`, [lineId, recapId]);
    if (!r.rowCount) throw tdk('BARIS_TIDAK_DITEMUKAN', 'Baris rekap tidak ditemukan');
    return r.rows[0];
  }
  private async auditSunting(a: Akses, r: Baris, aksi: string, detail: Record<string, unknown>) {
    await this.audit.catat({ aksi, aktorId: a.userId, companyId: r.company_id as string, objek: 'payroll_recap', objekId: r.id as string, detail });
  }

  async tambahKomponen(a: Akses, id: string, lineId: string, b: z.infer<typeof KomponenBody>) {
    const r = await this.pay.tx(a, async (c) => {
      const rekap = await this.draf(c, a, id);
      const g = await this.garis(c, id, lineId);
      await c.query(`INSERT INTO payroll_components (company_id, line_id, kind, name, amount) VALUES ($1, $2, $3, $4, $5)`, [g.company_id, lineId, b.kind, b.name, b.amount]);
      await this.sentuh(c, id, a.userId);
      return rekap;
    });
    await this.auditSunting(a, r, 'payroll.component.added', { jenis: b.kind });
    return this.pay.detailRekap(a, id);
  }
  async ubahKomponen(a: Akses, id: string, lineId: string, komponenId: string, b: z.infer<typeof KomponenUbah>) {
    const r = await this.pay.tx(a, async (c) => {
      const rekap = await this.draf(c, a, id);
      await this.garis(c, id, lineId);
      const u = await c.query(`UPDATE payroll_components SET kind = COALESCE($3, kind), name = COALESCE($4, name), amount = COALESCE($5::numeric, amount) WHERE id = $1 AND line_id = $2`, [komponenId, lineId, b.kind ?? null, b.name ?? null, b.amount ?? null]);
      if (!u.rowCount) throw tdk('KOMPONEN_TIDAK_DITEMUKAN', 'Komponen tidak ditemukan');
      await this.sentuh(c, id, a.userId);
      return rekap;
    });
    await this.auditSunting(a, r, 'payroll.component.updated', { bidang: Object.keys(b) });
    return this.pay.detailRekap(a, id);
  }
  async hapusKomponen(a: Akses, id: string, lineId: string, komponenId: string) {
    const r = await this.pay.tx(a, async (c) => {
      const rekap = await this.draf(c, a, id);
      await this.garis(c, id, lineId);
      const u = await c.query(`DELETE FROM payroll_components WHERE id = $1 AND line_id = $2`, [komponenId, lineId]);
      if (!u.rowCount) throw tdk('KOMPONEN_TIDAK_DITEMUKAN', 'Komponen tidak ditemukan');
      await this.sentuh(c, id, a.userId);
      return rekap;
    });
    await this.auditSunting(a, r, 'payroll.component.deleted', {});
    return this.pay.detailRekap(a, id);
  }

  async ubahGaris(a: Akses, id: string, lineId: string, b: z.infer<typeof GarisUbah>) {
    const r = await this.pay.tx(a, async (c) => {
      const rekap = await this.draf(c, a, id);
      const g = await this.garis(c, id, lineId);
      if (g.source === 'ATTENDANCE' && Object.keys(b).some((k) => KOLOM_MANUAL_SAJA.includes(k))) throw konflik('BARIS_ABSENSI_TERKUNCI', 'Angka absensi berasal dari snapshot absensi dan tidak dapat diubah manual; ubah lewat koreksi absensi lalu tarik ulang');
      const set = Object.keys(b).map((k, i) => `${KOLOM_GARIS[k]} = $${i + 2}`);
      await c.query(`UPDATE payroll_recap_lines SET ${set.join(', ')} WHERE id = $1`, [lineId, ...Object.values(b)]);
      await this.sentuh(c, id, a.userId);
      return rekap;
    });
    await this.auditSunting(a, r, 'payroll.line.updated', { bidang: Object.keys(b) });
    return this.pay.detailRekap(a, id);
  }
  async tambahGarisManual(a: Akses, id: string, b: z.infer<typeof GarisManualBuat>) {
    const r = await this.pay.tx(a, async (c) => {
      const rekap = await this.draf(c, a, id);
      if (rekap.kind !== 'INTERNAL') throw konflik('BARIS_MANUAL_HANYA_INTERNAL', 'Baris manual hanya untuk rekap internal; rekap rekanan bersumber dari absensi');
      const p = await c.query(`SELECT 1 FROM persons WHERE id = $1`, [b.personId]);
      if (!p.rowCount) throw tdk('ORANG_TIDAK_DITEMUKAN', 'Orang tidak ditemukan');
      try {
        await c.query(`INSERT INTO payroll_recap_lines (company_id, recap_id, person_id, worker_name, source) VALUES ($1, $2, $3, $4, 'MANUAL')`, [rekap.company_id, id, b.personId, b.workerName]);
      } catch (e) {
        if ((e as { constraint?: string }).constraint === 'payroll_recap_lines_orang_unik') throw konflik('BARIS_SUDAH_ADA', 'Orang ini sudah ada pada rekap');
        throw e;
      }
      await this.sentuh(c, id, a.userId);
      return rekap;
    });
    await this.auditSunting(a, r, 'payroll.line.added', {});
    return this.pay.detailRekap(a, id);
  }
  async hapusGarisManual(a: Akses, id: string, lineId: string) {
    const r = await this.pay.tx(a, async (c) => {
      const rekap = await this.draf(c, a, id);
      const g = await this.garis(c, id, lineId);
      if (g.source !== 'MANUAL') throw konflik('BARIS_ABSENSI_TERKUNCI', 'Baris dari snapshot absensi tidak dapat dihapus');
      await c.query(`DELETE FROM payroll_components WHERE line_id = $1`, [lineId]);
      await c.query(`DELETE FROM payroll_recap_lines WHERE id = $1`, [lineId]);
      await this.sentuh(c, id, a.userId);
      return rekap;
    });
    await this.auditSunting(a, r, 'payroll.line.deleted', {});
    return this.pay.detailRekap(a, id);
  }

  // ----- alur status -----
  /** Menggerakkan status dengan guard atomik (UPDATE ... WHERE status) dan riwayat hanya-tambah. */
  private async pindah(c: PoolClient, r: Baris, dari: string, ke: string, set: string, nilai: unknown[], aktor: string, alasan?: string) {
    const u = await c.query(`UPDATE payroll_recaps SET status = $2, ${set}${set ? ',' : ''} updated_at = now() WHERE id = $1 AND status = $${nilai.length + 3}`, [r.id, ke, ...nilai, dari]);
    if (!u.rowCount) throw konflik('TRANSISI_TIDAK_VALID', 'Status rekap sudah berubah');
    await this.pay.catatRiwayat(c, r, dari, ke, aktor, alasan);
  }
  private petaSod = (e: unknown, pesan: string) => {
    if ((e as { constraint?: string }).constraint === 'payroll_recaps_sod') throw SOD(pesan);
    throw e;
  };

  async verifikasi(a: Akses, id: string) {
    const r = await this.pay.tx(a, async (c) => {
      const r = await this.pay.muatRekap(c, a, id, true);
      wajibIzin(a, r.kind as JenisRekap, 'review');
      if (r.status !== 'DRAFT') throw konflik('TRANSISI_TIDAK_VALID', `Rekap berstatus ${r.status} tidak dapat diverifikasi`);
      if (r.created_by === a.userId || r.last_edited_by === a.userId) throw SOD('Pemeriksa tidak boleh sama dengan pembuat atau penyunting rekap');
      const n = (await c.query(`SELECT count(*)::int AS n FROM payroll_recap_lines WHERE recap_id = $1`, [id])).rows[0].n as number;
      if (n === 0) throw konflik('REKAP_KOSONG', 'Rekap belum memiliki baris');
      if (r.kind === 'PARTNER') {
        if (!r.pulled_at) throw konflik('ABSENSI_BELUM_DITARIK', 'Tarik absensi lebih dulu sebelum verifikasi');
        // Pemeriksaan LANGSUNG ke data absensi (bukan hanya snapshot): rekaman yang masih menunggu verifikasi harus diputuskan lebih dulu.
        const m = (await c.query(
          `SELECT count(*)::int AS n FROM attendance_effective WHERE company_id = $1 AND shift_date BETWEEN $2::date AND $3::date AND effective_status = 'PERLU_VERIFIKASI'`,
          [r.company_id, r.start_date, r.end_date],
        )).rows[0].n as number;
        if (m > 0) throw konflik('ABSENSI_BELUM_DIVERIFIKASI', `Masih ada ${m} rekaman absensi menunggu verifikasi pada periode ini. Selesaikan tinjauan absensi lalu tarik absensi ulang`);
      }
      try {
        await this.pindah(c, r, 'DRAFT', 'DIVERIFIKASI', 'reviewed_by = $3, reviewed_at = now()', [a.userId], a.userId, 'Diverifikasi');
      } catch (e) {
        this.petaSod(e, 'Pemeriksa tidak boleh sama dengan pembuat atau penyunting rekap');
      }
      return r;
    });
    await this.auditSunting(a, r, 'payroll.recap.verified', { versi: r.version_no });
    return this.pay.detailRekap(a, id);
  }

  async kembalikan(a: Akses, id: string, alasan: string) {
    const r = await this.pay.tx(a, async (c) => {
      const r = await this.pay.muatRekap(c, a, id, true);
      wajibIzin(a, r.kind as JenisRekap, 'review');
      if (r.status !== 'DIVERIFIKASI') throw konflik('TRANSISI_TIDAK_VALID', `Rekap berstatus ${r.status} tidak dapat dikembalikan`);
      await this.pindah(c, r, 'DIVERIFIKASI', 'DRAFT', 'reviewed_by = NULL, reviewed_at = NULL', [], a.userId, alasan);
      return r;
    });
    await this.auditSunting(a, r, 'payroll.recap.returned', { versi: r.version_no });
    return this.pay.detailRekap(a, id);
  }

  async setujui(a: Akses, id: string) {
    const r = await this.pay.tx(a, async (c) => {
      const r = await this.pay.muatRekap(c, a, id, true);
      if (r.status !== 'DIVERIFIKASI') throw konflik('TRANSISI_TIDAK_VALID', `Rekap berstatus ${r.status} tidak dapat disetujui`);
      if (r.created_by === a.userId || r.reviewed_by === a.userId) throw SOD('Penyetuju tidak boleh sama dengan pembuat atau pemeriksa rekap');
      const hash = hashSnapshot(await this.snapshot(c, id));
      try {
        await this.pindah(c, r, 'DIVERIFIKASI', 'DISETUJUI', 'approved_by = $3, approved_at = now(), snapshot_hash = $4', [a.userId, hash], a.userId, 'Disetujui');
      } catch (e) {
        this.petaSod(e, 'Penyetuju tidak boleh sama dengan pembuat atau pemeriksa rekap');
      }
      // Versi koreksi yang disetujui menggantikan versi sebelumnya (isi lama tetap utuh sebagai riwayat).
      const lama = await c.query(`SELECT id, company_id, status FROM payroll_recaps WHERE period_id = $1 AND version_no < $2 AND status IN ('DISETUJUI', 'DIFINALISASI') FOR UPDATE`, [r.period_id, r.version_no]);
      for (const x of lama.rows) {
        await c.query(`UPDATE payroll_recaps SET status = 'DIGANTIKAN', updated_at = now() WHERE id = $1`, [x.id]);
        await this.pay.catatRiwayat(c, x, x.status as string, 'DIGANTIKAN', a.userId, `Digantikan oleh versi ${r.version_no}`);
      }
      return r;
    });
    await this.auditSunting(a, r, 'payroll.recap.approved', { versi: r.version_no });
    return this.pay.detailRekap(a, id);
  }

  async finalisasi(a: Akses, id: string) {
    const r = await this.pay.tx(a, async (c) => {
      const r = await this.pay.muatRekap(c, a, id, true);
      if (r.status !== 'DISETUJUI') throw konflik('TRANSISI_TIDAK_VALID', `Rekap berstatus ${r.status} tidak dapat difinalisasi`);
      const orangLain = [r.created_by, r.reviewed_by, r.approved_by];
      if (orangLain.includes(a.userId)) throw SOD('Finalisator tidak boleh sama dengan pembuat, pemeriksa, atau penyetuju rekap');
      if (hashSnapshot(await this.snapshot(c, id)) !== r.snapshot_hash) throw konflik('INTEGRITAS_REKAP_GAGAL', 'Isi rekap tidak lagi sama dengan yang disetujui. Hentikan dan hubungi administrator');
      try {
        await this.pindah(c, r, 'DISETUJUI', 'DIFINALISASI', 'finalized_by = $3, finalized_at = now()', [a.userId], a.userId, 'Difinalisasi');
      } catch (e) {
        this.petaSod(e, 'Finalisator tidak boleh sama dengan pembuat, pemeriksa, atau penyetuju rekap');
      }
      return r;
    });
    await this.auditSunting(a, r, 'payroll.recap.finalized', { versi: r.version_no });
    return this.pay.detailRekap(a, id);
  }

  /** Koreksi resmi: versi baru bernomor (KRP/<tahun>/<urut>) berisi salinan versi sumber, berstatus DRAFT; versi lama utuh sampai versi baru disetujui. */
  async koreksi(a: Akses, id: string, alasan: string) {
    const hasil = await this.pay.tx(a, async (c) => {
      const sumber = await this.pay.muatRekap(c, a, id, true);
      wajibIzin(a, sumber.kind as JenisRekap, 'create');
      if (!['DISETUJUI', 'DIFINALISASI'].includes(sumber.status as string)) throw konflik('KOREKSI_TIDAK_VALID', 'Koreksi resmi hanya untuk rekap yang sudah disetujui atau difinalisasi');
      const terbaru = (await c.query(`SELECT max(version_no) AS v FROM payroll_recaps WHERE period_id = $1`, [sumber.period_id])).rows[0].v as number;
      if (terbaru !== sumber.version_no) throw konflik('VERSI_BUKAN_TERBARU', 'Koreksi hanya dapat dibuat dari versi terbaru');
      await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`krp:${sumber.company_id}`]);
      const tahun = tanggalWib(this.jam()).slice(0, 4);
      const urut = ((await c.query(`SELECT count(*)::int AS n FROM payroll_recaps WHERE company_id = $1 AND recap_number LIKE $2`, [sumber.company_id, `KRP/${tahun}/%`])).rows[0].n as number) + 1;
      const nomor = `KRP/${tahun}/${String(urut).padStart(5, '0')}`;
      let baruId: string;
      try {
        baruId = (await c.query(
          `INSERT INTO payroll_recaps (company_id, period_id, version_no, recap_number, correction_reason, created_by, pulled_at) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [sumber.company_id, sumber.period_id, terbaru + 1, nomor, alasan, a.userId, sumber.pulled_at],
        )).rows[0].id;
      } catch (e) {
        if ((e as { constraint?: string }).constraint === 'payroll_recaps_satu_terbuka') throw konflik('KOREKSI_SUDAH_TERBUKA', 'Sudah ada versi koreksi yang belum selesai untuk periode ini');
        throw e;
      }
      await c.query(
        `INSERT INTO payroll_recap_lines (company_id, recap_id, person_id, worker_name, source, days_present, days_absent, days_permit, days_sick, days_leave, late_count, early_leave_count, pending_count, hours_worked, overtime_hours, note)
         SELECT company_id, $2, person_id, worker_name, source, days_present, days_absent, days_permit, days_sick, days_leave, late_count, early_leave_count, pending_count, hours_worked, overtime_hours, note
           FROM payroll_recap_lines WHERE recap_id = $1`,
        [id, baruId],
      );
      await c.query(
        `INSERT INTO payroll_components (company_id, line_id, kind, name, amount)
         SELECT k.company_id, nl.id, k.kind, k.name, k.amount FROM payroll_components k JOIN payroll_recap_lines ol ON ol.id = k.line_id JOIN payroll_recap_lines nl ON nl.recap_id = $2 AND nl.person_id = ol.person_id WHERE ol.recap_id = $1`,
        [id, baruId],
      );
      const baru = await this.pay.muatRekap(c, a, baruId);
      await this.pay.catatRiwayat(c, baru, null, 'DRAFT', a.userId, `Koreksi resmi dari versi ${sumber.version_no}: ${alasan}`);
      return { baru, sumber };
    });
    await this.audit.catat({ aksi: 'payroll.recap.corrected', aktorId: a.userId, companyId: hasil.baru.company_id as string, objek: 'payroll_recap', objekId: hasil.baru.id as string, detail: { dariVersi: hasil.sumber.version_no, nomor: hasil.baru.recap_number } });
    return this.pay.detailRekap(a, hasil.baru.id as string);
  }
}
