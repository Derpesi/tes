# Tinjauan Keamanan (Fase 10A)

Status: **tinjauan sendiri berbasis uji otomatis — BUKAN uji penetrasi independen.** Uji penetrasi pihak ketiga direkomendasikan sebelum produksi (`ops/golive.md` #11). Dokumen ini memisahkan **bukti** (tes/kode yang dapat dijalankan ulang) dari **asumsi/keterbatasan**.

Tanggal: 2026-11-22. Lingkup: API NestJS, web Next.js, skema PostgreSQL/RLS. Di luar lingkup: infrastruktur hosting (belum ada), SMTP/Google (milik pemilik).

## 1. Metode
1. **Sapuan keamanan berbasis OpenAPI** (`apps/api/test/keamanan-sapuan.spec.ts`, 16 tes, ikut `test:integration`): seluruh rute dari `docs/openapi/openapi.json` diuji terhadap aplikasi nyata + PostgreSQL asli.
2. Tes keamanan yang sudah ada: autentikasi staf/member (`auth-staff.spec.ts`, `auth-member.spec.ts`), bootstrap, RBAC (`rbac.spec.ts`, enumerasi rute), harness isolasi RLS (`tests/`, 115 tes; harus gagal bila RLS dimatikan).
3. Audit dependensi (`pnpm audit`), kebijakan lisensi, gitleaks, CodeQL (CI).
4. Uji mutasi: perbaikan temuan dibuktikan oleh tes yang **gagal** bila perbaikan dibalik.

## 2. Temuan dan status
| # | Temuan (ditemukan sapuan 10A) | Dampak | Status |
|---|---|---|---|
| T-1 | Tanggal rusak pada query (`/attendance/recap`, `/reports/*`) → **HTTP 500** (zod 4 tetap menjalankan `refine` setelah regex gagal; `toISOString()` melempar RangeError) | Galat 5xx dari input klien; kebisingan alarm, potensi DoS ringan | **Diperbaiki**: `common/tanggal.ts` (`tanggalValid`) dipakai di 8 `schemas.ts`; tes unit + sapuan |
| T-2 | Body JSON > batas / JSON rusak → **500** (galat body-parser dibungkus sebagai galat internal) | Idem; pesan library mungkin bocor | **Diperbaiki**: `all-exceptions.filter` memetakan galat 4xx middleware ke status aslinya (400/413) dengan pesan Indonesia standar; tes |
| T-3 | Pembatas laju per **IP** → pengguna di satu NAT (kantor rekanan) saling memblokir; sekaligus mengancam target A-05 (10.000 check-in) | Ketersediaan | **Diperbaiki**: `ThrottlerSesiGuard` mengunci per pengguna (sesi sah) setelah `AuthGuard`; rute tanpa sesi tetap per IP; tes NAT |
| T-4 | Cookie sesi palsu berulang → setiap permintaan memicu kueri DB (amplifikasi) | DoS ringan | **Diperbaiki**: pembatas cookie tidak sah per IP (60/menit → 429 `TERLALU_BANYAK_PERMINTAAN`) |
| T-5 | API tanpa header keamanan; `/docs` dan `/openapi.json` terbuka di produksi | Permukaan serangan | **Diperbaiki**: `nosniff`, `no-store`, `no-referrer`, `X-Frame-Options: DENY`, `CORP same-origin`; dokumentasi mati di produksi kecuali `API_DOCS=on` |
| T-6 | Audit penuh dependensi: 4 kerentanan *moderate* pada `minimatch`/`glob` **hanya transitif dev** (jest) | Tidak masuk runtime produksi (`pnpm audit --prod` bersih) | **Diterima & dicatat**; pantau pembaruan jest |
| T-7 | Rotasi kunci enkripsi belum ada | Pemulihan pasca-kebocoran kunci sulit | **Terbuka** (`ops/secrets.md`; blokir go-live #8) |
| T-8 | Pembatas laju di memori per proses | Tidak berlaku lintas instans | **Terbuka** (satu instans; `ops/deploy.md`) |
| T-9 | CSP web masih `'unsafe-inline'` untuk skrip/gaya (Next tanpa nonce) | XSS mitigasi lebih lemah | **Diterima sementara** (dicatat di `next.config.mjs`); nonce = pekerjaan lanjutan |

## 3. Pemetaan OWASP ASVS 4.0 (ringkas, level 2) → bukti
| Bab | Kontrol utama | Bukti |
|---|---|---|
| V2 Autentikasi | Staf: password HRIS (argon2) + TOTP wajib; member: Google OIDC (PKCE, state, nonce, replay ditolak); kunci akun 5×; respons gagal seragam (anti-enumerasi); tidak ada kredensial bawaan | `auth-staff.spec.ts`, `auth-member.spec.ts`, `bootstrap.spec.ts`, `password.service.spec.ts` |
| V3 Sesi | Cookie `__Host-sid` (HttpOnly, Secure, SameSite), token acak 256-bit di-hash di DB, rotasi saat naik status, idle & absolut, cabut-semua | `auth-staff.spec.ts`; sapuan (sesi palsu → 401, pembatas cookie) |
| V4 Kontrol akses | Deny-by-default (guard global; rute wajib `@Public/@Sesi/@RequirePermission`), RBAC granular, isolasi perusahaan di backend + RLS, IDOR lintas perusahaan → 404 | `rbac.spec.ts` (enumerasi), `tests/` isolasi 115 tes, sapuan (member↔staf 403, staf tanpa peran 403) |
| V5 Validasi | Zod di semua input; UUID/tanggal/kursor rusak → 400; query berparameter; tanpa refleksi mentah | sapuan (injeksi SQLi/XSS/traversal/null byte pada query, body, UUID) |
| V7 Log & galat | Galat seragam berbahasa Indonesia, tanpa stack/pesan library; log tanpa query string, header sensitif di-redact | `all-exceptions.filter.spec.ts`, `log.spec.ts` |
| V8 Data | NIK/selfie/dokumen terenkripsi (AES-256-GCM) di penyimpanan; selfie bucket privat, akses teraudit, retensi | `absensi-*.spec.ts`, `pii` tes |
| V9 Komunikasi | HSTS + TLS di proxy (contoh), cookie Secure; `APP_BASE_URL` wajib https di produksi | `env.spec.ts` (produksi), `deploy/nginx.example.conf` |
| V10 Kode berbahaya | Dependensi diaudit, lisensi dikontrol, gitleaks/CodeQL | CI |
| V12 Berkas | Selfie: hanya JPEG ≤ 300 KB (magic bytes); dokumen: tipe/ukuran dibatasi, nama berkas tidak dipercaya | `absensi-scan.spec.ts`, `master-kontrak.spec.ts` |
| V13 API | Kontrak OpenAPI dari kode (CI mendeteksi perubahan); CSRF token + `Origin` pada method tulis; batas ukuran body & halaman | sapuan (CSRF/Origin pada **semua** rute tulis), `export:openapi` di CI |
| V14 Konfigurasi | Konfigurasi gagal-cepat (kunci lemah/sama, non-https, `STORAGE_DIR`), header keamanan, docs mati di produksi | `env.spec.ts`, sapuan (header) |

Kontrol ASVS yang **tidak** dinilai ada di sini karena bergantung infrastruktur: V1 arsitektur lanjut (ancaman terdistribusi), V9 detail TLS server, V14 hardening OS/kontainer.

## 4. Model ancaman ringkas (STRIDE per aliran)
| Aliran | Ancaman utama | Mitigasi | Sisa risiko |
|---|---|---|---|
| Login staf | Brute force, phishing, enumerasi | Argon2, kunci akun, TOTP wajib, respons seragam, throttle | Phishing TOTP (bukan WebAuthn) |
| Login member | Pengambilalihan akun Google, CSRF OIDC | PKCE+state+nonce, `returnTo` aman (fuzz), konflik identitas ditinjau staf | Akun Google member dikuasai pihak lain |
| Scan absen | Titip absen, GPS palsu, replay, QR difoto | Waktu server, idempotensi, geofence, perangkat terdaftar, anomali → tinjauan dua langkah, QR = pengenal titik bukan rahasia | **Tidak dapat dicegah penuh**: spoof GPS; mitigasi = tinjauan manusia |
| Selfie | Akses tak sah, kebocoran | Enkripsi, URL via API (bukan publik), izin + audit tiap akses, retensi + legal hold, **tanpa face recognition** | Penyalahgunaan petugas berwenang (terdeteksi lewat audit, bukan dicegah) |
| Payroll rekap | Manipulasi, penyetuju sama | 4 pelaku berbeda (CHECK DB + aplikasi), hash isi, koreksi bernomor, hanya-tambah | Kolusi antar-peran |
| Ekspor | Formula injection, kebocoran | Netralisasi `= + - @ TAB CR`, izin per ekspor, audit | Penerima berkas menyebarkan data |
| Admin/peran | Eskalasi | Persetujuan ganda peran tinggi, tidak ada Super Admin permanen, bootstrap sekali | Kompromi dua admin |

## 5. Yang dijalankan dan hasilnya (dapat diulang)
- `cd apps/api && pnpm exec jest --config jest.config.js --runInBand --testPathPatterns 'test/keamanan-sapuan'` — 16 lulus.
- Uji mutasi pada perbaikan: membalik `tanggalValid`, batas cookie palsu, `ThrottlerSesiGuard`, atau salah satu header → tes gagal (diverifikasi).
- `pnpm audit --prod --audit-level=low`: bersih. `pnpm audit` penuh: 4 moderate dev-only (T-6). `pnpm check:licenses`: lulus. gitleaks: tidak ada kebocoran.

## 6. Rekomendasi sebelum produksi
1. Uji penetrasi independen (blokir #11). 2. Rotasi kunci enkripsi (T-7). 3. CSP dengan nonce (T-9). 4. Pembatas laju bersama bila >1 instans (T-8). 5. Pemantauan 429/5xx (`ops/monitoring.md`).
