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
    if (status >= 500) this.logger.error(exception instanceof Error ? exception.message : 'error tak dikenal');

    let pesan = PESAN_STANDAR[status] ?? PESAN_STANDAR[500];
    if (exception instanceof HttpException && status < 500) {
      const r = exception.getResponse();
      const m = typeof r === 'string' ? r : (r as { message?: string | string[] }).message;
      if (m) pesan = Array.isArray(m) ? m.join('; ') : m;
    } else if (exception instanceof HttpException) {
      pesan = PESAN_STANDAR[status] ?? pesan;
    }
    res.status(status).json({ statusCode: status, kode: `HTTP_${status}`, pesan });
  }
}
