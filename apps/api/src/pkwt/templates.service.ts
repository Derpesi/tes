import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { decodeKursor, encodeKursor } from '../admin/kursor';
import { AuditService } from '../audit/audit.service';
import { ScopedDb } from '../database/scoped-db';
import type { Akses } from '../rbac/akses.service';
import { DaftarTemplateQuery, TemplateBuat, TemplateUbah, VerifikasiTemplateBody } from './schemas';

const TDK_TEMPLATE = () => new NotFoundException({ kode: 'TEMPLATE_TIDAK_DITEMUKAN', message: 'Template tidak ditemukan' });
const konflik = (kode: string, message: string) => new ConflictException({ kode, message });

const KOLOM = `id, company_id, name, version, body, status, verified_by, verified_at, verification_note, created_by, created_at, created_at::text AS created_at_txt`;
type Baris = Record<string, unknown>;
const peta = (r: Baris, denganIsi = true) => ({
  id: r.id, companyId: r.company_id, name: r.name, version: r.version, ...(denganIsi ? { body: r.body } : {}), status: r.status, verifiedAt: r.verified_at, verificationNote: r.verification_note,
  createdBy: r.created_by, createdAt: r.created_at,
});

/**
 * Template PKWT berversi per perusahaan. Isi disediakan pengguna (TIDAK ada teks hukum bawaan). Template baru berstatus BELUM_DIVERIFIKASI;
 * Direktur (pkwt.approve) mencatat bahwa ahli hukum sudah memverifikasinya (verifikasi terjadi di luar sistem). Pemverifikasi ≠ pembuat
 * (aplikasi + database). Setelah diverifikasi isi terkunci (trigger); perubahan = versi baru.
 */
@Injectable()
export class TemplatesService {
  constructor(
    private readonly sdb: ScopedDb,
    private readonly audit: AuditService,
  ) {}

  private tx<T>(a: Akses, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    return this.sdb.tx({ companyIds: a.companyIds }, fn);
  }

  async daftar(a: Akses, q: z.infer<typeof DaftarTemplateQuery>) {
    const k = decodeKursor(q.cursor);
    return this.tx(a, async (c) => {
      const r = await c.query(
        `SELECT ${KOLOM} FROM contract_templates
          WHERE ($1::uuid IS NULL OR company_id = $1) AND ($2::text IS NULL OR status = $2)
            AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::uuid))
          ORDER BY created_at DESC, id DESC LIMIT $5`,
        [q.companyId ?? null, q.status ?? null, k?.t ?? null, k?.id ?? null, q.limit + 1],
      );
      const ada = r.rows.length > q.limit;
      const baris = r.rows.slice(0, q.limit);
      return { items: baris.map((x) => peta(x, false)), nextCursor: ada ? encodeKursor({ t: baris[baris.length - 1].created_at_txt, id: baris[baris.length - 1].id }) : null };
    });
  }

  async detail(a: Akses, id: string) {
    return this.tx(a, async (c) => {
      const r = await c.query(`SELECT ${KOLOM} FROM contract_templates WHERE id = $1`, [id]);
      if (!r.rowCount) throw TDK_TEMPLATE();
      return peta(r.rows[0]);
    });
  }

