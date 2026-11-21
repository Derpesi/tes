import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { decodeKursor, encodeKursor } from '../admin/kursor';
import { AuditService } from '../audit/audit.service';
import { ScopedDb } from '../database/scoped-db';
import type { Akses } from '../rbac/akses.service';
import { ContractLifecycleService, hariIni } from '../pkwt/lifecycle.service';
import { AlasanBody, DaftarPenempatanQuery, PenempatanBuat, PindahBody } from './schemas';

const TDK = () => new NotFoundException({ kode: 'PENEMPATAN_TIDAK_DITEMUKAN', message: 'Penempatan tidak ditemukan' });
const konflik = (kode: string, message: string) => new ConflictException({ kode, message });
const TUMPANG = () => konflik('PENEMPATAN_TUMPANG_TINDIH', 'Pekerja sudah memiliki penempatan lain pada periode yang sama');

const KOLOM = `p.id, p.company_id, p.person_id, p.contract_id, p.location_id, p.start_date::text AS start_date, p.end_date::text AS end_date, p.status, p.note, p.created_by, p.approved_by, p.approved_at,
  p.replaced_by_id, p.created_at, p.created_at::text AS created_at_txt, p.updated_at`;
type Baris = Record<string, unknown>;
const peta = (r: Baris) => ({
  id: r.id, companyId: r.company_id, contractId: r.contract_id, contractNumber: r.contract_number, locationId: r.location_id, locationName: r.location_name, workerName: r.full_name,
  startDate: r.start_date, endDate: r.end_date, status: r.status, note: r.note, createdBy: r.created_by, approvedBy: r.approved_by, approvedAt: r.approved_at, replacedById: r.replaced_by_id, createdAt: r.created_at,
});

/**
 * Penempatan pekerja ke lokasi rekanan (master data internal; rekanan tidak punya akun). Dua penempatan non-final yang tumpang tindih ditolak
 * DATABASE (exclusion constraint). Disetujui Mgr Ops (placement.approve), penyetuju ≠ pembuat (aplikasi + database). Aktivasi saat kontrak
 * AKTIF dan tanggal mulai tiba dilakukan siklus hidup (ContractLifecycleService), yang juga menyinkronkan status member.
 */
@Injectable()
export class PlacementsService {
  constructor(
    private readonly sdb: ScopedDb,
    private readonly audit: AuditService,
    private readonly siklus: ContractLifecycleService,
  ) {}

  private tx<T>(a: Akses, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    return this.sdb.tx({ companyIds: a.companyIds }, fn);
  }

  private async muat(c: PoolClient, id: string, kunci = false): Promise<Baris> {
    const r = await c.query(
      `SELECT ${KOLOM}, k.contract_number, l.name AS location_name, m.full_name FROM placements p
         LEFT JOIN employment_contracts k ON k.id = p.contract_id LEFT JOIN partner_locations l ON l.id = p.location_id LEFT JOIN member_profiles m ON m.person_id = p.person_id
        WHERE p.id = $1 ${kunci ? 'FOR UPDATE OF p' : ''}`,
      [id],
    );
    if (!r.rowCount) throw TDK();
    return r.rows[0];
  }
  private async catat(c: PoolClient, p: Baris, dari: string | null, ke: string, aktor: string, alasan?: string | null) {
    await c.query(`INSERT INTO placement_status_histories (company_id, placement_id, from_status, to_status, actor_user_id, reason) VALUES ($1, $2, $3, $4, $5, $6)`, [p.company_id, p.id, dari, ke, aktor, alasan ?? null]);
  }
  private async pindahStatus(c: PoolClient, p: Baris, dari: string[], ke: string, set = '', nilai: unknown[] = []) {
    const r = await c.query(`UPDATE placements SET status = $2, ${set}${set ? ',' : ''} updated_at = now() WHERE id = $1 AND status = ANY($${nilai.length + 3}::text[])`, [p.id, ke, ...nilai, dari]);
    if (!r.rowCount) throw konflik('TRANSISI_TIDAK_VALID', 'Status penempatan sudah berubah');
  }
  private lihat(p: Baris, dari: string[], aksi: string) {
    if (!dari.includes(p.status as string)) throw konflik('TRANSISI_TIDAK_VALID', `Penempatan berstatus ${p.status} tidak dapat ${aksi}`);
  }

  async daftar(a: Akses, q: z.infer<typeof DaftarPenempatanQuery>) {
    const k = decodeKursor(q.cursor);
    return this.tx(a, async (c) => {
      const r = await c.query(
        `SELECT ${KOLOM}, k.contract_number, l.name AS location_name, m.full_name FROM placements p
           LEFT JOIN employment_contracts k ON k.id = p.contract_id LEFT JOIN partner_locations l ON l.id = p.location_id LEFT JOIN member_profiles m ON m.person_id = p.person_id
          WHERE ($1::text IS NULL OR p.status = $1) AND ($2::uuid IS NULL OR p.contract_id = $2) AND ($3::uuid IS NULL OR p.location_id = $3)
            AND ($4::timestamptz IS NULL OR (p.created_at, p.id) < ($4::timestamptz, $5::uuid))
          ORDER BY p.created_at DESC, p.id DESC LIMIT $6`,
        [q.status ?? null, q.contractId ?? null, q.locationId ?? null, k?.t ?? null, k?.id ?? null, q.limit + 1],
      );
      const ada = r.rows.length > q.limit;
      const baris = r.rows.slice(0, q.limit);
      return { items: baris.map(peta), nextCursor: ada ? encodeKursor({ t: baris[baris.length - 1].created_at_txt, id: baris[baris.length - 1].id }) : null };
    });
  }

