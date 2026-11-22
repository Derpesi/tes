import { CallHandler, ExecutionContext, HttpException, HttpStatus, Injectable, NestInterceptor } from '@nestjs/common';
import type { Response } from 'express';
import { from, lastValueFrom, Observable } from 'rxjs';

/**
 * Pembatas konkurensi dalam proses (semaphore + antrean pendek). Dipakai agar kueri berat (laporan, rekap) tidak menguras kolam koneksi DB
 * sehingga jalur kritis (scan absen) tetap responsif: pada uji beban 10B, 12 req/dtk pembacaan berat membuat semua endpoint antre 40–90 dtk.
 * Keterbatasan: per proses (API satu instans; A-52).
 */
export class SistemSibuk extends HttpException {
  constructor(retryAfterDetik: number) {
    super({ kode: 'SISTEM_SIBUK', message: 'Sistem sedang sibuk memproses laporan lain. Coba lagi sebentar lagi', retryAfter: retryAfterDetik }, HttpStatus.SERVICE_UNAVAILABLE);
  }
}

export class BatasKonkurensi {
  private berjalan = 0;
  private readonly antre: Array<{ lanjut: () => void; batal: () => void }> = [];

  constructor(
    private maks: number,
    private antreanMaks: number,
    private tungguMs: number,
  ) {}

  atur(maks: number, antreanMaks: number, tungguMs: number): void {
    this.maks = maks;
    this.antreanMaks = antreanMaks;
    this.tungguMs = tungguMs;
  }

  get status(): { berjalan: number; antre: number } {
    return { berjalan: this.berjalan, antre: this.antre.length };
  }

  private async masuk(): Promise<void> {
    if (this.berjalan < this.maks) {
      this.berjalan++;
      return;
    }
    if (this.antre.length >= this.antreanMaks) throw new SistemSibuk(Math.ceil(this.tungguMs / 1000));
    await new Promise<void>((resolve, reject) => {
      const entri = {
        lanjut: () => { clearTimeout(timer); resolve(); }, // slot sudah dialihkan oleh keluar(): berjalan tidak berubah
        batal: () => reject(new SistemSibuk(Math.ceil(this.tungguMs / 1000))),
      };
      const timer = setTimeout(() => {
        const i = this.antre.indexOf(entri);
        if (i >= 0) {
          this.antre.splice(i, 1);
          entri.batal();
        }
      }, this.tungguMs);
      this.antre.push(entri);
    });
  }

  private keluar(): void {
    const berikut = this.antre.shift();
    if (berikut) berikut.lanjut(); // alihkan slot ke penunggu berikutnya
    else this.berjalan--;
  }

  async jalankan<T>(fn: () => Promise<T>): Promise<T> {
    await this.masuk();
    try {
      return await fn();
    } finally {
      this.keluar();
    }
  }
}

/** Batas bersama untuk semua rute laporan/rekap berat. Nilai awal dari env BATAS_LAPORAN_BERAT (bawaan 2), antrean 20, tunggu 10 dtk. */
export const batasLaporanBerat = new BatasKonkurensi(Number(process.env.BATAS_LAPORAN_BERAT) || 2, 20, 10_000);

/** Pasang pada rute berat: `@UseInterceptors(LaporanBeratInterceptor)`. Di atas batas + antrean → 503 SISTEM_SIBUK dengan Retry-After. */
@Injectable()
export class LaporanBeratInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const res = ctx.switchToHttp().getResponse<Response>();
    return from(
      batasLaporanBerat.jalankan(() => lastValueFrom(next.handle(), { defaultValue: undefined })).catch((e) => {
        if (e instanceof SistemSibuk) res.set('Retry-After', String((e.getResponse() as { retryAfter: number }).retryAfter));
        throw e;
      }),
    );
  }
}
