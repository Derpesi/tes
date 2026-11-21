import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool } from 'pg';
import { z } from 'zod';
import { ApprovalService } from '../admin/approval.service';
import { decodeKursor, encodeKursor } from '../admin/kursor';
import { AuditService, EntriAudit } from '../audit/audit.service';
import { POOL } from '../database/tokens';
import type { Akses } from '../rbac/akses.service';
import { PerusahaanBuat, PerusahaanUbah } from './schemas';

const KOLOM = `id, name, short_code, legal_name, npwp, address, city, province, phone, email, active, payroll_settings, document_settings, created_at, created_at::text AS created_at_txt, updated_at`;

interface Baris {
  id: string; name: string; short_code: string; legal_name: string | null; npwp: string | null; address: string | null; city: string | null;
  province: string | null; phone: string | null; email: string | null; active: boolean; payroll_settings: unknown; document_settings: unknown;
  created_at: Date; created_at_txt: string; updated_at: Date;
}
const peta = (r: Baris) => ({
  id: r.id, name: r.name, shortCode: r.short_code, legalName: r.legal_name, npwp: r.npwp, address: r.address, city: r.city, province: r.province,
  phone: r.phone, email: r.email, active: r.active, status: r.active ? 'AKTIF' : 'MENUNGGU_PERSETUJUAN_ATAU_NONAKTIF',
  payrollSettings: r.payroll_settings, documentSettings: r.document_settings, createdAt: r.created_at, updatedAt: r.updated_at,
});

const TIDAK_ADA = () => new NotFoundException({ kode: 'PERUSAHAAN_TIDAK_DITEMUKAN', message: 'Perusahaan tidak ditemukan' });

/**
 * Master perusahaan grup. Tabel companies tidak ber-RLS (id-nya adalah tenant), maka visibilitas ditegakkan DI SINI:
 * perusahaan dalam scope pengguna, ditambah perusahaan pending buatan pengguna itu sendiri. Perusahaan di luar itu
 * selalu 404 (keberadaannya tidak dibocorkan).
 */
@Injectable()
export class CompaniesService {
  constructor(
    @Inject(POOL) private readonly pool: Pool,
    private readonly approvals: ApprovalService,
    private readonly audit: AuditService,
  ) {}

  /** Predikat visibilitas: $1 = id perusahaan dalam scope (uuid[]), $2 = id pengguna. */
  private static readonly VISIBEL = `(id = ANY($1::uuid[]) OR (created_by = $2 AND NOT active))`;

  async daftar(a: Akses, kursor: string | undefined, batas: number) {
    const k = decodeKursor(kursor);
    const r = await this.pool.query(
      `SELECT ${KOLOM} FROM companies
        WHERE ${CompaniesService.VISIBEL} AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::uuid))
        ORDER BY created_at DESC, id DESC LIMIT $5`,
      [a.companyIds, a.userId, k?.t ?? null, k?.id ?? null, batas + 1],
    );
    const ada = r.rows.length > batas;
    const baris = r.rows.slice(0, batas) as Baris[];
    return { items: baris.map(peta), nextCursor: ada ? encodeKursor({ t: baris[baris.length - 1].created_at_txt, id: baris[baris.length - 1].id }) : null };
  }

  async detail(a: Akses, id: string) {
    const r = await this.pool.query(`SELECT ${KOLOM} FROM companies WHERE id = $3 AND ${CompaniesService.VISIBEL}`, [a.companyIds, a.userId, id]);
    if (!r.rowCount) throw TIDAK_ADA();
    return peta(r.rows[0]);
  }

