import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { AuditService, EntriAudit } from '../audit/audit.service';
import { InvitationService } from '../auth/invitation.service';
import { POOL } from '../database/tokens';
import type { Akses } from '../rbac/akses.service';

export const KEDALUWARSA_PERSETUJUAN_MS = 72 * 60 * 60 * 1000;

export type TipeApproval = 'BERI_PERAN_TINGGI' | 'RESET_MFA' | 'BERI_AKSES_SEMUA_PERUSAHAAN';

export interface HasilPeran {
  roleCode: string;
  status: 'DIBERIKAN' | 'MENUNGGU_PERSETUJUAN';
  approvalId?: string;
  pengecualian?: 'DIREKTUR_PERTAMA';
}

const DILARANG_DIRI = () => new ForbiddenException({ kode: 'TIDAK_BOLEH_UBAH_DIRI_SENDIRI', message: 'Anda tidak dapat mengubah hak akses akun Anda sendiri' });

@Injectable()
export class ApprovalService {
  constructor(
    @Inject(POOL) private readonly pool: Pool,
    private readonly invitations: InvitationService,
    private readonly audit: AuditService,
  ) {}

  /** Menandai permintaan yang lewat batas sebagai KEDALUWARSA (dijalankan lazim saat daftar/putusan). */
  async kedaluwarsakan(c: Pool | PoolClient = this.pool): Promise<void> {
    await c.query(`UPDATE approval_requests SET status = 'KEDALUWARSA' WHERE status = 'MENUNGGU' AND expires_at <= now()`);
  }

  async targetStaff(c: PoolClient, userId: string, a: Akses) {
    const t = await c.query(`SELECT id, status, email FROM users WHERE id = $1 AND realm = 'staff' FOR UPDATE`, [userId]);
    if (!t.rowCount) throw new NotFoundException({ kode: 'STAFF_TIDAK_DITEMUKAN', message: 'Staff tidak ditemukan' });
    if (t.rows[0].id === a.userId) throw DILARANG_DIRI();
    if (t.rows[0].status === 'NONAKTIF') throw new ConflictException({ kode: 'STAFF_NONAKTIF', message: 'Akun staff sudah nonaktif' });
    return t.rows[0] as { id: string; status: string; email: string };
  }

  private async belumAdaDirektur(c: PoolClient): Promise<boolean> {
    const r = await c.query(
      `SELECT NOT EXISTS (
         SELECT 1 FROM user_roles r JOIN users u ON u.id = r.user_id
          WHERE r.role_code = 'DIREKTUR' AND r.revoked_at IS NULL AND (r.expires_at IS NULL OR r.expires_at > now())
            AND u.status IN ('DIUNDANG', 'AKTIF')) AS kosong`,
    );
    return r.rows[0].kosong === true;
  }

  private async buatApproval(c: PoolClient, tipe: TipeApproval, a: Akses, subjectId: string, payload: Record<string, unknown>): Promise<{ id: string; baru: boolean }> {
    await this.kedaluwarsakan(c);
    const ada = await c.query(
      `SELECT id FROM approval_requests WHERE type = $1 AND subject_user_id = $2 AND status = 'MENUNGGU' AND payload = $3::jsonb`,
      [tipe, subjectId, JSON.stringify(payload)],
    );
    if (ada.rowCount) return { id: ada.rows[0].id, baru: false };
    const r = await c.query(
      `INSERT INTO approval_requests (type, requested_by, subject_user_id, payload, expires_at)
       VALUES ($1, $2, $3, $4, now() + ($5 * interval '1 millisecond')) RETURNING id`,
      [tipe, a.userId, subjectId, JSON.stringify(payload), KEDALUWARSA_PERSETUJUAN_MS],
    );
    return { id: r.rows[0].id, baru: true };
  }

