import { BadRequestException, PipeTransform } from '@nestjs/common';
import type { z } from 'zod';

/** Validasi body dengan zod; pesan kesalahan berbahasa Indonesia, tanpa mengulang nilai input. */
export class ZodPipe<T> implements PipeTransform {
  constructor(private readonly skema: z.ZodType<T>) {}
  transform(nilai: unknown): T {
    const r = this.skema.safeParse(nilai);
    if (!r.success) {
      throw new BadRequestException({
        kode: 'VALIDASI_GAGAL',
        message: r.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; '),
      });
    }
    return r.data;
  }
}
