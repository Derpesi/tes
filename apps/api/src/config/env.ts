import { z } from 'zod';

const skema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  DATABASE_URL: z
    .string({ error: 'DATABASE_URL wajib diisi' })
    .min(1, 'DATABASE_URL wajib diisi')
    .refine((v) => /^postgres(ql)?:\/\//.test(v), 'DATABASE_URL harus berformat postgres://'),
});

export type Env = z.infer<typeof skema>;

/** Memvalidasi variabel lingkungan. Tidak ada nilai default untuk rahasia. */
export function muatEnv(sumber: NodeJS.ProcessEnv = process.env): Env {
  const hasil = skema.safeParse(sumber);
  if (!hasil.success) {
    const rincian = hasil.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Konfigurasi tidak valid: ${rincian}`);
  }
  return hasil.data;
}
