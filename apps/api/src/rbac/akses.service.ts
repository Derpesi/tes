import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { POOL } from '../database/tokens';

/** Peran yang boleh membaca baris audit global (company_id NULL: peristiwa auth/sistem). */
export const PERAN_AUDIT_GLOBAL = ['DIREKTUR', 'IT_ADMIN'] as const;

export interface Akses {
  userId: string;
  /** Peran aktif (belum dicabut dan belum kedaluwarsa). */
  roles: string[];
  permissions: Set<string>;
  /** Perusahaan aktif yang boleh diakses (dari scope atau seluruh perusahaan). */
  companyIds: string[];
  semuaPerusahaan: boolean;
  /** Boleh membaca baris audit global. */
  auditGlobal: boolean;
  /** Memegang peran yang berasal dari bootstrap (untuk pengecualian Direktur pertama). */
  punyaPeranBootstrap: boolean;
}

@Injectable()
export class AksesService {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  /**
   * Menghitung hak akses langsung dari database pada setiap permintaan (tanpa cache) sehingga pencabutan peran,
   * kedaluwarsa peran berumur-terbatas, dan penonaktifan perusahaan berlaku seketika.
   */
  async muat(userId: string): Promise<Akses> {
    const peran = await this.pool.query(
      `SELECT role_code, grant_source FROM user_roles
        WHERE user_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
      [userId],
    );
    const roles = peran.rows.map((r) => r.role_code as string);
    const perm = roles.length
      ? await this.pool.query(`SELECT DISTINCT permission_code FROM role_permissions WHERE role_code = ANY($1)`, [roles])
      : { rows: [] as { permission_code: string }[] };
    const u = await this.pool.query(`SELECT all_companies FROM users WHERE id = $1`, [userId]);
    const semua = u.rows[0]?.all_companies === true;
    const perusahaan = semua
      ? await this.pool.query(`SELECT id FROM companies WHERE active`)
      : await this.pool.query(
          `SELECT c.id FROM user_company_scopes s JOIN companies c ON c.id = s.scope_company_id
            WHERE s.user_id = $1 AND s.revoked_at IS NULL AND c.active`,
          [userId],
        );
    return {
      userId,
      roles,
      permissions: new Set(perm.rows.map((r) => r.permission_code as string)),
      companyIds: perusahaan.rows.map((r) => r.id as string),
      semuaPerusahaan: semua,
      auditGlobal: roles.some((r) => (PERAN_AUDIT_GLOBAL as readonly string[]).includes(r)),
      punyaPeranBootstrap: peran.rows.some((r) => r.grant_source === 'BOOTSTRAP'),
    };
  }
}
