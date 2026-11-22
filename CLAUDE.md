# CLAUDE.md — DAMARINDO GROUP HRIS

## Proyek
HRIS outsourcing multi-perusahaan (PT. Damarindo Mandiri, PT. OSI, PT. Pancormas Perkasa; perusahaan baru lewat master data tanpa ubah kode).
Proprietary. Modular monolith: Next.js (`apps/web`) + NestJS (`apps/api`) + PostgreSQL. REST + OpenAPI.
Keputusan ada di `docs/architecture/` (ADR) dan `docs/decision-log.md`. Pisahkan KEPUTUSAN dari ASUMSI.

## Bahasa
Komunikasi, UI, pesan validasi, laporan, dokumen: Bahasa Indonesia. Identifier kode: bahasa Inggris.

## Aturan keras (tidak boleh dilanggar)
- Tidak ada portal/akun/login/dashboard rekanan. Rekanan = master data internal.
- Member: Google OIDC saja. Staff: password HRIS + MFA wajib. Jangan minta password Gmail.
- Isolasi perusahaan ditegakkan di backend + RLS, bukan filter frontend.
- Karyawan aktif diblokir melamar di backend (403), bukan hanya disembunyikan di UI.
- Tidak ada face recognition otomatis. Selfie hanya untuk petugas berwenang, bucket privat, retensi dapat dikonfigurasi.
- Tidak ada absensi offline. QR statis = pengenal titik, bukan rahasia.
- Payroll tahap awal = rekap & ekspor. Dilarang: hitung gaji final, slip, transfer dana otomatis.
- Uang: NUMERIC/Decimal, bukan float. Tarif/aturan regulasi = data berversi, bukan konstanta.
- Jangan mengarang klausul hukum PKWT; template resmi menyusul. Tombol "setuju" bukan tanda tangan sah.
- Tidak ada kredensial/email/OTP default; tidak ada Super Admin permanen.
- Jangan membuat logo pengganti. Jangan gunakan data pekerja nyata untuk tes.
- Jangan baca/tampilkan/commit rahasia. Jangan ubah visibilitas repo/lisensi tanpa persetujuan eksplisit.

## Alur kerja
Kerja per fase; tiap fase: acceptance criteria → implementasi → tes → review → persetujuan pemilik.
Branch kerja; commit atomik berbahasa Indonesia; jangan push ke `main`; PR/merge/deploy hanya atas permintaan.
Tes ditulis bersama kode. Fitur tanpa tes isolasi perusahaan & tes izin tidak dianggap selesai.

## Perintah
Prasyarat: Node ≥22.12, pnpm 10, PostgreSQL 16. User database dev perlu hak `CREATEROLE` (harness isolasi membuat role uji non-superuser). Salin `.env.example` ke `.env` dan isi sendiri (jangan commit). Secret auth wajib diisi, bangkitkan dengan `openssl rand -base64 32` (`AUTH_HMAC_KEY`, `APP_ENCRYPTION_KEY`) dan isi `APP_BASE_URL`; jangan set `NODE_ENV` di `.env`. Di balik reverse proxy set `TRUST_PROXY` (jumlah hop) agar IP klien benar. Login Google: isi `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` (lihat `docs/google-oauth-setup.md`); redirect URI = `<APP_BASE_URL><API_PUBLIC_PATH>/auth/member/google/callback` (bawaan `/api`).
- `pnpm install` — pasang dependency
- `pnpm dev:api` / `pnpm dev:web` — jalankan pengembangan (API :3001, web :3000)
- `pnpm lint` / `pnpm typecheck` / `pnpm test` — cek kualitas dan tes unit
- `pnpm test:integration` — tes integrasi (butuh `TEST_DATABASE_URL`, PostgreSQL asli)
- `pnpm build` — build semua aplikasi
- `pnpm db:migrate` / `pnpm db:rollback` — migrasi SQL di `db/migrations/` (butuh `DATABASE_URL`)
- `pnpm test:isolation` — tes isolasi perusahaan (RLS, PostgreSQL asli); `pnpm test:rbac` — tes matriks RBAC (tanpa DB)
- `pnpm bootstrap -- --email <email>` — bootstrap administrator awal (hanya di terminal interaktif server; lihat `docs/bootstrap-admin.md`)
- `pnpm test:e2e` — smoke E2E browser (Chromium 360 px; butuh `pnpm build`, PostgreSQL, dan Playwright; belum di CI)
- `pnpm test:scripts` — tes skrip repo (pemeriksa lisensi)
- `pnpm check:licenses` — cek kebijakan lisensi dependency (`.github/license-policy.json`)
- `pnpm export:openapi` — perbarui `docs/openapi/openapi.json` (CI gagal bila kontrak berubah tanpa commit ini)
- `pnpm load:seed` / `pnpm load:run` — dataset beban sintetis dan runner uji beban (hanya DB `*_load`, staging/lokal; lihat `docs/performance.md`)
- `pnpm ops:backup` / `ops:restore` / `ops:verifikasi` — cadangan/restore (role BYPASSRLS khusus; lihat `docs/ops/restore.md`)
- Deploy: `docs/ops/deploy.md`, daftar blokir go-live `docs/ops/golive.md`; contoh di `deploy/` (bukan konfigurasi final). Produksi: `APP_BASE_URL` https, `STORAGE_DIR` wajib, `API_DOCS` bawaan off, `DB_POOL_MAX` opsional; `GET /ready` untuk readiness.
- OpenAPI: `GET /openapi.json`, UI di `/docs` (mati di produksi kecuali `API_DOCS=on`).

## Rujukan
`docs/security-review.md`, `docs/performance.md`, `docs/ops/`, `docs/requirements.md`, `architecture.md`, `database.md`, `rbac.md`, `security.md`, `recruitment-workflow.md`, `attendance-workflow.md`, `payroll-workflow.md`, `development-roadmap.md`, `decision-log.md`.
