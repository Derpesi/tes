import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { POOL } from '../database/tokens';

/** person_id milik sesi member. Selalu dari database berdasarkan sesi (server), tidak pernah dari input klien. */
@Injectable()
export class MemberContextService {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  async personId(userId: string): Promise<string> {
    const r = await this.pool.query(`SELECT person_id FROM users WHERE id = $1 AND realm = 'member' AND status = 'AKTIF'`, [userId]);
    const p = r.rows[0]?.person_id as string | null | undefined;
    if (!p) throw new ForbiddenException({ kode: 'AKUN_MEMBER_TIDAK_VALID', message: 'Akun member tidak valid atau tidak aktif' });
    return p;
  }
}
