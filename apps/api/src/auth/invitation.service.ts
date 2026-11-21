import { ConflictException, Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import { sha256, tokenAcak } from '../common/crypto/crypto';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { POOL } from '../database/tokens';
import { NotificationService } from '../notifications/notification.service';
import { TTL, normalisasiEmail } from './auth.constants';

export interface HasilUndangan {
  userId: string;
  /** Token mentah. JANGAN dikembalikan lewat API; hanya untuk kanal tepercaya (email, CLI bootstrap). */
  token: string;
  link: string;
}

@Injectable()
export class InvitationService {
  constructor(
    @Inject(POOL) private readonly pool: Pool,
    @Inject(ENV) private readonly env: Env,
    private readonly notif: NotificationService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Mengundang staff dalam transaksi `c` milik pemanggil (tanpa BEGIN/COMMIT dan tanpa audit; pemanggil mengaudit
   * setelah commit). Email yang sudah punya kredensial ditolak; undangan lama dicabut bila dikirim ulang.
   */
  async undangDi(c: PoolClient, p: { email: string; namaTampilan: string; diundangOleh: string | null; kirimEmail?: boolean; ttlMs?: number }): Promise<HasilUndangan> {
    const email = normalisasiEmail(p.email);
    const token = tokenAcak();
    const ada = await c.query(
      `SELECT u.id, EXISTS (SELECT 1 FROM staff_credentials k WHERE k.user_id = u.id) AS punya_kredensial
         FROM users u WHERE u.realm = 'staff' AND u.email = $1 FOR UPDATE`,
      [email],
    );
    let userId: string;
    if (ada.rowCount) {
      if (ada.rows[0].punya_kredensial) throw new ConflictException({ kode: 'EMAIL_SUDAH_TERDAFTAR', message: 'Email sudah terdaftar' });
      userId = ada.rows[0].id;
      await c.query(`UPDATE staff_invitations SET revoked_at = now() WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL`, [userId]);
    } else {
      const person = await c.query(`INSERT INTO persons (display_name) VALUES ($1) RETURNING id`, [p.namaTampilan.trim()]);
      const u = await c.query(`INSERT INTO users (person_id, realm, email, status) VALUES ($1, 'staff', $2, 'DIUNDANG') RETURNING id`, [person.rows[0].id, email]);
      userId = u.rows[0].id;
    }
    await c.query(
      `INSERT INTO staff_invitations (user_id, token_hash, invited_by, expires_at) VALUES ($1, $2, $3, now() + ($4 * interval '1 millisecond'))`,
      [userId, sha256(token), p.diundangOleh, p.ttlMs ?? TTL.undanganMs],
    );
    const link = `${this.env.APP_BASE_URL}/undangan?token=${token}`;
    if (p.kirimEmail !== false) {
      await this.notif.enqueueEmail({ to: email, template: 'undangan_staff', data: { nama: p.namaTampilan.trim(), link } }, c);
    }
    return { userId, token, link };
  }

  /** Mengundang staff dalam transaksinya sendiri, lalu mengaudit. */
  async undang(p: { email: string; namaTampilan: string; diundangOleh: string | null; kirimEmail?: boolean }): Promise<HasilUndangan> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const hasil = await this.undangDi(c, p);
      await c.query('COMMIT');
      await this.audit.catat({ aksi: 'auth.invitation.created', aktorId: p.diundangOleh, objek: 'user', objekId: hasil.userId, detail: { emailDikirim: p.kirimEmail !== false } });
      return hasil;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }
}
