import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { decodeKursor, encodeKursor } from '../admin/kursor';
import { AuditService } from '../audit/audit.service';
import { ScopedDb } from '../database/scoped-db';
import type { Akses } from '../rbac/akses.service';
import { DaftarLowonganQuery, LowonganBuat, LowonganUbah } from './schemas';

const TDK_LOWONGAN = () => new NotFoundException({ kode: 'LOWONGAN_TIDAK_DITEMUKAN', message: 'Lowongan tidak ditemukan' });
const TDK_LOKASI = () => new NotFoundException({ kode: 'LOKASI_TIDAK_DITEMUKAN', message: 'Lokasi tidak ditemukan' });
const konflik = (kode: string, message: string) => new ConflictException({ kode, message });

const KOLOM = `id, company_id, title, description, location_id, positions, status, closes_on::text AS closes_on, internal_notes, created_by, opened_at, created_at, created_at::text AS created_at_txt, updated_at`;
type Baris = Record<string, unknown>;
const peta = (r: Baris) => ({
  id: r.id, companyId: r.company_id, title: r.title, description: r.description, locationId: r.location_id, positions: r.positions, status: r.status, closesOn: r.closes_on,
  internalNotes: r.internal_notes, createdBy: r.created_by, openedAt: r.opened_at, createdAt: r.created_at, updatedAt: r.updated_at,
});

/** Lowongan untuk staff: dikelola per perusahaan dalam scope (RLS tenant). company_id dari scope/baris induk, tidak dari input bebas. */
@Injectable()
export class VacanciesService {
  constructor(
    private readonly sdb: ScopedDb,
    private readonly audit: AuditService,
  ) {}

  private tx<T>(a: Akses, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    return this.sdb.tx({ companyIds: a.companyIds }, fn);
  }

  /** Lokasi harus terlihat (RLS), milik perusahaan yang sama, dan aktif. */
  private async pastikanLokasi(c: PoolClient, locationId: string, companyId: string) {
    const r = await c.query(`SELECT 1 FROM partner_locations WHERE id = $1 AND company_id = $2 AND status = 'AKTIF'`, [locationId, companyId]);
    if (!r.rowCount) throw TDK_LOKASI();
  }

  async daftar(a: Akses, q: z.infer<typeof DaftarLowonganQuery>) {
    const k = decodeKursor(q.cursor);
    return this.tx(a, async (c) => {
      const r = await c.query(
        `SELECT ${KOLOM} FROM job_vacancies
          WHERE ($1::uuid IS NULL OR company_id = $1) AND ($2::text IS NULL OR status = $2)
            AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::uuid))
          ORDER BY created_at DESC, id DESC LIMIT $5`,
        [q.companyId ?? null, q.status ?? null, k?.t ?? null, k?.id ?? null, q.limit + 1],
      );
      const ada = r.rows.length > q.limit;
      const baris = r.rows.slice(0, q.limit);
      return { items: baris.map(peta), nextCursor: ada ? encodeKursor({ t: baris[baris.length - 1].created_at_txt, id: baris[baris.length - 1].id }) : null };
    });
  }

  async detail(a: Akses, id: string) {
    return this.tx(a, async (c) => {
      const r = await c.query(`SELECT ${KOLOM} FROM job_vacancies WHERE id = $1`, [id]);
      if (!r.rowCount) throw TDK_LOWONGAN();
      return peta(r.rows[0]);
    });
  }

  async buat(a: Akses, b: z.infer<typeof LowonganBuat>) {
    const companyId = b.companyId ?? (a.companyIds.length === 1 ? a.companyIds[0] : undefined);
    if (!companyId) throw new ConflictException({ kode: 'PERUSAHAAN_WAJIB', message: 'Pilih perusahaan pengelola lowongan' });
    if (!a.companyIds.includes(companyId)) throw new NotFoundException({ kode: 'PERUSAHAAN_TIDAK_DITEMUKAN', message: 'Perusahaan tidak ditemukan' });
    const hasil = await this.tx(a, async (c) => {
      if (b.locationId) await this.pastikanLokasi(c, b.locationId, companyId);
      const r = await c.query(
        `INSERT INTO job_vacancies (company_id, title, description, location_id, positions, closes_on, internal_notes, created_by)
         VALUES ($1, $2, $3, $4, COALESCE($5, 1), $6, $7, $8) RETURNING ${KOLOM}`,
        [companyId, b.title, b.description, b.locationId ?? null, b.positions ?? null, b.closesOn ?? null, b.internalNotes ?? null, a.userId],
      );
      return r.rows[0];
    });
    await this.audit.catat({ aksi: 'recruitment.vacancy.created', aktorId: a.userId, companyId, objek: 'job_vacancy', objekId: hasil.id });
    return peta(hasil);
  }

