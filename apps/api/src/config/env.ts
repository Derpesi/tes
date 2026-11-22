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

export interface KunciEnkripsiEnv {
  id: number;
  b64: string;
}

const base64Sah = (b64: string) => {
  const b = Buffer.from(b64, 'base64');
  return b.length === 32 && b.toString('base64').replace(/=+$/, '') === b64.replace(/=+$/, '');
};

/**
 * Mengurai kunci enkripsi dari APP_ENCRYPTION_KEYS ("1:b64,2:b64") atau APP_ENCRYPTION_KEY (= id 1). Mengembalikan null bila gagal
 * (isu dilaporkan ke ctx; nilai kunci tidak pernah masuk pesan).
 */
function urai(keys: string | undefined, tunggal: string | undefined, ctx: z.RefinementCtx): KunciEnkripsiEnv[] | null {
  const isu = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
  if (!keys && !tunggal) {
    isu('APP_ENCRYPTION_KEY', 'APP_ENCRYPTION_KEY wajib diisi (atau isi APP_ENCRYPTION_KEYS untuk kunci berversi)');
    return null;
  }
  if (!keys) return [{ id: 1, b64: tunggal! }];
  const hasil: KunciEnkripsiEnv[] = [];
  for (const bagian of keys.split(',')) {
    const m = /^(\d{1,3}):([A-Za-z0-9+/]+={0,2})$/.exec(bagian.trim());
    const id = m ? Number(m[1]) : 0;
    if (!m || id < 1 || id > 255) {
      isu('APP_ENCRYPTION_KEYS', 'APP_ENCRYPTION_KEYS harus berformat "id:base64,id:base64" dengan id 1-255');
      return null;
    }
    if (!base64Sah(m[2])) {
      isu('APP_ENCRYPTION_KEYS', `Kunci enkripsi id ${id} harus base64 dari tepat 32 byte`);
      return null;
    }
    hasil.push({ id, b64: m[2] });
  }
  if (new Set(hasil.map((k) => k.id)).size !== hasil.length) isu('APP_ENCRYPTION_KEYS', 'Id kunci enkripsi tidak boleh ganda');
  if (new Set(hasil.map((k) => k.b64)).size !== hasil.length) isu('APP_ENCRYPTION_KEYS', 'Nilai kunci enkripsi tidak boleh sama antar versi');
  if (tunggal && hasil.find((k) => k.id === 1)?.b64 !== tunggal) isu('APP_ENCRYPTION_KEY', 'APP_ENCRYPTION_KEY harus sama dengan kunci id 1 pada APP_ENCRYPTION_KEYS (atau kosongkan salah satunya)');
  return hasil;
}

