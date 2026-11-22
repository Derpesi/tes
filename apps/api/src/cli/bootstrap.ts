// CLI bootstrap administrator awal. Dijalankan OPERATOR di server (bukan endpoint publik).
// Pemakaian: pnpm bootstrap -- --email admin@contoh.id [--nama "Nama Admin"] [--regenerate]
// Tautan sekali pakai dicetak SEKALI ke terminal interaktif; tidak ditulis ke log, berkas, atau database.
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { BootstrapService } from '../auth/bootstrap.service';

function argumen(nama: string): string | undefined {
  const i = process.argv.indexOf(`--${nama}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function utama(): Promise<number> {
  const email = argumen('email');
  if (!email || email.startsWith('--')) {
    console.error('Pemakaian: pnpm bootstrap -- --email <email-admin> [--nama "<nama>"] [--regenerate]');
    return 2;
  }
  if (!process.stdout.isTTY) {
    console.error('Ditolak: jalankan di terminal interaktif. Tautan bootstrap tidak boleh dialihkan ke berkas atau log.');
    return 3;
  }
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  try {
    const hasil = await app.get(BootstrapService).jalankan({ email, namaTampilan: argumen('nama'), regenerate: process.argv.includes('--regenerate') });
    if (hasil.link) {
      console.log('\nBootstrap berhasil. Tautan berikut HANYA ditampilkan sekali dan berlaku 24 jam:\n');
      console.log(`  ${hasil.link}\n`);
      console.log('Kirim tautan ini langsung kepada pemilik email (jangan lewat kanal yang tersimpan).');
      console.log('Pemilik harus membuat kata sandi dan mendaftarkan verifikasi dua langkah (TOTP).');
    } else {
      console.log('Peran administrator awal diberikan kembali (7 hari). Tidak ada tautan baru karena akun sudah aktif.');
    }
    console.log('Peran IT Administrator awal berlaku 7 hari sejak aktivasi dan dicabut otomatis saat Direktur pertama aktif.');
    return 0;
  } catch (e) {
    console.error(`Gagal: ${(e as { response?: { message?: string } }).response?.message ?? (e as Error).message}`);
    return 1;
  } finally {
    await app.close();
  }
}

utama().then((k) => process.exit(k));
