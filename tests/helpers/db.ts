import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Pool, PoolClient } from 'pg';

/** Role uji: bukan superuser, bukan owner tabel, tanpa BYPASSRLS. Mencerminkan role aplikasi produksi. */
export const ROLE_UJI = 'hris_app_uji';

export function bukaPool(): Pool {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL belum diatur');
  return new Pool({ connectionString: url, max: 4 });
}

/** Menjalankan migrasi ke database uji. */
export function migrasiNaik(): void {
  execFileSync('node', [join(__dirname, '..', '..', 'apps', 'api', 'scripts', 'migrate.js'), 'up'], {
    env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL },
  });
}

/**
 * Membuat role uji bila belum ada. Superuser mem-bypass RLS (bahkan dengan FORCE),
 * sehingga query isolasi WAJIB dijalankan lewat role ini, bukan langsung sebagai user koneksi.
 */
export async function siapkanRoleUji(pool: Pool): Promise<void> {
  await pool.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE_UJI}') THEN
      CREATE ROLE ${ROLE_UJI} NOLOGIN NOSUPERUSER NOBYPASSRLS;
    END IF;
  END $$`);
  await pool.query(`GRANT ${ROLE_UJI} TO CURRENT_USER`);
}

export interface OpsiScope {
  /** true = COMMIT (data tetap). Bawaan false = ROLLBACK agar tes tidak saling mempengaruhi. */
  commit?: boolean;
  /** true = izinkan membaca baris audit global (company_id NULL). */
  auditGlobal?: boolean;
}

/**
 * Menjalankan fn di dalam transaksi sebagai role uji dengan scope perusahaan tertentu.
 * Scope dikirim lewat set_config(..., true) (berlaku hanya dalam transaksi), seperti pada aplikasi.
 */
export async function dalamScope<T>(
  pool: Pool,
  companyIds: string[],
  fn: (c: PoolClient) => Promise<T>,
  opsi: OpsiScope = {},
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL ROLE ${ROLE_UJI}`);
    await c.query(`SELECT set_config('app.company_ids', $1, true)`, [companyIds.join(',')]);
    await c.query(`SELECT set_config('app.audit_global', $1, true)`, [opsi.auditGlobal ? 'on' : 'off']);
    const hasil = await fn(c);
    await c.query(opsi.commit ? 'COMMIT' : 'ROLLBACK');
    return hasil;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