  /** Perusahaan baru NONAKTIF sampai Direktur menyetujui aktivasi (tanpa perubahan kode untuk perusahaan baru). */
  async buat(a: Akses, b: z.infer<typeof PerusahaanBuat>) {
    const c = await this.pool.connect();
    const efek: EntriAudit[] = [];
    try {
      await c.query('BEGIN');
      let id: string;
      try {
        const r = await c.query(
          `INSERT INTO companies (name, short_code, legal_name, npwp, address, city, province, phone, email, active, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false, $10) RETURNING id`,
          [b.name, b.shortCode, b.legalName ?? null, b.npwp ?? null, b.address ?? null, b.city ?? null, b.province ?? null, b.phone ?? null, b.email ?? null, a.userId],
        );
        id = r.rows[0].id;
      } catch (e) {
        if ((e as { code?: string; constraint?: string }).constraint === 'companies_short_code_unik') {
          throw new ConflictException({ kode: 'KODE_PERUSAHAAN_SUDAH_ADA', message: 'Kode singkat sudah dipakai perusahaan lain' });
        }
        throw e;
      }
      const ap = await this.approvals.mintaAktivasiPerusahaanDi(c, a, id, efek);
      efek.push({ aksi: 'master.company.created', aktorId: a.userId, objek: 'company', objekId: id });
      await c.query('COMMIT');
      for (const e of efek) await this.audit.catat(e);
      return { id, status: 'MENUNGGU_PERSETUJUAN', approvalId: ap.approvalId };
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }

  async ubah(a: Akses, id: string, b: z.infer<typeof PerusahaanUbah>) {
    const kolom: Record<string, string> = { name: 'name', shortCode: 'short_code', legalName: 'legal_name', npwp: 'npwp', address: 'address', city: 'city', province: 'province', phone: 'phone', email: 'email' };
    const sets: string[] = [];
    const nilai: unknown[] = [a.companyIds, a.userId, id];
    for (const [k, kol] of Object.entries(kolom)) {
      if (k in b) {
        nilai.push((b as Record<string, unknown>)[k] ?? null);
        sets.push(`${kol} = $${nilai.length}`);
      }
    }
    // jsonb digabung (merge) agar pengaturan lain tidak hilang
    if (b.payrollSettings) { nilai.push(JSON.stringify(b.payrollSettings)); sets.push(`payroll_settings = payroll_settings || $${nilai.length}::jsonb`); }
    if (b.documentSettings) { nilai.push(JSON.stringify(b.documentSettings)); sets.push(`document_settings = document_settings || $${nilai.length}::jsonb`); }
    try {
      const r = await this.pool.query(`UPDATE companies SET ${sets.join(', ')}, updated_at = now() WHERE id = $3 AND ${CompaniesService.VISIBEL} RETURNING ${KOLOM}`, nilai);
      if (!r.rowCount) throw TIDAK_ADA();
      // Audit hanya mencatat NAMA bidang yang berubah (bukan nilainya).
      await this.audit.catat({ aksi: 'master.company.updated', aktorId: a.userId, objek: 'company', objekId: id, detail: { bidang: Object.keys(b) } });
      return peta(r.rows[0]);
    } catch (e) {
      if ((e as { constraint?: string }).constraint === 'companies_short_code_unik') {
        throw new ConflictException({ kode: 'KODE_PERUSAHAAN_SUDAH_ADA', message: 'Kode singkat sudah dipakai perusahaan lain' });
      }
      throw e;
    }
  }

  async nonaktifkan(a: Akses, id: string) {
    const r = await this.pool.query(`UPDATE companies SET active = false, updated_at = now() WHERE id = $3 AND ${CompaniesService.VISIBEL} AND active RETURNING id`, [a.companyIds, a.userId, id]);
    if (!r.rowCount) {
      const ada = await this.pool.query(`SELECT 1 FROM companies WHERE id = $3 AND ${CompaniesService.VISIBEL}`, [a.companyIds, a.userId, id]);
      if (!ada.rowCount) throw TIDAK_ADA();
      throw new ConflictException({ kode: 'PERUSAHAAN_SUDAH_NONAKTIF', message: 'Perusahaan sudah nonaktif' });
    }
    await this.audit.catat({ aksi: 'master.company.deactivated', aktorId: a.userId, objek: 'company', objekId: id });
  }
}
