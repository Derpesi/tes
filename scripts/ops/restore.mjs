#!/usr/bin/env node
// Restore cadangan ke database BARU yang kosong, lalu verifikasi terhadap manifes.
// Pakai: TARGET_DATABASE_URL=<DB kosong> [RESTORE_OWNER_ROLE=<role pemilik skema>] [BACKUP_PASSPHRASE_FILE=...] [STORAGE_TARGET_DIR=<folder objek>] node scripts/ops/restore.mjs <folder cadangan hris-...>
// - TARGET_DATABASE_URL harus role superuser/BYPASSRLS: validasi FK pada tabel yang RLS-nya dipaksa gagal untuk role biasa (ditemukan saat latihan restore).
// - RESTORE_OWNER_ROLE: role target harus ANGGOTA role pemilik (GRANT <pemilik> TO <admin>). Setelah restore, kepemilikan tabel/sekuens/view/fungsi dialihkan ke role ini (cadangan dibuat tanpa pemilik). Hak (GRANT) role aplikasi
//   TIDAK ikut cadangan: terapkan ulang provisioning (docs/ops/deploy.md).
// Menolak menimpa: database target harus tanpa tabel di skema public. Tidak pernah menyentuh database sumber.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const pg = require('pg');
const folder = process.argv[2];
const url = process.env.TARGET_DATABASE_URL;
const frasa = process.env.BACKUP_PASSPHRASE_FILE;
if (!folder || !url) throw new Error('Folder cadangan dan TARGET_DATABASE_URL wajib diisi');
const manifes = JSON.parse(readFileSync(join(folder, 'manifes.json'), 'utf8'));
if (manifes.terenkripsi && !frasa) throw new Error('Cadangan terenkripsi: BACKUP_PASSPHRASE_FILE wajib diisi');

const sha256 = (f) => new Promise((res, rej) => { const h = createHash('sha256'); createReadStream(f).on('data', (d) => h.update(d)).on('error', rej).on('end', () => res(h.digest('hex'))); });
const jalan = (cmd, args, env) => new Promise((res, rej) => {
  const p = spawn(cmd, args, { stdio: ['ignore', 'inherit', 'pipe'], ...(env ? { env: { ...process.env, ...env } } : {}) });
  let err = '';
  p.stderr.on('data', (d) => { err += d; });
  p.on('close', (k) => (k === 0 ? res() : rej(new Error(`${cmd} gagal (kode ${k}): ${err.slice(-500)}`))));
});
const t0 = Date.now();
const langkah = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

// 1. Checksum berkas.
for (const [nama, info] of Object.entries(manifes.berkas)) {
  const h = await sha256(join(folder, nama));
  if (h !== info.sha256) throw new Error(`Checksum tidak cocok: ${nama} (cadangan rusak atau diubah)`);
}
langkah('checksum berkas cocok');

// 2. Target harus kosong.
const c2 = new pg.Client({ connectionString: url });
await c2.connect();
const ada = (await c2.query(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'`)).rows[0].n;
const peran = (await c2.query(`SELECT rolsuper OR rolbypassrls AS lolos FROM pg_roles WHERE rolname = current_user`)).rows[0];
if (!peran?.lolos) throw new Error('TARGET_DATABASE_URL harus role superuser atau BYPASSRLS (RLS dipaksa; validasi FK gagal untuk role biasa)');
if (ada > 0) throw new Error(`Menolak: database target sudah berisi ${ada} tabel. Gunakan database kosong baru.`);
await c2.end();

// 3. Dekripsi bila perlu, lalu pg_restore.
const namaDump = Object.keys(manifes.berkas).find((n) => n.startsWith('db.dump'));
let dump = join(folder, namaDump);
const sementara = [];
if (namaDump.endsWith('.enc')) {
  dump = `${dump}.dec`; sementara.push(dump);
  await jalan('openssl', ['enc', '-d', '-aes-256-cbc', '-pbkdf2', '-iter', '600000', '-in', join(folder, namaDump), '-out', dump, '-pass', `file:${frasa}`]);
  langkah('dump didekripsi');
}
await jalan('pg_restore', ['--no-owner', '--no-privileges', '--exit-on-error', '--jobs', '4', '--dbname', url, dump]);
langkah('pg_restore selesai');
for (const s of sementara) rmSync(s, { force: true });
const pemilik = process.env.RESTORE_OWNER_ROLE;
if (pemilik) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(pemilik)) throw new Error('RESTORE_OWNER_ROLE tidak valid');
  const cp = new pg.Client({ connectionString: url });
  await cp.connect();
  await cp.query(`GRANT CREATE ON SCHEMA public TO ${pemilik}`); // syarat ALTER ... OWNER TO (PostgreSQL 15+: public tidak lagi terbuka)
  await cp.query(`DO $$ DECLARE r record; BEGIN
    FOR r IN SELECT format('ALTER TABLE %I.%I OWNER TO ${pemilik}', schemaname, tablename) AS q FROM pg_tables WHERE schemaname = 'public'
             UNION ALL SELECT format('ALTER SEQUENCE %I.%I OWNER TO ${pemilik}', schemaname, sequencename) FROM pg_sequences WHERE schemaname = 'public'
             UNION ALL SELECT format('ALTER VIEW %I.%I OWNER TO ${pemilik}', schemaname, viewname) FROM pg_views WHERE schemaname = 'public'
             UNION ALL SELECT format('ALTER FUNCTION %s OWNER TO ${pemilik}', p.oid::regprocedure) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
    LOOP EXECUTE r.q; END LOOP; END $$`);
  await cp.end();
  langkah(`kepemilikan dialihkan ke ${pemilik}`);
}

// 4. Objek (opsional).
const namaObjek = Object.keys(manifes.berkas).find((n) => n.startsWith('objek.tar'));
if (namaObjek && process.env.STORAGE_TARGET_DIR) {
  mkdirSync(process.env.STORAGE_TARGET_DIR, { recursive: true, mode: 0o700 });
  let arsip = join(folder, namaObjek);
  if (namaObjek.endsWith('.enc')) {
    arsip = `${arsip}.dec`;
    await jalan('openssl', ['enc', '-d', '-aes-256-cbc', '-pbkdf2', '-iter', '600000', '-in', join(folder, namaObjek), '-out', arsip, '-pass', `file:${frasa}`]);
  }
  await jalan('tar', ['-xf', arsip, '-C', process.env.STORAGE_TARGET_DIR]);
  if (arsip.endsWith('.dec')) rmSync(arsip, { force: true });
  langkah('objek dipulihkan');
}

// 5. Verifikasi.
await jalan('node', [fileURLToPath(new URL('./verifikasi-restore.mjs', import.meta.url)), join(folder, 'manifes.json')], { DATABASE_URL: url });
langkah(`restore + verifikasi selesai`);
