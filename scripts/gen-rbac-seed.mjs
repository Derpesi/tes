// Membangkitkan SQL seed peran dan permission dari docs/rbac.md + docs/rbac-pemetaan.json.
// Pakai: node scripts/gen-rbac-seed.mjs > db/migrations/<stempel>_rbac-seed.sql
import { readFileSync } from 'node:fs';

const md = readFileSync(new URL('../docs/rbac.md', import.meta.url), 'utf8');
const peta = JSON.parse(readFileSync(new URL('../docs/rbac-pemetaan.json', import.meta.url), 'utf8'));

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const uraiSel = (t) => {
  const b = t.replace(/\([^)]*\)/g, '').replace(/\*/g, '').trim();
  return b === '' || b === '–' || b === '-' ? [] : b.split(',').map((x) => x.trim()).filter(Boolean);
};

const baris = md.split('\n');
const awal = baris.findIndex((b) => /^\|\s*Modul\s*\|/.test(b));
if (awal < 0) throw new Error('Tabel matriks tidak ditemukan');
const potong = (b) => b.trim().replace(/^\||\|$/g, '').split('|').map((x) => x.trim());
const header = potong(baris[awal]).slice(1);

const perans = header.map((h) => {
  if (!peta.peran[h]) throw new Error(`Peran tanpa pemetaan: ${h}`);
  return { header: h, ...peta.peran[h] };
});
const perms = new Map(); // kode -> deskripsi
const rp = []; // [peran, permission]
for (let i = awal + 2; i < baris.length && baris[i].trim().startsWith('|'); i++) {
  const kol = potong(baris[i]);
  const slug = peta.modul[kol[0]];
  if (!slug) throw new Error(`Modul tanpa pemetaan: ${kol[0]}`);
  perans.forEach((p, idx) => {
    for (const kode of uraiSel(kol[idx + 1])) {
      const aksi = peta.aksi[kode];
      if (!aksi) throw new Error(`Kode izin tak dikenal: ${kode} (${kol[0]} / ${p.header})`);
      const code = `${slug}.${aksi}`;
      perms.set(code, `${kol[0]}: ${aksi}`);
      rp.push([p.kode, code]);
    }
  });
}

const out = [];
out.push('-- Up Migration');
out.push('-- DIBANGKITKAN oleh scripts/gen-rbac-seed.mjs dari docs/rbac.md. Jangan ubah manual;');
out.push('-- perubahan matriks dilakukan lewat migrasi baru (tes harness membandingkan DB dengan docs/rbac.md).');
out.push('INSERT INTO roles (code, name, high_privilege) VALUES');
out.push(perans.map((p) => `  (${q(p.kode)}, ${q(p.nama)}, ${p.tinggi})`).join(',\n') + ';');
out.push('INSERT INTO permissions (code, description) VALUES');
out.push([...perms].sort(([a], [b]) => a.localeCompare(b)).map(([c, d]) => `  (${q(c)}, ${q(d)})`).join(',\n') + ';');
out.push('INSERT INTO role_permissions (role_code, permission_code) VALUES');
out.push(rp.map(([r, p]) => `  (${q(r)}, ${q(p)})`).join(',\n') + ';');
out.push('');
out.push('-- Down Migration');
out.push('DELETE FROM role_permissions;');
out.push('DELETE FROM permissions;');
out.push('DELETE FROM roles;');
process.stdout.write(out.join('\n') + '\n');