  /** Versi baru dari template bernama sama (atau versi 1). company_id dari scope; di luar scope = 404. */
  async buat(a: Akses, b: z.infer<typeof TemplateBuat>) {
    const companyId = b.companyId ?? (a.companyIds.length === 1 ? a.companyIds[0] : undefined);
    if (!companyId) throw konflik('PERUSAHAAN_WAJIB', 'Pilih perusahaan pemilik template');
    if (!a.companyIds.includes(companyId)) throw new NotFoundException({ kode: 'PERUSAHAAN_TIDAK_DITEMUKAN', message: 'Perusahaan tidak ditemukan' });
    const hasil = await this.tx(a, async (c) => {
      await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`tpl:${companyId}:${b.name.toLowerCase()}`]); // versi berurutan walau dibuat serentak
      const v = await c.query(`SELECT COALESCE(max(version), 0) + 1 AS v FROM contract_templates WHERE company_id = $1 AND name = $2`, [companyId, b.name]);
      const r = await c.query(`INSERT INTO contract_templates (company_id, name, version, body, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING ${KOLOM}`, [companyId, b.name, v.rows[0].v, b.body, a.userId]);
      return r.rows[0];
    });
    await this.audit.catat({ aksi: 'pkwt.template.created', aktorId: a.userId, companyId, objek: 'contract_template', objekId: hasil.id, detail: { versi: hasil.version } });
    return peta(hasil);
  }

  async ubah(a: Akses, id: string, b: z.infer<typeof TemplateUbah>) {
    const hasil = await this.tx(a, async (c) => {
      const cur = await c.query(`SELECT status, company_id FROM contract_templates WHERE id = $1 FOR UPDATE`, [id]);
      if (!cur.rowCount) throw TDK_TEMPLATE();
      if (cur.rows[0].status !== 'BELUM_DIVERIFIKASI') throw konflik('TEMPLATE_TERKUNCI', 'Template yang sudah diverifikasi tidak dapat diubah. Buat versi baru');
      const sets: string[] = [];
      const nilai: unknown[] = [id];
      for (const [k, kol] of [['name', 'name'], ['body', 'body']] as const) {
        if (b[k] !== undefined) {
          nilai.push(b[k]);
          sets.push(`${kol} = $${nilai.length}`);
        }
      }
      try {
        return (await c.query(`UPDATE contract_templates SET ${sets.join(', ')} WHERE id = $1 RETURNING ${KOLOM}`, nilai)).rows[0];
      } catch (e) {
        if ((e as { constraint?: string }).constraint === 'contract_templates_versi_unik') throw konflik('TEMPLATE_SUDAH_ADA', 'Nama dan versi template sudah dipakai');
        throw e;
      }
    });
    await this.audit.catat({ aksi: 'pkwt.template.updated', aktorId: a.userId, companyId: hasil.company_id, objek: 'contract_template', objekId: id, detail: { bidang: Object.keys(b) } });
    return peta(hasil);
  }

  /** Mencatat verifikasi hukum (di luar sistem). Pemverifikasi tidak boleh pembuat template. */
  async verifikasi(a: Akses, id: string, b: z.infer<typeof VerifikasiTemplateBody>) {
    const hasil = await this.tx(a, async (c) => {
      const cur = await c.query(`SELECT status, created_by FROM contract_templates WHERE id = $1 FOR UPDATE`, [id]);
      if (!cur.rowCount) throw TDK_TEMPLATE();
      if (cur.rows[0].status !== 'BELUM_DIVERIFIKASI') throw konflik('TRANSISI_TIDAK_VALID', `Template berstatus ${cur.rows[0].status} tidak dapat diverifikasi`);
      if (cur.rows[0].created_by === a.userId) throw new ForbiddenException({ kode: 'PEMISAHAN_TUGAS', message: 'Pemverifikasi tidak boleh sama dengan pembuat template' });
      const r = await c.query(`UPDATE contract_templates SET status = 'TERVERIFIKASI', verified_by = $2, verified_at = now(), verification_note = $3 WHERE id = $1 AND status = 'BELUM_DIVERIFIKASI' RETURNING ${KOLOM}`, [id, a.userId, b.note]);
      if (!r.rowCount) throw konflik('TRANSISI_TIDAK_VALID', 'Status template sudah berubah');
      return r.rows[0];
    });
    await this.audit.catat({ aksi: 'pkwt.template.verified', aktorId: a.userId, companyId: hasil.company_id, objek: 'contract_template', objekId: id });
    return peta(hasil);
  }

  async arsipkan(a: Akses, id: string) {
    const hasil = await this.tx(a, async (c) => {
      const r = await c.query(`UPDATE contract_templates SET status = 'DIARSIPKAN' WHERE id = $1 AND status = 'TERVERIFIKASI' RETURNING ${KOLOM}`, [id]);
      if (r.rowCount) return r.rows[0];
      const cur = await c.query(`SELECT status FROM contract_templates WHERE id = $1`, [id]);
      if (!cur.rowCount) throw TDK_TEMPLATE();
      throw konflik('TRANSISI_TIDAK_VALID', `Template berstatus ${cur.rows[0].status} tidak dapat diarsipkan`);
    });
    await this.audit.catat({ aksi: 'pkwt.template.archived', aktorId: a.userId, companyId: hasil.company_id, objek: 'contract_template', objekId: id });
    return peta(hasil);
  }
}