  /**
   * Memberi peran dalam transaksi `c`. Peran berhak tinggi (Direktur, IT Administrator) TIDAK langsung berlaku:
   * dibuat permintaan persetujuan yang harus diputuskan Direktur lain. Pengecualian terbatas: admin bootstrap
   * dapat menunjuk Direktur PERTAMA (selagi belum ada Direktur sama sekali); teraudit.
   */
  async beriPeranDi(c: PoolClient, a: Akses, targetId: string, roleCode: string, expiresAt: Date | null, efek: EntriAudit[]): Promise<HasilPeran> {
    const role = await c.query(`SELECT code, high_privilege FROM roles WHERE code = $1`, [roleCode]);
    if (!role.rowCount) throw new BadRequestException({ kode: 'PERAN_TIDAK_DIKENAL', message: `Peran tidak dikenal: ${roleCode}` });
    await this.targetStaff(c, targetId, a);

    const sisip = async (sumber: 'MANUAL' | 'PERSETUJUAN') => {
      try {
        await c.query(`INSERT INTO user_roles (user_id, role_code, grant_source, granted_by, expires_at) VALUES ($1, $2, $3, $4, $5)`, [targetId, roleCode, sumber, a.userId, expiresAt]);
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw new ConflictException({ kode: 'PERAN_SUDAH_DIMILIKI', message: 'Pengguna sudah memiliki peran ini' });
        throw e;
      }
    };

    if (!role.rows[0].high_privilege) {
      await sisip('MANUAL');
      efek.push({ aksi: 'auth.role.granted', aktorId: a.userId, objek: 'user', objekId: targetId, detail: { role: roleCode } });
      return { roleCode, status: 'DIBERIKAN' };
    }
    if (roleCode === 'DIREKTUR' && a.punyaPeranBootstrap && (await this.belumAdaDirektur(c))) {
      await sisip('MANUAL');
      efek.push({ aksi: 'auth.first_director.exception', aktorId: a.userId, objek: 'user', objekId: targetId, detail: { role: roleCode } });
      efek.push({ aksi: 'auth.role.granted', aktorId: a.userId, objek: 'user', objekId: targetId, detail: { role: roleCode, pengecualian: 'DIREKTUR_PERTAMA' } });
      return { roleCode, status: 'DIBERIKAN', pengecualian: 'DIREKTUR_PERTAMA' };
    }
    const ap = await this.buatApproval(c, 'BERI_PERAN_TINGGI', a, targetId, { roleCode, expiresAt: expiresAt?.toISOString() ?? null });
    if (ap.baru) efek.push({ aksi: 'auth.approval.requested', aktorId: a.userId, objek: 'approval', objekId: ap.id, detail: { tipe: 'BERI_PERAN_TINGGI', role: roleCode, subjek: targetId } });
    return { roleCode, status: 'MENUNGGU_PERSETUJUAN', approvalId: ap.id };
  }

