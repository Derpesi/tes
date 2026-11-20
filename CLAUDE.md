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
Prasyarat: Node 22, pnpm 10, PostgreSQL 16. Salin `.env.example` ke `.env` dan isi sendiri (jangan commit).
- `pnpm install` — pasang dependency
- `pnpm dev:api` / `pnpm dev:web` — jalankan pengembangan (API :3001, web :3000)
- `pnpm lint` / `pnpm typecheck` / `pnpm test` — cek kualitas dan tes unit
- `pnpm test:integration` — tes integrasi (butuh `TEST_DATABASE_URL`, PostgreSQL asli)
- `pnpm build` — build semua aplikasi
- `pnpm db:migrate` / `pnpm db:rollback` — migrasi SQL di `db/migrations/` (butuh `DATABASE_URL`)
- OpenAPI: `GET /openapi.json`, UI di `/docs`.

## Rujukan
`docs/requirements.md`, `architecture.md`, `database.md`, `rbac.md`, `security.md`, `recruitment-workflow.md`, `attendance-workflow.md`, `payroll-workflow.md`, `development-roadmap.md`, `decision-log.md`.
