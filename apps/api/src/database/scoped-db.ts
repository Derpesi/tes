import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { POOL } from './tokens';

export interface ScopeDb {
  /** Perusahaan yang boleh diakses. Diturunkan dari sesi di server, TIDAK PERNAH dari input klien. */
  companyIds: string[];
  /** Izinkan membaca baris audit global (company_id NULL). Hanya untuk izin audit global. */
  auditGlobal?: boolean;
  /** Member membaca lowongan DIBUKA semua perusahaan (kebijakan RLS lowongan_baca_member). Hanya untuk rute member. */
  memberRead?: boolean;
  /** Person milik sesi member (dari server, bukan input klien): membatasi lamaran ke miliknya sendiri lewat RLS. */
  memberPersonId?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Menjalankan fn dalam satu transaksi dengan scope perusahaan diberlakukan di database (RLS, ADR-0003).
 * Setelan memakai set_config(..., true) sehingga hanya berlaku di transaksi ini dan tidak bocor ke
 * request lain pada koneksi pool yang sama. Aplikasi WAJIB terhubung sebagai role non-superuser.
 */
@Injectable()
export class ScopedDb {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  async tx<T>(scope: ScopeDb, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    for (const id of scope.companyIds) {
      if (!UUID.test(id)) throw new Error('Scope perusahaan tidak valid');
    }
    if (scope.memberPersonId !== undefined && !UUID.test(scope.memberPersonId)) throw new Error('Person member tidak valid');
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.company_ids', $1, true)`, [scope.companyIds.join(',')]);
      await c.query(`SELECT set_config('app.audit_global', $1, true)`, [scope.auditGlobal ? 'on' : 'off']);
      await c.query(`SELECT set_config('app.member_read', $1, true)`, [scope.memberRead ? 'on' : 'off']);
      await c.query(`SELECT set_config('app.member_person_id', $1, true)`, [scope.memberPersonId ?? '']);
      const hasil = await fn(c);
      await c.query('COMMIT');
      return hasil;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }
}
