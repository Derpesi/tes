import { readFileSync, readdirSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';

/**
 * Regresi Fase 10: `jose` dipakai kode runtime tetapi hanya terdaftar di devDependencies, sehingga image produksi (pnpm deploy --prod)
 * gagal start ("Cannot find module 'jose'"). Tes ini memastikan semua modul eksternal yang diimpor kode non-tes (kecuali impor tipe)
 * terdaftar di `dependencies`.
 */
const akar = join(__dirname, '..', '..');
const kumpulkan = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? kumpulkan(p) : p.endsWith('.ts') && !p.endsWith('.spec.ts') ? [p] : [];
  });
const namaPaket = (m: string) => (m.startsWith('@') ? m.split('/').slice(0, 2).join('/') : m.split('/')[0]);

describe('dependensi runtime', () => {
  it('semua impor eksternal kode produksi terdaftar di dependencies (bukan hanya devDependencies)', () => {
    const pkg = JSON.parse(readFileSync(join(akar, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    const sah = new Set([...Object.keys(pkg.dependencies), ...builtinModules]);
    const hilang = new Set<string>();
    for (const f of kumpulkan(join(akar, 'src'))) {
      const isi = readFileSync(f, 'utf8');
      for (const m of isi.matchAll(/^\s*(import(?!\s+type)[^'"\n]*?from|export[^'"\n]*?from|import)\s*['"]([^'"]+)['"]/gm)) {
        const mod = m[2];
        if (mod.startsWith('.') || mod.startsWith('node:')) continue;
        if (!sah.has(namaPaket(mod))) hilang.add(namaPaket(mod));
      }
      for (const m of isi.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        if (!m[1].startsWith('.') && !m[1].startsWith('node:') && !sah.has(namaPaket(m[1]))) hilang.add(namaPaket(m[1]));
      }
    }
    expect([...hilang]).toEqual([]);
  });
});