  async mintaResetMfa(a: Akses, targetId: string): Promise<{ approvalId: string }> {
    const c = await this.pool.connect();
    const efek: EntriAudit[] = [];
    try {
      await c.query('BEGIN');
      await this.targetStaff(c, targetId, a);
      const ap = await this.buatApproval(c, 'RESET_MFA', a, targetId, {});
      if (ap.baru) efek.push({ aksi: 'auth.approval.requested', aktorId: a.userId, objek: 'approval', objekId: ap.id, detail: { tipe: 'RESET_MFA', subjek: targetId } });
      await c.query('COMMIT');
      for (const e of efek) await this.audit.catat(e);
      return { approvalId: ap.id };
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }

  async mintaAksesSemuaPerusahaan(a: Akses, targetId: string): Promise<{ approvalId: string }> {
    const c = await this.pool.connect();
    const efek: EntriAudit[] = [];
    try {
      await c.query('BEGIN');
      await this.targetStaff(c, targetId, a);
      const ap = await this.buatApproval(c, 'BERI_AKSES_SEMUA_PERUSAHAAN', a, targetId, {});
      if (ap.baru) efek.push({ aksi: 'auth.approval.requested', aktorId: a.userId, objek: 'approval', objekId: ap.id, detail: { tipe: 'BERI_AKSES_SEMUA_PERUSAHAAN', subjek: targetId } });
      await c.query('COMMIT');
      for (const e of efek) await this.audit.catat(e);
      return { approvalId: ap.id };
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }

  async daftar(status: string) {
    await this.kedaluwarsakan();
    const r = await this.pool.query(
      `SELECT a.id, a.type, a.status, a.payload, a.expires_at, a.created_at, a.decided_at, a.decision_note,
              json_build_object('id', rq.id, 'email', rq.email) AS requested_by,
              json_build_object('id', su.id, 'email', su.email) AS subject,
              CASE WHEN dc.id IS NULL THEN NULL ELSE json_build_object('id', dc.id, 'email', dc.email) END AS decided_by
         FROM approval_requests a
         JOIN users rq ON rq.id = a.requested_by JOIN users su ON su.id = a.subject_user_id LEFT JOIN users dc ON dc.id = a.decided_by
        WHERE a.status = $1 ORDER BY a.created_at DESC LIMIT 100`,
      [status],
    );
    return r.rows.map((x) => ({
      id: x.id, type: x.type, status: x.status, payload: x.payload, expiresAt: x.expires_at, createdAt: x.created_at,
      decidedAt: x.decided_at, decisionNote: x.decision_note, requestedBy: x.requested_by, subject: x.subject, decidedBy: x.decided_by,
    }));
  }

  /** Memutuskan permintaan. Pemohon tidak boleh memutuskan permintaannya sendiri (aplikasi dan constraint database). */
  async putuskan(a: Akses, id: string, setuju: boolean, catatan?: string): Promise<{ status: string }> {
    await this.kedaluwarsakan(); // di luar transaksi putusan agar status KEDALUWARSA tetap tersimpan walau putusan ditolak
    const c = await this.pool.connect();
    const efek: EntriAudit[] = [];
    const status = setuju ? 'DISETUJUI' : 'DITOLAK';
    try {
      await c.query('BEGIN');
      const r = await c.query(`SELECT * FROM approval_requests WHERE id = $1 FOR UPDATE`, [id]);
      if (!r.rowCount) throw new NotFoundException({ kode: 'PERSETUJUAN_TIDAK_DITEMUKAN', message: 'Permintaan persetujuan tidak ditemukan' });
      const p = r.rows[0];
      if (p.requested_by === a.userId) throw new ForbiddenException({ kode: 'PENYETUJU_SAMA_DENGAN_PEMOHON', message: 'Anda tidak dapat memutuskan permintaan yang Anda ajukan sendiri' });
      if (p.status !== 'MENUNGGU') {
        throw new ConflictException({ kode: p.status === 'KEDALUWARSA' ? 'PERSETUJUAN_KEDALUWARSA' : 'PERSETUJUAN_SUDAH_DIPUTUSKAN', message: p.status === 'KEDALUWARSA' ? 'Permintaan persetujuan sudah kedaluwarsa' : 'Permintaan persetujuan sudah diputuskan' });
      }
      if (setuju) await this.terapkan(c, p, a, efek);
      await c.query(`UPDATE approval_requests SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4 WHERE id = $1`, [id, status, a.userId, catatan ?? null]);
      efek.push({ aksi: setuju ? 'auth.approval.approved' : 'auth.approval.rejected', aktorId: a.userId, objek: 'approval', objekId: id, detail: { tipe: p.type, subjek: p.subject_user_id } });
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
    for (const e of efek) await this.audit.catat(e);
    return { status };
  }

  /** Menjalankan efek permintaan yang disetujui di dalam transaksi putusan. */
  private async terapkan(c: PoolClient, p: { type: TipeApproval; subject_user_id: string; requested_by: string; payload: Record<string, unknown> }, penyetuju: Akses, efek: EntriAudit[]) {
    const t = await c.query(`SELECT id, status, email FROM users WHERE id = $1 AND realm = 'staff' FOR UPDATE`, [p.subject_user_id]);
    if (!t.rowCount || t.rows[0].status === 'NONAKTIF') throw new ConflictException({ kode: 'STAFF_NONAKTIF', message: 'Akun staff sudah nonaktif; permintaan tidak dapat diterapkan' });
    if (p.type === 'BERI_PERAN_TINGGI') {
      const roleCode = String(p.payload.roleCode);
      const kedaluwarsa = typeof p.payload.expiresAt === 'string' ? new Date(p.payload.expiresAt) : null;
      await c.query(
        `INSERT INTO user_roles (user_id, role_code, grant_source, granted_by, expires_at) VALUES ($1, $2, 'PERSETUJUAN', $3, $4)
         ON CONFLICT (user_id, role_code) WHERE revoked_at IS NULL DO NOTHING`,
        [p.subject_user_id, roleCode, p.requested_by, kedaluwarsa],
      );
      efek.push({ aksi: 'auth.role.granted', aktorId: penyetuju.userId, objek: 'user', objekId: p.subject_user_id, detail: { role: roleCode, via: 'persetujuan' } });
    } else if (p.type === 'BERI_AKSES_SEMUA_PERUSAHAAN') {
      await c.query(`UPDATE users SET all_companies = true, updated_at = now() WHERE id = $1`, [p.subject_user_id]);
      efek.push({ aksi: 'auth.scope.all_companies_granted', aktorId: penyetuju.userId, objek: 'user', objekId: p.subject_user_id });
    } else if (p.type === 'RESET_MFA') {
      await this.resetAkunDi(c, p.subject_user_id, penyetuju.userId);
      efek.push({ aksi: 'auth.mfa.reset', aktorId: penyetuju.userId, objek: 'user', objekId: p.subject_user_id });
    }
  }

  /**
   * Reset MFA = akun kembali ke keadaan DIUNDANG: faktor MFA, kode pemulihan, DAN kata sandi dihapus, semua sesi dicabut,
   * lalu undangan baru dikirim. Kata sandi ikut dihapus agar siapa pun yang hanya tahu kata sandi lama tidak dapat
   * mendaftarkan TOTP-nya sendiri.
   */
  private async resetAkunDi(c: PoolClient, userId: string, oleh: string) {
    const u = await c.query(`SELECT u.email, coalesce(p.display_name, split_part(u.email, '@', 1)) AS nama FROM users u LEFT JOIN persons p ON p.id = u.person_id WHERE u.id = $1`, [userId]);
    await c.query(`UPDATE staff_mfa_factors SET status = 'DICABUT', revoked_at = now() WHERE user_id = $1 AND status IN ('AKTIF', 'PENDING')`, [userId]);
    await c.query(`DELETE FROM mfa_recovery_codes WHERE user_id = $1`, [userId]);
    await c.query(`DELETE FROM staff_credentials WHERE user_id = $1`, [userId]);
    await c.query(`UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [userId]);
    await c.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'RESET_MFA' WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
    await c.query(`UPDATE users SET status = 'DIUNDANG', updated_at = now() WHERE id = $1`, [userId]);
    await this.invitations.undangDi(c, { email: u.rows[0].email, namaTampilan: u.rows[0].nama, diundangOleh: oleh });
  }
}
