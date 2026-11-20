// Pemeriksa kebijakan lisensi dependency. Pakai: node scripts/lisensi.mjs [--prod]
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dimulaiDengan = (nilai, daftar) => daftar.some((p) => nilai.toUpperCase().startsWith(p.toUpperCase()));

/** Mengembalikan daftar pelanggaran. Kosong = lolos. */
export function evaluasi(lisensiPerPaket, kebijakan) {
  const pelanggaran = [];
  const diizinkan = new Set(kebijakan.diizinkan);
  const pengecualian = new Set(kebijakan.pengecualian.map((p) => `${p.paket}|${p.lisensi}`));

  for (const [ekspresi, paket] of Object.entries(lisensiPerPaket)) {
    const nama = paket.map((p) => p.name);
    const atau = ekspresi.replace(/[()]/g, '').split(/\s+OR\s+/i);
    // Lolos bila salah satu alternatif OR terpenuhi seluruh bagian AND-nya.
    const alternatifOk = atau.some((alt) => alt.split(/\s+AND\s+/i).every((l) => diizinkan.has(l.trim())));
    if (alternatifOk) continue;

    const semuaToken = atau.flatMap((alt) => alt.split(/\s+AND\s+/i)).map((l) => l.trim());
    if (semuaToken.some((l) => dimulaiDengan(l, kebijakan.ditolakPrefiks))) {
      pelanggaran.push(`DITOLAK ${ekspresi}: ${nama.join(', ')}`);
      continue;
    }
    if (semuaToken.every((l) => diizinkan.has(l) || dimulaiDengan(l, kebijakan.perluTinjauPrefiks))) {
      for (const n of nama) {
        if (!pengecualian.has(`${n}|${ekspresi}`)) pelanggaran.push(`PERLU TINJAUAN (tanpa pengecualian) ${ekspresi}: ${n}`);
      }
      continue;
    }
    pelanggaran.push(`LISENSI TIDAK DIKENAL/DITOLAK ${ekspresi}: ${nama.join(', ')}`);
  }
  return pelanggaran;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const kebijakan = JSON.parse(readFileSync(new URL('../.github/license-policy.json', import.meta.url), 'utf8'));
  const args = process.argv.includes('--prod') ? ['licenses', 'list', '--prod', '--json'] : ['licenses', 'list', '--json'];
  const keluaran = execFileSync('pnpm', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const hasil = evaluasi(JSON.parse(keluaran), kebijakan);
  if (hasil.length) {
    console.error('Pelanggaran kebijakan lisensi:\n- ' + hasil.join('\n- '));
    process.exit(1);
  }
  console.log('Kebijakan lisensi terpenuhi.');
}
