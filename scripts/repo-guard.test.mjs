// Regresi Fase 11A: dua kegagalan CI yang tidak tertangkap gate lokal.
// 1) Penjaga "Cek berkas sensitif" di CI menolak berkas contoh bernama .env.* (selain .env.example).
// 2) Dockerfile harus menyalin semua berkas akar yang di-`extends` oleh tsconfig aplikasi (mis. tsconfig.base.json); tanpa itu tsc di image memakai bawaan dan gagal.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const akar = join(dirname(fileURLToPath(import.meta.url)), '..');
// Salinan pola penjaga di .github/workflows/ci.yml (jaga tetap sama).
const POLA_SENSITIF = /(^|\/)\.env($|\.)|\.pem$|\.key$|\.p12$|\.pfx$|\.keystore$|\.jks$/;

test('tidak ada berkas ter-track yang cocok pola penjaga berkas sensitif CI', () => {
  const terlacak = execFileSync('git', ['ls-files'], { cwd: akar, encoding: 'utf8' }).split('\n').filter(Boolean);
  const salah = terlacak.filter((f) => POLA_SENSITIF.test(f) && !f.endsWith('.env.example'));
  assert.deepEqual(salah, [], 'ganti nama (mis. env.produksi.contoh) agar tidak cocok pola penjaga');
});

test('pola penjaga di tes ini sama dengan di ci.yml', () => {
  const ci = readFileSync(join(akar, '.github/workflows/ci.yml'), 'utf8');
  assert.ok(ci.includes("'(^|/)\\.env($|\\.)|\\.pem$|\\.key$|\\.p12$|\\.pfx$|\\.keystore$|\\.jks$'"), 'pola di ci.yml berubah; samakan tes ini');
});

for (const app of ['api', 'web']) {
  test(`Dockerfile ${app}: semua berkas akar yang di-extends tsconfig apps/${app} disalin (COPY)`, () => {
    const dockerfile = readFileSync(join(akar, `apps/${app}/Dockerfile`), 'utf8');
    const disalin = dockerfile.split('\n').filter((l) => /^COPY\s/.test(l) && !l.includes('--from=')).join('\n');
    const tsconfigs = [`apps/${app}/tsconfig.json`, `apps/${app}/tsconfig.build.json`].filter((f) => existsSync(join(akar, f)));
    const dibutuhkan = new Set();
    for (const f of tsconfigs) {
      const ext = JSON.parse(readFileSync(join(akar, f), 'utf8')).extends;
      if (!ext) continue;
      const tujuan = relative(akar, normalize(join(dirname(join(akar, f)), ext)));
      if (!tujuan.startsWith(`apps/${app}/`)) dibutuhkan.add(tujuan); // berkas di luar folder aplikasi harus disalin eksplisit
    }
    for (const b of dibutuhkan) assert.ok(disalin.includes(b), `Dockerfile ${app} tidak menyalin ${b} (di-extends tsconfig)`);
  });
}