  async ubah(a: Akses, id: string, b: z.infer<typeof LowonganUbah>) {
    const kolom: Record<string, string> = { title: 'title', description: 'description', locationId: 'location_id', positions: 'positions', closesOn: 'closes_on', internalNotes: 'internal_notes' };
    const hasil = await this.tx(a, async (c) => {
      const cur = await c.query(`SELECT company_id, status FROM job_vacancies WHERE id = $1 FOR UPDATE`, [id]);
      if (!cur.rowCount) throw TDK_LOWONGAN();
      if (cur.rows[0].status === 'DITUTUP') throw konflik('LOWONGAN_DITUTUP', 'Lowongan yang sudah ditutup tidak dapat diubah');
      if (b.locationId) await this.pastikanLokasi(c, b.locationId, cur.rows[0].company_id);
      const sets: string[] = [];
      const nilai: unknown[] = [id];
      for (const [k, kol] of Object.entries(kolom)) {
        if (k in b) {
          nilai.push((b as Record<string, unknown>)[k] ?? null);
          sets.push(`${kol} = $${nilai.length}`);
        }
      }
      const r = await c.query(`UPDATE job_vacancies SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 AND status <> 'DITUTUP' RETURNING ${KOLOM}`, nilai);
      return r.rows[0];
    });
    await this.audit.catat({ aksi: 'recruitment.vacancy.updated', aktorId: a.userId, companyId: hasil.company_id, objek: 'job_vacancy', objekId: id, detail: { bidang: Object.keys(b) } });
    return peta(hasil);
  }

  async buka(a: Akses, id: string) {
    const hasil = await this.tx(a, async (c) => {
      const r = await c.query(
        `UPDATE job_vacancies SET status = 'DIBUKA', opened_at = now(), updated_at = now()
          WHERE id = $1 AND status = 'DRAFT' AND (closes_on IS NULL OR closes_on >= current_date) RETURNING ${KOLOM}`,
        [id],
      );
      if (r.rowCount) return r.rows[0];
      const cur = await c.query(`SELECT status FROM job_vacancies WHERE id = $1`, [id]);
      if (!cur.rowCount) throw TDK_LOWONGAN();
      if (cur.rows[0].status !== 'DRAFT') throw konflik('TRANSISI_TIDAK_VALID', `Lowongan berstatus ${cur.rows[0].status} tidak dapat dibuka`);
      throw konflik('BATAS_PENDAFTARAN_LEWAT', 'Batas pendaftaran sudah lewat; ubah batas pendaftaran sebelum membuka lowongan');
    });
    await this.audit.catat({ aksi: 'recruitment.vacancy.opened', aktorId: a.userId, companyId: hasil.company_id, objek: 'job_vacancy', objekId: id });
    return peta(hasil);
  }

  async tutup(a: Akses, id: string) {
    const hasil = await this.tx(a, async (c) => {
      const r = await c.query(`UPDATE job_vacancies SET status = 'DITUTUP', updated_at = now() WHERE id = $1 AND status = 'DIBUKA' RETURNING ${KOLOM}`, [id]);
      if (r.rowCount) return r.rows[0];
      const cur = await c.query(`SELECT status FROM job_vacancies WHERE id = $1`, [id]);
      if (!cur.rowCount) throw TDK_LOWONGAN();
      throw konflik('TRANSISI_TIDAK_VALID', `Lowongan berstatus ${cur.rows[0].status} tidak dapat ditutup`);
    });
    await this.audit.catat({ aksi: 'recruitment.vacancy.closed', aktorId: a.userId, companyId: hasil.company_id, objek: 'job_vacancy', objekId: id });
    return peta(hasil);
  }
}
