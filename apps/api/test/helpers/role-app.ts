import { Pool } from 'pg';

/**
 * Syarat produksi (ADR-0003): aplikasi berjalan sebagai role NON-superuser tanpa BYPASSRLS. Superuser mem-bypass RLS, sehingga di CI
 * (user DB = superuser) aplikasi dijalankan lewat role uji agar tes isolasi bermakna. Mengembalikan DATABASE_URL untuk aplikasi.
 */
export async function urlAplikasiTanpaBypass(dbUrl: string): Promise<string> {
  const admin = new Pool({ connectionString: dbUrl, max: 1 });
  try {
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hris_app_uji') THEN CREATE ROLE hris_app_uji NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$`);
    await admin.query(`GRANT hris_app_uji TO CURRENT_USER`);
    await admin.query(`GRANT ALL ON ALL TABLES IN SCHEMA public TO hris_app_uji`);
    await admin.query(`GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO hris_app_uji`);
  } finally {
    await admin.end();
  }
  return `${dbUrl}${dbUrl.includes('?') ? '&' : '?'}options=${encodeURIComponent('-c role=hris_app_uji')}`;
}
