import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool } from 'pg';
import { AuditService, EntriAudit } from '../audit/audit.service';
import { InvitationService } from '../auth/invitation.service';
import { SessionService } from '../auth/session.service';
import { POOL } from '../database/tokens';
import type { Akses } from '../rbac/akses.service';
import { ApprovalService, HasilPeran } from './approval.service';
import { decodeKursor, encodeKursor } from './kursor';

export interface UndangInput {
  email: string;
  displayName: string;
  roles: string[];
  companyIds: string[];
}

const DILARANG_DIRI = () => new ForbiddenException({ kode: 'TIDAK_BOLEH_UBAH_DIRI_SENDIRI', message: 'Anda tidak dapat mengubah hak akses akun Anda sendiri' });

@Injectable()
export class StaffAdminService {
  constructor(
    @Inject(POOL) private readonly pool: Pool,
    private readonly invitations: InvitationService,
    private readonly approvals: ApprovalService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}

  async daftarPeran() {
    const r = await this.pool.query(
      `SELECT r.code, r.name, r.high_privilege, coalesce(array_agg(rp.permission_code ORDER BY rp.permission_code) FILTER (WHERE rp.permission_code IS NOT NULL), '{}') AS permissions
         FROM roles r LEFT JOIN role_permissions rp ON rp.role_code = r.code GROUP BY r.code ORDER BY r.code`,
    );
    return r.rows.map((x) => ({ code: x.code, name: x.name, highPrivilege: x.high_privilege, permissions: x.permissions }));
  }

  async daftarStaff(kursor: string | undefined, batas: number) {
    const k = decodeKursor(kursor);
    const r = await this.pool.query(
      `SELECT u.id, u.email, p.display_name, u.status, u.all_companies, u.created_at, u.created_at::text AS created_at_txt,
              coalesce((SELECT json_agg(json_build_object('code', x.role_code, 'expiresAt', x.expires_at) ORDER BY x.role_code) FROM user_roles x WHERE x.user_id = u.id AND x.revoked_at IS NULL), '[]'::json) AS roles,
              coalesce((SELECT json_agg(s.scope_company_id) FROM user_company_scopes s WHERE s.user_id = u.id AND s.revoked_at IS NULL), '[]'::json) AS companies,
              EXISTS (SELECT 1 FROM staff_mfa_factors f WHERE f.user_id = u.id AND f.status = 'AKTIF') AS mfa
         FROM users u LEFT JOIN persons p ON p.id = u.person_id
        WHERE u.realm = 'staff' AND ($1::timestamptz IS NULL OR (u.created_at, u.id) < ($1::timestamptz, $2::uuid))
        ORDER BY u.created_at DESC, u.id DESC LIMIT $3`,
      [k?.t ?? null, k?.id ?? null, batas + 1],
    );
    const ada = r.rows.length > batas;
    const baris = r.rows.slice(0, batas);
    return {
      items: baris.map((x) => ({
        id: x.id, email: x.email, displayName: x.display_name, status: x.status, allCompanies: x.all_companies,
        roles: x.roles, companyIds: x.companies, mfaEnrolled: x.mfa, createdAt: x.created_at,
      })),
      nextCursor: ada ? encodeKursor({ t: baris[baris.length - 1].created_at_txt, id: baris[baris.length - 1].id }) : null,
    };
  }

  private async pastikanPerusahaan(c: Pick<Pool, 'query'>, ids: string[]) {
    if (!ids.length) return;
    const r = await c.query(`SELECT id FROM companies WHERE id = ANY($1) AND active`, [ids]);
    if (r.rowCount !== new Set(ids).size) throw new BadRequestException({ kode: 'PERUSAHAAN_TIDAK_VALID', message: 'Ada perusahaan yang tidak ditemukan atau tidak aktif' });
  }

