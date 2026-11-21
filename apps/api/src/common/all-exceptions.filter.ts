import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';

const PESAN_STANDAR: Record<number, string> = {
  400: 'Permintaan tidak valid',
  401: 'Anda belum masuk atau sesi telah berakhir',
  403: 'Anda tidak memiliki izin untuk tindakan ini',
  404: 'Data tidak ditemukan',
  409: 'Terjadi konflik data',
  429: 'Terlalu banyak permintaan, coba lagi nanti',
  500: 'Terjadi kesalahan pada server',
  503: 'Layanan sedang tidak tersedia',
};

/** Bentuk error seragam, berbahasa Indonesia, tanpa membocorkan detail internal. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    // Pesan bawaan framework/library berbahasa Inggris tidak boleh bocor ke pengguna. Pesan khusus hanya
    // dipakai bila exception membawa `kode` (dibuat oleh aplikasi ini, berbahasa Indonesia).
    let pesan = PESAN_STANDAR[status] ?? PESAN_STANDAR[500];
    let kode = `HTTP_${status}`;
    let khusus = false; // exception buatan aplikasi (membawa `kode`) dan pesannya sudah dikurasi
    if (exception instanceof HttpException) {
      const r = exception.getResponse();
      if (typeof r === 'object' && r !== null && typeof (r as { kode?: unknown }).kode === 'string') {
        const o = r as { kode: string; message?: string | string[] };
        kode = o.kode;
        khusus = true;
        if (o.message) pesan = Array.isArray(o.message) ? o.message.join('; ') : o.message;
      }
    }
    // Galat tak terduga dicatat (pesan saja); galat terkurasi (mis. 503 terkonfigurasi) tidak membanjiri log sebagai ERROR.
    if (status >= 500 && !khusus) this.logger.error(exception instanceof Error ? exception.message : 'error tak dikenal');
    res.status(status).json({ statusCode: status, kode, pesan });
  }
}
