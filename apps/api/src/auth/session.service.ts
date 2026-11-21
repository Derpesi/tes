import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { hmac, sha256, tokenAcak } from '../common/crypto/crypto';
import { KUNCI, Kunci } from '../config/config.module';
import { POOL } from '../database/tokens';
import { Realm, StateSesi, TTL } from './auth.constants';

export interface SesiAktif {
  id: string;
  userId: string;
  realm: Realm;
  state: StateSesi;
  email: string;
  expiresAt: Date;
}

export interface SesiBaru {
  token: string;
  csrfToken: string;
  expiresAt: Date;
  maxAgeMs: number;
}

@Injectable()
export class SessionService {
  constructor(
    @Inject(POOL) private readonly pool: Pool,
    @Inject(KUNCI) private readonly kunci: Kunci,
  ) {}

  /** Token CSRF diturunkan dari id sesi (terikat sesi, tanpa penyimpanan tambahan). */
  csrfToken(sesiId: string): string {
    return hmac(this.kunci.hmac, `csrf:${sesiId}`).toString('base64url');
  }

  async buat(p: { userId: string; realm: Realm; state: StateSesi; userAgent?: string }): Promise<SesiBaru> {
    const token = tokenAcak();
    const maxAgeMs = p.state !== 'PENUH' ? TTL.tertundaMs : p.realm === 'member' ? TTL.memberAbsoluteMs : TTL.staffAbsoluteMs;
    const r = await this.pool.query(
      `INSERT INTO sessions (user_id, realm, token_hash, state, expires_at, user_agent)
       VALUES ($1, $2, $3, $4, now() + ($5 * interval '1 millisecond'), $6) RETURNING id, expires_at`,
      [p.userId, p.realm, sha256(token), p.state, maxAgeMs, p.userAgent?.slice(0, 200) ?? null],
    );
    return { token, csrfToken: this.csrfToken(r.rows[0].id), expiresAt: r.rows[0].expires_at, maxAgeMs };
  }

  /** Mencari sesi yang masih berlaku (belum dicabut, belum lewat batas mutlak maupun batas tidak aktif). */
  async cari(token: string): Promise<SesiAktif | null> {
    const r = await this.pool.query(
      `SELECT s.id, s.user_id, s.realm, s.state, s.expires_at, u.email
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.status <> 'NONAKTIF'
          AND s.last_seen_at > now() - (CASE
                WHEN s.state <> 'PENUH' THEN $3::bigint
                WHEN s.realm = 'member' THEN $4::bigint
                ELSE $2::bigint END) * interval '1 millisecond'`,
      [sha256(token), TTL.staffIdleMs, TTL.tertundaMs, TTL.memberIdleMs],
    );
    if (!r.rowCount) return null;
    const x = r.rows[0];
    // Perbarui last_seen paling sering sekali per menit agar tidak membebani database.
    await this.pool.query(`UPDATE sessions SET last_seen_at = now() WHERE id = $1 AND last_seen_at < now() - interval '60 seconds'`, [x.id]);
    return { id: x.id, userId: x.user_id, realm: x.realm, state: x.state, email: x.email, expiresAt: x.expires_at };
  }

  async cabut(sesiId: string, alasan: string): Promise<void> {
    await this.pool.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = $2 WHERE id = $1 AND revoked_at IS NULL`, [sesiId, alasan]);
  }

  async cabutSemuaUser(userId: string, alasan: string): Promise<void> {
    await this.pool.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = $2 WHERE user_id = $1 AND revoked_at IS NULL`, [userId, alasan]);
  }

  /** Rotasi: mencabut sesi lama dan membuat token baru (mencegah session fixation). */
  async rotasi(lama: SesiAktif, stateBaru: StateSesi, userAgent?: string): Promise<SesiBaru> {
    await this.cabut(lama.id, 'ROTASI');
    return this.buat({ userId: lama.userId, realm: lama.realm, state: stateBaru, userAgent });
  }
}
