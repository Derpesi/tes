#!/usr/bin/env node
// Cadangan HRIS: dump PostgreSQL konsisten (satu snapshot) + hitungan baris per tabel + arsip penyimpanan objek + manifes checksum.
// Pakai: BACKUP_DATABASE_URL=... BACKUP_DIR=/mnt/cadangan [STORAGE_DIR=...] [BACKUP_PASSPHRASE_FILE=/rahasia/frasa] [RETENSI_HARI=14] node scripts/ops/backup.mjs
// - BACKUP_DATABASE_URL = role cadangan KHUSUS (LOGIN, BYPASSRLS, hanya baca; mis. GRANT pg_read_all_data). RLS dipaksa pada tabel tenant sehingga role aplikasi
//   TIDAK dapat membuat cadangan lengkap (pg_dump menolak, hitungan baris akan 0). Skrip menolak role yang tidak bisa melewati RLS.
// - Hasil: $BACKUP_DIR/hris-<UTC>/{db.dump[.enc], objek.tar[.enc], manifes.json}. Enkripsi: openssl aes-256-cbc -pbkdf2 (dapat dibuka dengan openssl biasa).
// - FRASA SANDI dan APP_ENCRYPTION_KEY dicadangkan TERPISAH dari data; tanpa APP_ENCRYPTION_KEY berkas selfie/dokumen/NIK tidak terbaca.
// - Tidak mencetak URL/kata sandi. Tidak menghapus apa pun kecuali set cadangan lama yang cocok pola hris-<UTC> bila RETENSI_HARI diisi.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const pg = require('pg');

const url = process.env.BACKUP_DATABASE_URL;
const dir = process.env.BACKUP_DIR;
if (!url || !dir) throw new Error('BACKUP_DATABASE_URL dan BACKUP_DIR wajib diisi');
const frasa = process.env.BACKUP_PASSPHRASE_FILE;
if (frasa && !existsSync(frasa)) throw new Error('BACKUP_PASSPHRASE_FILE tidak ditemukan');
const storage = process.env.STORAGE_DIR;
const retensi = process.env.RETENSI_HARI ? Number(process.env.RETENSI_HARI) : null;

const sha256 = (f) => new Promise((res, rej) => { const h = createHash('sha256'); createReadStream(f).on('data', (d) => h.update(d)).on('error', rej).on('end', () => res(h.digest('hex'))); });
const jalan = (cmd, args, opsi = {}) => new Promise((res, rej) => {
  const p = spawn(cmd, args, { stdio: ['ignore', 'inherit', 'pipe'], ...opsi });
  let err = '';
  p.stderr.on('data', (d) => { err += d; });
  p.on('close', (k) => (k === 0 ? res() : rej(new Error(`${cmd} gagal (kode ${k}): ${err.slice(-500)}`))));
});
const enkripsi = async (berkas) => {
  if (!frasa) return berkas;
  await jalan('openssl', ['enc', '-aes-256-cbc', '-pbkdf2', '-iter', '600000', '-salt', '-in', berkas, '-out', `${berkas}.enc`, '-pass', `file:${frasa}`]);
  rmSync(berkas);
  return `${berkas}.enc`;
};

const stempel = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const hasil = join(dir, `hris-${stempel}`);
mkdirSync(hasil, { recursive: true, mode: 0o700 });
const t0 = Date.now();

const klien = new pg.Client({ connectionString: url });
await klien.connect();
const peran = (await klien.query(`SELECT rolsuper OR rolbypassrls AS lolos FROM pg_roles WHERE rolname = current_user`)).rows[0];
if (!peran?.lolos) throw new Error('Role cadangan harus superuser atau BYPASSRLS (RLS dipaksa pada tabel tenant; role aplikasi menghasilkan cadangan kosong/ditolak)');
await klien.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
const snapshot = (await klien.query('SELECT pg_export_snapshot() AS s')).rows[0].s;
const tabel = (await klien.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY 1`)).rows.map((r) => r.relname);
const hitung = {};
for (const t of tabel) hitung[t] = Number((await klien.query(`SELECT count(*) AS n FROM "${t}"`)).rows[0].n);
const migrasi = (await klien.query(`SELECT count(*)::int AS n, max(name) AS terakhir FROM schema_migrations`)).rows[0];
const versiPg = (await klien.query('SHOW server_version')).rows[0].server_version;

// pg_dump memakai snapshot yang sama (sambungan ini tetap terbuka sampai selesai) -> hitungan baris persis sama dengan isi dump.
const dump = join(hasil, 'db.dump');
await jalan('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', `--snapshot=${snapshot}`, '--file', dump, '--dbname', url]);
await klien.query('COMMIT');
await klien.end();
const durasiDump = +((Date.now() - t0) / 1000).toFixed(1);

const berkas = [await enkripsi(dump)];
if (storage && existsSync(storage)) {
  const arsip = join(hasil, 'objek.tar');
  await jalan('tar', ['-cf', arsip, '-C', storage, '.']);
  berkas.push(await enkripsi(arsip));
}
const checksum = {};
for (const b of berkas) checksum[b.split('/').pop()] = { sha256: await sha256(b), bytes: statSync(b).size };
const manifes = {
  versi: 1, dibuat: new Date().toISOString(), format: 'pg_dump custom', terenkripsi: Boolean(frasa), serverPostgres: versiPg,
  migrasi, tabel: hitung, totalBaris: Object.values(hitung).reduce((a, b) => a + b, 0), berkas: checksum, durasiDumpDetik: durasiDump, durasiDetik: +((Date.now() - t0) / 1000).toFixed(1),
};
writeFileSync(join(hasil, 'manifes.json'), JSON.stringify(manifes, null, 2), { mode: 0o600 });

if (retensi) {
  const batas = Date.now() - retensi * 86400e3;
  for (const d of readdirSync(dir)) {
    if (!/^hris-\d{8}T\d{6}Z$/.test(d) || join(dir, d) === hasil) continue;
    if (statSync(join(dir, d)).mtimeMs < batas) { rmSync(join(dir, d), { recursive: true }); console.log(`Set cadangan lama dihapus: ${d}`); }
  }
}
console.log(`Cadangan selesai: ${hasil} (${manifes.durasiDetik} dtk, ${tabel.length} tabel, ${manifes.totalBaris} baris, terenkripsi=${manifes.terenkripsi})`);
