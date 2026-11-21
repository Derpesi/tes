import { z } from 'zod';

export const ISSUER_GOOGLE = 'https://accounts.google.com';

/** String kosong dari .env dianggap tidak diisi. */
const opsional = <T extends z.ZodType>(skema: T) => z.preprocess((v) => (v === '' ? undefined : v), skema.optional());

/** Kunci base64 dengan panjang byte minimal/tepat. Tidak ada nilai default untuk rahasia. */
const kunciBase64 = (nama: string, byte: { min?: number; tepat?: number }) =>
  z
    .string({ error: `${nama} wajib diisi` })
    .min(1, `${nama} wajib diisi`)
    .refine((v) => {
      const b = Buffer.from(v, 'base64');
      if (b.toString('base64').replace(/=+$/, '') !== v.replace(/=+$/, '')) return false;
      return byte.tepat !== undefined ? b.length === byte.tepat : b.length >= (byte.min ?? 0);
    }, byte.tepat !== undefined ? `${nama} harus base64 dari tepat ${byte.tepat} byte` : `${nama} harus base64 minimal ${byte.min} byte`);

const skema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    DATABASE_URL: z
      .string({ error: 'DATABASE_URL wajib diisi' })
      .min(1, 'DATABASE_URL wajib diisi')
      .refine((v) => /^postgres(ql)?:\/\//.test(v), 'DATABASE_URL harus berformat postgres://'),
    APP_BASE_URL: z
      .string({ error: 'APP_BASE_URL wajib diisi' })
      .url('APP_BASE_URL harus berupa URL')
      .refine((v) => !v.endsWith('/'), 'APP_BASE_URL tidak boleh diakhiri garis miring'),
    AUTH_HMAC_KEY: kunciBase64('AUTH_HMAC_KEY', { min: 32 }),
    APP_ENCRYPTION_KEY: kunciBase64('APP_ENCRYPTION_KEY', { tepat: 32 }),
    // Opsional sampai pemilik membuat kredensial; bila diisi harus lengkap (semua-atau-tidak-sama-sekali).
    /** Jumlah proxy tepercaya di depan API (untuk IP klien yang benar). 0 = tidak ada. */
    TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),
    GOOGLE_CLIENT_ID: opsional(z.string().min(1)),
    GOOGLE_CLIENT_SECRET: opsional(z.string().min(1)),
    /** Hanya untuk tes/pengembangan. Di produksi dikunci ke Google (lihat superRefine). */
    GOOGLE_ISSUER: z.preprocess((v) => (v === '' ? undefined : v), z.string().url('GOOGLE_ISSUER harus berupa URL').default(ISSUER_GOOGLE)),
    /** Prefiks jalur publik API di balik reverse proxy/rewrite (same-origin). Dipakai untuk redirect URI Google. */
    API_PUBLIC_PATH: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.string().regex(/^(\/[a-z0-9_-]+)+$/, 'API_PUBLIC_PATH harus berupa jalur seperti /api').default('/api'),
    ),
    SMTP_HOST: opsional(z.string().min(1)),
    SMTP_PORT: opsional(z.coerce.number().int().min(1).max(65535)),
    SMTP_FROM: opsional(z.string().min(3)),
    SMTP_USER: opsional(z.string().min(1)),
    SMTP_PASSWORD: opsional(z.string().min(1)),
  })
  .superRefine((v, ctx) => {
    const semuaAtauTidak = (nama: string, kunci: (keyof typeof v)[]) => {
      const terisi = kunci.filter((k) => v[k] !== undefined);
      if (terisi.length !== 0 && terisi.length !== kunci.length) {
        ctx.addIssue({ code: 'custom', path: [kunci[0] as string], message: `${nama}: isi semua variabel (${kunci.join(', ')}) atau kosongkan semuanya` });
      }
    };
    if (v.NODE_ENV === 'production' && v.GOOGLE_ISSUER !== ISSUER_GOOGLE) {
      ctx.addIssue({ code: 'custom', path: ['GOOGLE_ISSUER'], message: 'GOOGLE_ISSUER tidak boleh diubah di produksi' });
    }
    semuaAtauTidak('Google OAuth', ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']);
    semuaAtauTidak('SMTP', ['SMTP_HOST', 'SMTP_PORT', 'SMTP_FROM']);
    semuaAtauTidak('Autentikasi SMTP', ['SMTP_USER', 'SMTP_PASSWORD']);
  });

export type Env = z.infer<typeof skema>;

/** URL callback yang HARUS didaftarkan di Google Cloud Console (tepat sama). */
export function redirectUriGoogle(env: Pick<Env, 'APP_BASE_URL' | 'API_PUBLIC_PATH'>): string {
  return `${env.APP_BASE_URL}${env.API_PUBLIC_PATH}/auth/member/google/callback`;
}

/** Memvalidasi variabel lingkungan. Gagal cepat dengan pesan jelas; tidak pernah menampilkan nilainya. */
export function muatEnv(sumber: NodeJS.ProcessEnv = process.env): Env {
  const hasil = skema.safeParse(sumber);
  if (!hasil.success) {
    const rincian = hasil.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Konfigurasi tidak valid: ${rincian}`);
  }
  return hasil.data;
}