  async detail(a: Akses, id: string) {
    return this.tx(a, async (c) => {
      const p = await this.muat(c, id);
      const h = await c.query(`SELECT from_status, to_status, reason, created_at FROM placement_status_histories WHERE placement_id = $1 ORDER BY created_at DESC, id DESC LIMIT 100`, [id]);
      return { ...peta(p), history: h.rows.map((x) => ({ from: x.from_status, to: x.to_status, reason: x.reason, createdAt: x.created_at })) };
    });
  }

  async buat(a: Akses, b: z.infer<typeof PenempatanBuat>) {
    const hasil = await this.tx(a, async (c) => {
      const k = await c.query(`SELECT id, company_id, person_id, status, start_date::text AS start_date, end_date::text AS end_date FROM employment_contracts WHERE id = $1 FOR SHARE`, [b.contractId]);
      if (!k.rowCount) throw new NotFoundException({ kode: 'KONTRAK_TIDAK_DITEMUKAN', message: 'Kontrak tidak ditemukan' });
      const kon = k.rows[0];
      if (['DIBATALKAN', 'BERAKHIR', 'DIAKHIRI_LEBIH_AWAL'].includes(kon.status)) throw konflik('KONTRAK_TIDAK_BERJALAN', `Kontrak berstatus ${kon.status} tidak dapat ditempatkan`);
      const l = await c.query(`SELECT 1 FROM partner_locations WHERE id = $1 AND company_id = $2 AND status = 'AKTIF'`, [b.locationId, kon.company_id]);
      if (!l.rowCount) throw new NotFoundException({ kode: 'LOKASI_TIDAK_DITEMUKAN', message: 'Lokasi tidak ditemukan atau tidak aktif' });
      const akhir = b.endDate ?? kon.end_date;
      if (b.startDate < kon.start_date || akhir > kon.end_date) throw konflik('PERIODE_DI_LUAR_KONTRAK', 'Periode penempatan harus berada dalam periode kontrak');
      if (akhir < b.startDate) throw new BadRequestException({ kode: 'PERIODE_TIDAK_VALID', message: 'Tanggal selesai tidak boleh sebelum tanggal mulai' });
      let id: string;
      try {
        id = (await c.query(
          `INSERT INTO placements (company_id, person_id, contract_id, location_id, start_date, end_date, note, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [kon.company_id, kon.person_id, kon.id, b.locationId, b.startDate, akhir, b.note ?? null, a.userId],
        )).rows[0].id;
      } catch (e) {
        if ((e as { constraint?: string }).constraint === 'placements_tanpa_tumpang_tindih') throw TUMPANG();
        throw e;
      }
      const p = await this.muat(c, id);
      await this.catat(c, p, null, 'DIRENCANAKAN', a.userId, 'Dibuat');
      return p;
    });
    await this.audit.catat({ aksi: 'placement.created', aktorId: a.userId, companyId: hasil.company_id as string, objek: 'placement', objekId: hasil.id as string });
    return peta(hasil);
  }

  /** Persetujuan Mgr Ops: DIRENCANAKAN -> MENUNGGU_KONTRAK (aktif otomatis bila kontrak sudah AKTIF dan tanggal mulai tiba). */
  async setujui(a: Akses, id: string) {
    const p = await this.tx(a, async (c) => {
      const cur = await this.muat(c, id, true);
      this.lihat(cur, ['DIRENCANAKAN'], 'disetujui');
      if (cur.created_by === a.userId) throw new ForbiddenException({ kode: 'PEMISAHAN_TUGAS', message: 'Penyetuju tidak boleh sama dengan pembuat penempatan' });
      await this.pindahStatus(c, cur, ['DIRENCANAKAN'], 'MENUNGGU_KONTRAK', 'approved_by = $3, approved_at = now()', [a.userId]);
      await this.catat(c, cur, 'DIRENCANAKAN', 'MENUNGGU_KONTRAK', a.userId, 'Disetujui');
      return cur;
    });
    await this.audit.catat({ aksi: 'placement.approved', aktorId: a.userId, companyId: p.company_id as string, objek: 'placement', objekId: id });
    await this.picu(p.person_id as string);
    return { status: 'MENUNGGU_KONTRAK' };
  }

  async tangguhkan(a: Akses, id: string, b: z.infer<typeof AlasanBody>) {
    return this.ubah(a, id, ['AKTIF'], 'DITANGGUHKAN', 'ditangguhkan', 'placement.suspended', b.reason);
  }
  async lanjutkan(a: Akses, id: string) {
    const hasil = await this.ubah(a, id, ['DITANGGUHKAN'], 'AKTIF', 'dilanjutkan', 'placement.resumed', 'Dilanjutkan', async (c, p) => {
      const k = await c.query(`SELECT status FROM employment_contracts WHERE id = $1`, [p.contract_id]);
      if (k.rows[0]?.status !== 'AKTIF') throw konflik('KONTRAK_TIDAK_AKTIF', 'Penempatan hanya dapat dilanjutkan bila kontraknya aktif');
    });
    return hasil;
  }
  async selesaikan(a: Akses, id: string, b: z.infer<typeof AlasanBody>) {
    return this.ubah(a, id, ['AKTIF', 'DITANGGUHKAN'], 'SELESAI', 'diselesaikan', 'placement.completed', b.reason, undefined, 'end_date = GREATEST(start_date, LEAST(COALESCE(end_date, $3::date), $3::date))', [hariIni(new Date())]);
  }
  async batalkan(a: Akses, id: string, b: z.infer<typeof AlasanBody>) {
    return this.ubah(a, id, ['DIRENCANAKAN', 'MENUNGGU_KONTRAK'], 'DIBATALKAN', 'dibatalkan', 'placement.cancelled', b.reason);
  }

  private async ubah(a: Akses, id: string, dari: string[], ke: string, kata: string, auditAksi: string, alasan: string, cek?: (c: PoolClient, p: Baris) => Promise<void>, set = '', nilai: unknown[] = []) {
    const p = await this.tx(a, async (c) => {
      const cur = await this.muat(c, id, true);
      this.lihat(cur, dari, kata);
      if (cek) await cek(c, cur);
      await this.pindahStatus(c, cur, dari, ke, set, nilai);
      await this.catat(c, cur, cur.status as string, ke, a.userId, alasan);
      return cur;
    });
    await this.audit.catat({ aksi: auditAksi, aktorId: a.userId, companyId: p.company_id as string, objek: 'placement', objekId: id });
    await this.picu(p.person_id as string);
    return { status: ke };
  }

  /** Memindahkan pekerja: penempatan lama berakhir H-1 dan penempatan baru (DIRENCANAKAN, perlu persetujuan) dimulai pada tanggal pindah. */
  async pindahkan(a: Akses, id: string, b: z.infer<typeof PindahBody>) {
    const hasil = await this.tx(a, async (c) => {
      const lama = await this.muat(c, id, true);
      this.lihat(lama, ['AKTIF'], 'dipindahkan (hanya penempatan AKTIF)');
      if (!(b.moveDate > (lama.start_date as string) && (!lama.end_date || b.moveDate <= (lama.end_date as string)))) throw konflik('TANGGAL_PINDAH_TIDAK_VALID', 'Tanggal pindah harus setelah tanggal mulai dan tidak melewati tanggal selesai penempatan');
      if (b.locationId === lama.location_id) throw konflik('LOKASI_SAMA', 'Lokasi baru sama dengan lokasi sekarang');
      const l = await c.query(`SELECT 1 FROM partner_locations WHERE id = $1 AND company_id = $2 AND status = 'AKTIF'`, [b.locationId, lama.company_id]);
      if (!l.rowCount) throw new NotFoundException({ kode: 'LOKASI_TIDAK_DITEMUKAN', message: 'Lokasi tidak ditemukan atau tidak aktif' });
      const hariSebelum = new Date(Date.parse(`${b.moveDate}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
      const akhirAsli = lama.end_date as string | null;
      await c.query(`UPDATE placements SET end_date = $2, updated_at = now() WHERE id = $1`, [id, hariSebelum]);
      let baruId: string;
      try {
        baruId = (await c.query(
          `INSERT INTO placements (company_id, person_id, contract_id, location_id, start_date, end_date, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [lama.company_id, lama.person_id, lama.contract_id, b.locationId, b.moveDate, akhirAsli, a.userId],
        )).rows[0].id;
      } catch (e) {
        if ((e as { constraint?: string }).constraint === 'placements_tanpa_tumpang_tindih') throw TUMPANG();
        throw e;
      }
      await c.query(`UPDATE placements SET replaced_by_id = $2 WHERE id = $1`, [id, baruId]);
      await this.catat(c, lama, 'AKTIF', 'AKTIF', a.userId, `Dipindahkan mulai ${b.moveDate}: ${b.reason}`);
      const baru = await this.muat(c, baruId);
      await this.catat(c, baru, null, 'DIRENCANAKAN', a.userId, `Pengganti penempatan sebelumnya: ${b.reason}`);
      return { lama, baru };
    });
    await this.audit.catat({ aksi: 'placement.moved', aktorId: a.userId, companyId: hasil.lama.company_id as string, objek: 'placement', objekId: id, detail: { pengganti: hasil.baru.id } });
    return peta(hasil.baru);
  }

  private async picu(personId: string) {
    try {
      await this.siklus.prosesOrang(personId, new Date());
    } catch {
      /* worker interval menyusul; operasi utama sudah tersimpan */
    }
  }
}