/** Daftar kunci enkripsi dari env yang sudah lolos validasi (id naik). */
export const daftarKunciEnkripsi = (e: Pick<Env, 'APP_ENCRYPTION_KEYS' | 'APP_ENCRYPTION_KEY'>): KunciEnkripsiEnv[] =>
  e.APP_ENCRYPTION_KEYS
    ? e.APP_ENCRYPTION_KEYS.split(',').map((b) => { const [id, b64] = b.trim().split(':'); return { id: Number(id), b64 }; }).sort((a, b) => a.id - b.id)
    : [{ id: 1, b64: e.APP_ENCRYPTION_KEY! }];

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
    /** Kunci enkripsi tunggal (id 1). Dipakai bila APP_ENCRYPTION_KEYS kosong. */
    APP_ENCRYPTION_KEY: opsional(kunciBase64('APP_ENCRYPTION_KEY', { tepat: 32 })),
    /** Kunci enkripsi berversi untuk rotasi: "1:<base64>,2:<base64>"; id tertinggi = aktif (penulisan baru). Lihat ADR-0013. */
    APP_ENCRYPTION_KEYS: opsional(z.string().min(3)),
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
    /** Dokumentasi API (/docs, /openapi.json). Bawaan: mati di produksi, hidup selain itu (mengurangi permukaan serangan). */
    API_DOCS: opsional(z.enum(['on', 'off'], { error: 'API_DOCS harus on atau off' })),
    /** Selfie absensi (Fase 10+): bawaan MATI (ditiadakan sementara atas keputusan pemilik). `on` mewajibkan selfie JPEG dari kamera seperti rancangan ADR-0008. */
    ABSENSI_SELFIE: opsional(z.enum(['on', 'off'], { error: 'ABSENSI_SELFIE harus on atau off' })),
    /** Maksimum kueri laporan/rekap berat yang berjalan bersamaan per proses (sisanya antre; lewat antrean → 503). */
    BATAS_LAPORAN_BERAT: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().min(1, 'BATAS_LAPORAN_BERAT minimal 1').max(20, 'BATAS_LAPORAN_BERAT maksimal 20').default(2)),
    /** Ukuran maksimum pool koneksi PostgreSQL per proses API. */
    DB_POOL_MAX: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().min(2, 'DB_POOL_MAX minimal 2').max(100, 'DB_POOL_MAX maksimal 100').default(10)),
    /** Direktori penyimpanan objek (driver lokal). Bawaan ./.penyimpanan; di produksi gunakan volume privat. */
    STORAGE_DIR: opsional(z.string().min(1)),
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
    const kunciEnk = urai(v.APP_ENCRYPTION_KEYS, v.APP_ENCRYPTION_KEY, ctx);
    if (kunciEnk) {
      if (kunciEnk.some((k) => k.b64 === v.AUTH_HMAC_KEY)) ctx.addIssue({ code: 'custom', path: ['APP_ENCRYPTION_KEYS'], message: 'Kunci enkripsi dan AUTH_HMAC_KEY harus berbeda' });
    }
    if (v.NODE_ENV === 'production' && v.GOOGLE_ISSUER !== ISSUER_GOOGLE) {
      ctx.addIssue({ code: 'custom', path: ['GOOGLE_ISSUER'], message: 'GOOGLE_ISSUER tidak boleh diubah di produksi' });
    }
    if (v.NODE_ENV === 'production') {
      // http hanya untuk loopback (localhost = konteks aman bagi browser; dipakai E2E lokal). Domain publik wajib https.
      const loopback = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(v.APP_BASE_URL);
      if (!v.APP_BASE_URL.startsWith('https://') && !loopback) ctx.addIssue({ code: 'custom', path: ['APP_BASE_URL'], message: 'APP_BASE_URL harus https:// di produksi (cookie __Host- dan OIDC mensyaratkan HTTPS)' });
      if (!v.STORAGE_DIR) ctx.addIssue({ code: 'custom', path: ['STORAGE_DIR'], message: 'STORAGE_DIR wajib diisi di produksi (volume privat; tidak boleh memakai folder bawaan)' });
      if (new Set(Buffer.from(v.AUTH_HMAC_KEY, 'base64')).size < 8) ctx.addIssue({ code: 'custom', path: ['AUTH_HMAC_KEY'], message: 'AUTH_HMAC_KEY terlalu lemah (hampir seragam); bangkitkan dengan openssl rand -base64 32' });
      for (const k of kunciEnk ?? []) {
        if (new Set(Buffer.from(k.b64, 'base64')).size < 8) ctx.addIssue({ code: 'custom', path: ['APP_ENCRYPTION_KEYS'], message: `Kunci enkripsi id ${k.id} terlalu lemah (hampir seragam); bangkitkan dengan openssl rand -base64 32` });
      }
    }
    semuaAtauTidak('Google OAuth', ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']);
    semuaAtauTidak('SMTP', ['SMTP_HOST', 'SMTP_PORT', 'SMTP_FROM']);
    semuaAtauTidak('Autentikasi SMTP', ['SMTP_USER', 'SMTP_PASSWORD']);
  });

export type Env = z.infer<typeof skema>;

/** Apakah dokumentasi API dilayani. Produksi: mati kecuali API_DOCS=on. */
export const docsAktif = (e: Pick<Env, 'NODE_ENV' | 'API_DOCS'>): boolean => (e.API_DOCS ? e.API_DOCS === 'on' : e.NODE_ENV !== 'production');

/** Apakah selfie absensi diwajibkan/disimpan. Dibaca langsung dari lingkungan (murah, aman dipanggil per permintaan); nilainya divalidasi saat start oleh skema. */
export const selfieAktif = (sumber: NodeJS.ProcessEnv = process.env): boolean => sumber.ABSENSI_SELFIE === 'on';

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
