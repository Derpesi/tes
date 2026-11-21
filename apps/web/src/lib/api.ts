/** Klien API same-origin (jalur /api diteruskan ke NestJS lewat rewrite). Pesan galat berasal dari API (Indonesia). */
export class ApiError extends Error {
  readonly status: number;
  readonly kode: string;
  constructor(status: number, kode: string, pesan: string) {
    super(pesan);
    this.name = 'ApiError';
    this.status = status;
    this.kode = kode;
  }
}

export interface OpsiApi {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Token CSRF (wajib untuk method tulis pada rute bersesi). */
  csrf?: string;
}

export async function api<T = unknown>(path: string, opsi: OpsiApi = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (opsi.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opsi.csrf) headers['X-CSRF-Token'] = opsi.csrf;
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method: opsi.method ?? 'GET', headers, body: opsi.body === undefined ? undefined : JSON.stringify(opsi.body), credentials: 'same-origin', cache: 'no-store' });
  } catch {
    throw new ApiError(0, 'JARINGAN', 'Tidak dapat terhubung ke server. Periksa koneksi internet Anda dan coba lagi.');
  }
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => ({}))) as { pesan?: string; kode?: string };
  if (!res.ok) throw new ApiError(res.status, data.kode ?? `HTTP_${res.status}`, data.pesan ?? 'Terjadi kesalahan. Coba lagi.');
  return data as T;
}

export interface InfoSesi {
  realm: 'member' | 'staff';
  state: 'PENUH' | 'MENUNGGU_MFA' | 'MENUNGGU_ENROLL_MFA';
  user: { id: string; email: string };
  csrfToken: string;
  expiresAt: string;
  roles?: string[];
  permissions?: string[];
  companyIds?: string[];
  allCompanies?: boolean;
}

/** Mengambil info sesi (termasuk token CSRF). Mengembalikan null bila belum masuk. */
export async function ambilSesi(): Promise<InfoSesi | null> {
  try {
    return await api<InfoSesi>('/auth/session');
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return null;
    throw e;
  }
}