  /** Mengundang staff beserta peran dan scope perusahaan dalam SATU transaksi. */
  async undang(a: Akses, b: UndangInput) {
    const c = await this.pool.connect();
    const efek: EntriAudit[] = [];
    try {
      await c.query('BEGIN');
      await this.pastikanPerusahaan(c, b.companyIds);
      const u = await this.invitations.undangDi(c, { email: b.email, namaTampilan: b.displayName, diundangOleh: a.userId });
      efek.push({ aksi: 'auth.invitation.created', aktorId: a.userId, objek: 'user', objekId: u.userId, detail: { emailDikirim: true } });
      const peran: HasilPeran[] = [];
      for (const kode of [...new Set(b.roles)]) peran.push(await this.approvals.beriPeranDi(c, a, u.userId, kode, null, efek));
      for (const id of new Set(b.companyIds)) {
        await c.query(`INSERT INTO user_company_scopes (user_id, scope_company_id, granted_by) VALUES ($1, $2, $3)`, [u.userId, id, a.userId]);
        efek.push({ aksi: 'auth.scope.granted', aktorId: a.userId, objek: 'user', objekId: u.userId, detail: { perusahaan: id } });
      }
      await c.query('COMMIT');
      for (const e of efek) await this.audit.catat(e);
      // Token undangan TIDAK dikembalikan; hanya dikirim lewat email.
      return { userId: u.userId, roles: peran, companyIds: [...new Set(b.companyIds)] };
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }

  async beriPeran(a: Akses, targetId: string, roleCode: string, expiresAt: Date | null) {
    const c = await this.pool.connect();
    const efek: EntriAudit[] = [];
    try {
      await c.query('BEGIN');
      const h = await this.approvals.beriPeranDi(c, a, targetId, roleCode, expiresAt, efek);
      await c.query('COMMIT');
      for (const e of efek) await this.audit.catat(e);
      return h;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }

  async cabutPeran(a: Akses, targetId: string, roleCode: string) {
    if (targetId === a.userId) throw DILARANG_DIRI();
    const r = await this.pool.query(
      `UPDATE user_roles SET revoked_at = now(), revoked_by = $3 WHERE user_id = $1 AND role_code = $2 AND revoked_at IS NULL RETURNING id`,
      [targetId, roleCode, a.userId],
    );
    if (!r.rowCount) throw new NotFoundException({ kode: 'PERAN_TIDAK_DITEMUKAN', message: 'Pengguna tidak memiliki peran aktif tersebut' });
    await this.audit.catat({ aksi: 'auth.role.revoked', aktorId: a.userId, objek: 'user', objekId: targetId, detail: { role: roleCode } });
  }

  async beriScope(a: Akses, targetId: string, companyId: string) {
    if (targetId === a.userId) throw DILARANG_DIRI();
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await this.approvals.targetStaff(c, targetId, a);
      await this.pastikanPerusahaan(c, [companyId]);
      await c.query(
        `INSERT INTO user_company_scopes (user_id, scope_company_id, granted_by) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, scope_company_id) DO UPDATE SET revoked_at = NULL, granted_by = $3, granted_at = now()`,
        [targetId, companyId, a.userId],
      );
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
    await this.audit.catat({ aksi: 'auth.scope.granted', aktorId: a.userId, objek: 'user', objekId: targetId, detail: { perusahaan: companyId } });
  }

  async cabutScope(a: Akses, targetId: string, companyId: string) {
    if (targetId === a.userId) throw DILARANG_DIRI();
    const r = await this.pool.query(`UPDATE user_company_scopes SET revoked_at = now() WHERE user_id = $1 AND scope_company_id = $2 AND revoked_at IS NULL RETURNING user_id`, [targetId, companyId]);
    if (!r.rowCount) throw new NotFoundException({ kode: 'SCOPE_TIDAK_DITEMUKAN', message: 'Pengguna tidak memiliki akses ke perusahaan tersebut' });
    await this.audit.catat({ aksi: 'auth.scope.revoked', aktorId: a.userId, objek: 'user', objekId: targetId, detail: { perusahaan: companyId } });
  }

  async cabutSemuaPerusahaan(a: Akses, targetId: string) {
    if (targetId === a.userId) throw DILARANG_DIRI();
    const r = await this.pool.query(`UPDATE users SET all_companies = false, updated_at = now() WHERE id = $1 AND realm = 'staff' AND all_companies RETURNING id`, [targetId]);
    if (!r.rowCount) throw new NotFoundException({ kode: 'SCOPE_TIDAK_DITEMUKAN', message: 'Pengguna tidak memiliki akses ke seluruh perusahaan' });
    await this.audit.catat({ aksi: 'auth.scope.all_companies_revoked', aktorId: a.userId, objek: 'user', objekId: targetId });
  }

  /** Menonaktifkan staff: sesi dicabut, peran dicabut, permintaan persetujuan tertunda dibatalkan. */
  async nonaktifkan(a: Akses, targetId: string) {
    if (targetId === a.userId) throw DILARANG_DIRI();
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const u = await c.query(`UPDATE users SET status = 'NONAKTIF', updated_at = now() WHERE id = $1 AND realm = 'staff' AND status <> 'NONAKTIF' RETURNING id`, [targetId]);
      if (!u.rowCount) {
        const ada = await c.query(`SELECT 1 FROM users WHERE id = $1 AND realm = 'staff'`, [targetId]);
        if (!ada.rowCount) throw new NotFoundException({ kode: 'STAFF_TIDAK_DITEMUKAN', message: 'Staff tidak ditemukan' });
        throw new ConflictException({ kode: 'STAFF_NONAKTIF', message: 'Akun staff sudah nonaktif' });
      }
      await c.query(`UPDATE user_roles SET revoked_at = now(), revoked_by = $2 WHERE user_id = $1 AND revoked_at IS NULL`, [targetId, a.userId]);
      await c.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'NONAKTIF' WHERE user_id = $1 AND revoked_at IS NULL`, [targetId]);
      await c.query(`UPDATE approval_requests SET status = 'DIBATALKAN' WHERE subject_user_id = $1 AND status = 'MENUNGGU'`, [targetId]);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
    await this.audit.catat({ aksi: 'auth.user.deactivated', aktorId: a.userId, objek: 'user', objekId: targetId });
  }
}
