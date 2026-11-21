import { ConflictException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { AuditService, EntriAudit } from '../audit/audit.service';
import { hmac } from '../common/crypto/crypto';
import { KUNCI, Kunci } from '../config/config.module';
import { POOL } from '../database/tokens';
import { TTL, normalisasiEmail } from './auth.constants';
import { InvitationService } from './invitation.service';

export type ModeBootstrap = 'BARU' | 'UNDANGAN_ULANG' | 'BERI_ULANG_PERAN';

export interface HasilBootstrap {
  userId: string;
  mode: ModeBootstrap;
  /** Tautan sekali pakai. Hanya ada bila akun belum aktif. JANGAN ditulis ke log atau berkas. */
  link?: string;
  tautanBerlakuSampai?: Date;
}

const KUNCI_LOCK = 'hris-bootstrap-admin';
const GALAT_SELESAI = () => new ForbiddenException({ kode: 'BOOTSTRAP_SUDAH_SELESAI', message: 'Bootstrap sudah selesai (Direktur sudah aktif). Jalur ini ditutup.' });

/**
 * Bootstrap administrator awal. Dijalankan operator di server lewat CLI (BUKAN endpoint). Tanpa email/kata sandi/OTP
 * bawaan; tanpa Super Admin permanen: peran IT Administrator berasal dari bootstrap, berumur 7 hari sejak aktivasi,
 * dan dicabut otomatis begitu Direktur pertama aktif.
 */
@Injectable()
export class BootstrapService {
  constructor(
    @Inject(POOL) private readonly pool: Pool,
    @Inject(KUNCI) private readonly kunci: Kunci,
    private readonly invitations: InvitationService,
    private readonly audit: AuditService,
  ) {}

  private ref(email: string): string {
    return hmac(this.kunci.hmac, `email:${email}`).toString('hex').slice(0, 16);
  }

  async sudahSelesai(): Promise<boolean> {
    const r = await this.pool.query(`SELECT value FROM system_state WHERE key = 'bootstrapped'`);
    return r.rows[0]?.value === true;
  }

  async jalankan(p: { email: string; namaTampilan?: string; regenerate?: boolean }): Promise<HasilBootstrap> {
    const email = normalisasiEmail(p.email);
    if (!/^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254) {
      throw new ConflictException({ kode: 'EMAIL_TIDAK_VALID', message: 'Format email tidak valid' });
    }
    const nama = (p.namaTampilan?.trim() || 'Administrator Awal').slice(0, 100);
    const c = await this.pool.connect();
    const efek: EntriAudit[] = [];
    try {
      await c.query('BEGIN');
      await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [KUNCI_LOCK]); // cegah dua bootstrap bersamaan
      const st = await c.query(`SELECT value FROM system_state WHERE key = 'bootstrapped' FOR UPDATE`);
      if (st.rows[0]?.value === true) {
        efek.push({ aksi: 'auth.bootstrap.refused', detail: { alasan: 'sudah_selesai', emailRef: this.ref(email) } });
        throw GALAT_SELESAI();
      }
      const jumlah = await c.query(`SELECT count(*)::int AS n FROM users WHERE realm = 'staff'`);
      if (jumlah.rows[0].n > 0 && !p.regenerate) {
        efek.push({ aksi: 'auth.bootstrap.refused', detail: { alasan: 'staff_sudah_ada', emailRef: this.ref(email) } });
        throw new ConflictException({ kode: 'STAFF_SUDAH_ADA', message: 'Sudah ada akun staff. Jika bootstrap belum selesai (belum ada Direktur aktif), jalankan dengan --regenerate.' });
      }
      if (p.regenerate) await this.cabutBootstrapLama(c, email);

      const ada = await c.query(`SELECT u.id, u.status, EXISTS (SELECT 1 FROM staff_credentials k WHERE k.user_id = u.id) AS kredensial FROM users u WHERE u.realm = 'staff' AND u.email = $1 FOR UPDATE`, [email]);
      let hasil: HasilBootstrap;
      if (ada.rowCount && ada.rows[0].status === 'NONAKTIF') {
        throw new ConflictException({ kode: 'STAFF_NONAKTIF', message: 'Akun dengan email ini sudah nonaktif; gunakan email lain' });
      } else if (ada.rowCount && ada.rows[0].kredensial) {
        // Admin bootstrap sebelumnya sudah aktif tetapi perannya habis: beri ulang peran (tanpa tautan baru).
        await this.beriPeran(c, ada.rows[0].id);
        hasil = { userId: ada.rows[0].id, mode: 'BERI_ULANG_PERAN' };
        efek.push({ aksi: 'auth.bootstrap.regenerated', objek: 'user', objekId: ada.rows[0].id, detail: { mode: hasil.mode, emailRef: this.ref(email) } });
      } else {
        const u = await this.invitations.undangDi(c, { email, namaTampilan: nama, diundangOleh: null, kirimEmail: false, ttlMs: TTL.undanganBootstrapMs });
        await this.beriPeran(c, u.userId);
        hasil = { userId: u.userId, mode: ada.rowCount ? 'UNDANGAN_ULANG' : 'BARU', link: u.link, tautanBerlakuSampai: new Date(Date.now() + TTL.undanganBootstrapMs) };
        efek.push({ aksi: p.regenerate ? 'auth.bootstrap.regenerated' : 'auth.bootstrap.started', objek: 'user', objekId: u.userId, detail: { mode: hasil.mode, emailRef: this.ref(email) } });
      }
      await c.query('COMMIT');
      for (const e of efek) await this.audit.catat(e);
      return hasil;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      for (const x of efek) if (x.aksi === 'auth.bootstrap.refused') await this.audit.catat(x);
      throw e;
    } finally {
      c.release();
    }
  }

  /** Peran IT Administrator asal bootstrap: tanpa pemberi, berumur 7 hari (dihitung ulang saat aktivasi). */
  private async beriPeran(c: PoolClient, userId: string) {
    await c.query(
      `INSERT INTO user_roles (user_id, role_code, grant_source, granted_by, expires_at)
       VALUES ($1, 'IT_ADMIN', 'BOOTSTRAP', NULL, now() + ($2 * interval '1 millisecond'))
       ON CONFLICT (user_id, role_code) WHERE revoked_at IS NULL DO UPDATE SET expires_at = EXCLUDED.expires_at`,
      [userId, TTL.peranBootstrapMs],
    );
  }

  /** --regenerate: mencabut peran bootstrap lama; akun belum aktif milik bootstrap lama (selain email yang sama) dinonaktifkan. */
  private async cabutBootstrapLama(c: PoolClient, emailBaru: string) {
    const lama = await c.query(`SELECT DISTINCT user_id FROM user_roles WHERE grant_source = 'BOOTSTRAP' AND revoked_at IS NULL`);
    const ids = lama.rows.map((x) => x.user_id as string);
    if (!ids.length) return;
    await c.query(`UPDATE user_roles SET revoked_at = now() WHERE user_id = ANY($1) AND grant_source = 'BOOTSTRAP' AND revoked_at IS NULL`, [ids]);
    await c.query(`UPDATE staff_invitations SET revoked_at = now() WHERE user_id = ANY($1) AND used_at IS NULL AND revoked_at IS NULL`, [ids]);
    await c.query(`UPDATE users SET status = 'NONAKTIF', updated_at = now() WHERE id = ANY($1) AND status = 'DIUNDANG' AND email <> $2`, [ids, emailBaru]);
  }

  /**
   * Dipanggil setelah staff menyelesaikan pendaftaran MFA (akun aktif): (1) umur peran bootstrap dihitung dari aktivasi;
   * (2) bila yang aktif adalah Direktur, bootstrap SELESAI: jalur ditutup dan peran bootstrap dicabut.
   */
  async setelahAktivasi(userId: string): Promise<void> {
    const efek: EntriAudit[] = [];
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [KUNCI_LOCK]);
      await c.query(`UPDATE user_roles SET expires_at = now() + ($2 * interval '1 millisecond') WHERE user_id = $1 AND grant_source = 'BOOTSTRAP' AND revoked_at IS NULL`, [userId, TTL.peranBootstrapMs]);
      const direktur = await c.query(`SELECT 1 FROM user_roles r JOIN users u ON u.id = r.user_id WHERE r.user_id = $1 AND r.role_code = 'DIREKTUR' AND r.revoked_at IS NULL AND (r.expires_at IS NULL OR r.expires_at > now()) AND u.status = 'AKTIF'`, [userId]);
      if (direktur.rowCount) {
        const st = await c.query(`UPDATE system_state SET value = 'true'::jsonb, updated_at = now() WHERE key = 'bootstrapped' AND value = 'false'::jsonb RETURNING key`);
        if (st.rowCount) {
          await c.query(`UPDATE user_roles SET revoked_at = now() WHERE grant_source = 'BOOTSTRAP' AND revoked_at IS NULL`);
          await c.query(`UPDATE staff_invitations SET revoked_at = now() WHERE used_at IS NULL AND revoked_at IS NULL AND user_id IN (SELECT user_id FROM user_roles WHERE grant_source = 'BOOTSTRAP')`);
          efek.push({ aksi: 'auth.bootstrap.completed', aktorId: userId, objek: 'user', objekId: userId });
        }
      }
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
    for (const e of efek) await this.audit.catat(e);
  }
}
