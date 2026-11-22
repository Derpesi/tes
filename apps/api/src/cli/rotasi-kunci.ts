// CLI rotasi kunci enkripsi (ADR-0013). Dijalankan OPERATOR di server (bukan endpoint publik); di image: node dist/cli/rotasi-kunci.js <perintah>
// Pemakaian: ROTASI_DATABASE_URL=<role BYPASSRLS> node dist/cli/rotasi-kunci.js cek|jalan|verifikasi [--kering] [--batas 500] [--jeda-ms 0]
// Kunci dibaca dari APP_ENCRYPTION_KEYS (atau APP_ENCRYPTION_KEY) seperti aplikasi; id tertinggi = aktif. Tidak mencetak nilai rahasia.
import { join } from 'node:path';
import { Pool } from 'pg';
import { cincinKunci } from '../common/crypto/crypto';
import { LocalObjectStorage } from '../common/storage/local-storage';
import { daftarKunciEnkripsi, muatEnv } from '../config/env';
import { type Perintah, jalankanRotasi } from '../ops/rotasi-kunci';

function argumen(nama: string): string | undefined {
  const i = process.argv.indexOf(`--${nama}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function utama(): Promise<number> {
  const perintah = process.argv[2] as Perintah;
  if (!['cek', 'jalan', 'verifikasi'].includes(perintah)) {
    console.error('Pemakaian: node dist/cli/rotasi-kunci.js cek|jalan|verifikasi [--kering] [--batas N] [--jeda-ms N]');
    return 2;
  }
  const url = process.env.ROTASI_DATABASE_URL;
  if (!url) {
    console.error('ROTASI_DATABASE_URL wajib diisi (role BYPASSRLS khusus; bukan DATABASE_URL aplikasi)');
    return 2;
  }
  const env = muatEnv();
  const kunci = cincinKunci(daftarKunciEnkripsi(env).map((k) => ({ id: k.id, kunci: Buffer.from(k.b64, 'base64') })));
  const storage = new LocalObjectStorage(env.STORAGE_DIR ?? join(process.cwd(), '.penyimpanan'));
  const pool = new Pool({ connectionString: url, max: 2 });
  try {
    const batas = argumen('batas') ? Number(argumen('batas')) : 500;
    if (!Number.isInteger(batas) || batas < 1 || batas > 5000) throw new Error('--batas harus bilangan bulat 1-5000');
    const jedaMs = argumen('jeda-ms') ? Number(argumen('jeda-ms')) : 0;
    if (!Number.isInteger(jedaMs) || jedaMs < 0 || jedaMs > 60000) throw new Error('--jeda-ms harus bilangan bulat 0-60000');
    const r = await jalankanRotasi({ pool, kunci, storage, perintah, batas, jedaMs, kering: process.argv.includes('--kering'), log: (m) => console.error(m) });
    console.log(`\nKunci aktif: id ${r.kunciAktif}${r.kering ? ' (percobaan kering, tidak ada perubahan)' : ''}`);
    for (const h of r.hasil) {
      const versi = Object.entries(h.perVersi).map(([v, n]) => `${v === 'lama' ? 'format lama' : `v${v}`}=${n}`).join(', ') || '-';
      console.log(`- ${h.nama}: total ${h.total}; ${versi}; diubah ${h.diubah}; gagal dekripsi ${h.gagalDekripsi}; berubah serentak ${h.berubahSerentak}; objek hilang ${h.hilang}`);
    }
    console.log(r.bersih ? '\nSemua data berada pada kunci aktif.' : '\nMasih ada data yang belum pada kunci aktif atau tidak terbaca.');
    // verifikasi: kode 1 bila belum bersih; jalan: kode 1 bila ada yang gagal dekripsi.
    if (perintah === 'verifikasi') return r.bersih ? 0 : 1;
    return r.hasil.some((h) => h.gagalDekripsi > 0) ? 1 : 0;
  } catch (e) {
    console.error(`Gagal: ${(e as Error).message}`);
    return 1;
  } finally {
    await pool.end();
  }
}

utama().then((k) => process.exit(k));
