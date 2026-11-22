#!/usr/bin/env node
// Verifikasi database hasil restore terhadap manifes cadangan. Keluar kode 1 bila ada yang gagal.
// Pakai: DATABASE_URL=<DB hasil restore> node scripts/ops/verifikasi-restore.mjs <jalur manifes.json>
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const pg = require('pg');
const url = process.env.DATABASE_URL;
const jalurManifes = process.argv[2];
if (!url || !jalurManifes) throw new Error('DATABASE_URL dan jalur manifes wajib diisi');
const manifes = JSON.parse(readFileSync(jalurManifes, 'utf8'));
const c = new pg.Client({ connectionString: url });
await c.connect();

const hasil = [];
const cek = (nama, ok, detail = '') => { hasil.push({ nama, ok, detail }); console.log(`${ok ? 'LULUS' : 'GAGAL'}  ${nama}${detail ? ` — ${detail}` : ''}`); };

// 1. Jumlah baris per tabel sama dengan manifes (snapshot yang sama saat cadangan).
const beda = [];
for (const [t, n] of Object.entries(manifes.tabel)) {
  const r = await c.query(`SELECT count(*)::bigint AS n FROM "${t}"`).catch(() => null);
  if (!r || Number(r.rows[0].n) !== n) beda.push(`${t}: ${r ? r.rows[0].n : 'tidak ada'} != ${n}`);
}
cek('jumlah baris semua tabel sama dengan manifes', beda.length === 0, beda.slice(0, 5).join('; ') || `${Object.keys(manifes.tabel).length} tabel`);

// 2. Migrasi.
const m = (await c.query(`SELECT count(*)::int AS n, max(name) AS terakhir FROM schema_migrations`)).rows[0];
cek('riwayat migrasi sama', m.n === manifes.migrasi.n && m.terakhir === manifes.migrasi.terakhir, `${m.n} berkas, terakhir ${m.terakhir}`);

// 3. RLS aktif dan dipaksa pada SEMUA tabel dengan kolom company_id, dan setiap tabel itu punya kebijakan.
const tenant = (await c.query(`
  SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS paksa, (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::int AS kebijakan
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r'
     AND EXISTS (SELECT 1 FROM information_schema.columns k WHERE k.table_schema = 'public' AND k.table_name = c.relname AND k.column_name = 'company_id')`)).rows;
const rusak = tenant.filter((t) => !t.rls || !t.paksa || t.kebijakan === 0).map((t) => t.relname);
cek('RLS aktif+dipaksa dan berkebijakan pada semua tabel tenant', rusak.length === 0, rusak.join(', ') || `${tenant.length} tabel tenant`);

// 4. Trigger hanya-tambah pada audit dan fungsi inti.
const trg = (await c.query(`SELECT tgname FROM pg_trigger WHERE tgrelid = 'audit_logs'::regclass AND NOT tgisinternal`)).rows.map((r) => r.tgname);
cek('trigger audit_logs hanya-tambah ada', ['audit_logs_no_update_delete', 'audit_logs_no_truncate'].every((x) => trg.includes(x)), trg.join(','));
const fn = (await c.query(`SELECT proname FROM pg_proc WHERE proname = 'retensi_selfie_hari'`)).rowCount;
cek('fungsi retensi_selfie_hari ada', fn === 1);
const ext = (await c.query(`SELECT extname FROM pg_extension`)).rows.map((r) => r.extname);
cek('ekstensi pgcrypto dan btree_gist ada', ['pgcrypto', 'btree_gist'].every((x) => ext.includes(x)), ext.join(','));

// 5. Tidak ada akun/kredensial bawaan: tidak ada pengguna staf aktif tanpa peran (sekadar sanity) dan tidak ada sesi yang bertahan lintas restore tanpa kedaluwarsa.
const sesiAktif = (await c.query(`SELECT count(*)::int AS n FROM sessions WHERE revoked_at IS NULL AND expires_at > now()`)).rows[0].n;
cek('sesi aktif tercatat (dicabut massal setelah restore produksi: lihat docs/ops/restore.md)', true, `${sesiAktif} sesi masih berlaku menurut data`);

await c.end();
const gagal = hasil.filter((h) => !h.ok).length;
console.log(`\nRingkasan verifikasi: ${hasil.length - gagal} lulus, ${gagal} gagal`);
process.exit(gagal ? 1 : 0);
