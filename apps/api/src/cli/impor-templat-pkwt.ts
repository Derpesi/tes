// CLI impor templat PKWT dari berkas isi milik pemilik (ADR-0015). Dijalankan OPERATOR di server; di image: node dist/cli/impor-templat-pkwt.js
// Pemakaian: IMPOR_DATABASE_URL=<role BYPASSRLS> node dist/cli/impor-templat-pkwt.js --isi <isi.txt> --oleh <userId staf> [--perusahaan <id>] [--nama "PKWT Alih Daya (draf 2022)"] [--pengaturan <json>] [--kering]
// Templat berstatus BELUM_DIVERIFIKASI; verifikasi dilakukan staf berwenang (bukan pembuat) lewat aplikasi. Tidak mencetak isi templat.
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { imporTemplatPkwt } from '../ops/impor-templat-pkwt';

function argumen(nama: string): string | undefined {
  const i = process.argv.indexOf(`--${nama}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function utama(): Promise<number> {
  const url = process.env.IMPOR_DATABASE_URL;
  const berkasIsi = argumen('isi');
  const oleh = argumen('oleh');
  if (!url || !berkasIsi || !oleh) {
    console.error('Pemakaian: IMPOR_DATABASE_URL=<role BYPASSRLS> node dist/cli/impor-templat-pkwt.js --isi <isi.txt> --oleh <userId staf> [--perusahaan <id>] [--nama "..."] [--pengaturan <json>] [--kering]');
    return 2;
  }
  const pool = new Pool({ connectionString: url, max: 2 });
  try {
    const berkasPengaturan = argumen('pengaturan');
    const h = await imporTemplatPkwt({
      pool,
      isi: readFileSync(berkasIsi, 'utf8'),
      nama: argumen('nama') ?? 'PKWT Alih Daya (draf 2022)',
      perusahaanId: argumen('perusahaan'),
      oleh,
      pengaturan: berkasPengaturan ? JSON.parse(readFileSync(berkasPengaturan, 'utf8')) : undefined,
      kering: process.argv.includes('--kering'),
    });
    console.log(h.kering ? '\nPercobaan kering (tidak ada perubahan):' : '\nHasil impor:');
    for (const p of h.perusahaan) console.log(`- ${p.nama}: templat ${p.templat} (versi ${p.versi}); pengaturan PKWT ${p.pengaturan}`);
    console.log('\nTemplat berstatus BELUM_DIVERIFIKASI. Verifikasi oleh staf berwenang yang bukan pembuat sebelum dipakai (PDF tetap diberi peringatan draf sebelum itu).');
    return 0;
  } catch (e) {
    console.error(`Gagal: ${(e as Error).message}`);
    return 1;
  } finally {
    await pool.end();
  }
}

utama().then((k) => process.exit(k));
