# Roadmap Pengembangan

Tiap fase: acceptance criteria → implementasi → tes → review → persetujuan pemilik sebelum lanjut.

| Fase | Isi | Gerbang selesai |
|---|---|---|
| 1 | Audit, SRS, arsitektur, ERD, RBAC, state machine | Disetujui (selesai) |
| 2A | Tata kelola: decision log, ADR, docs, CLAUDE.md, aturan | Review pemilik |
| 2B | Kerangka teknis: pnpm workspace, `apps/api`, `apps/web`, Docker Compose dev, migrasi awal | Build dan `/health` hijau |
| 2C | CI/CD: lint, tipe, tes, migrasi, OpenAPI diff, audit dependency, lisensi, gitleaks, CodeQL, Dependabot | CI hijau |
| 2D | Fondasi tes: harness isolasi perusahaan, harness RBAC, data sintetis, kerangka k6 | Harness gagal bila isolasi dilanggar |
| 3 | Auth Google OIDC, staff + MFA, sesi, RBAC + scope, persetujuan ganda, bootstrap admin, audit, UI minimal | **Selesai** (3A–3F); login Google sungguhan menunggu OAuth client pemilik |
| 4 | Multi-perusahaan dan master data (perusahaan, rekanan, lokasi, kontrak layanan) — **selesai, menunggu persetujuan pemilik** | Tambah perusahaan tanpa ubah kode |
| 5 | Registrasi member, biodata, verifikasi, lowongan, lamaran, seleksi | Alur member end-to-end |
| 6 | PKWT (PDF, unggah scan, verifikasi HRD) dan penempatan; dashboard karyawan aktif | Status berubah otomatis; API lamaran terblokir |
| 7 | Absensi QR + GPS + selfie, shift lintas tengah malam, hari libur, retensi selfie, koreksi, tinjauan | Skenario duplikat, luar radius, perangkat baru, lintas tengah malam lolos |
| 8 | Rekap payroll tahap awal + ekspor xlsx/CSV/PDF | Rekap dapat disetujui dan diekspor |
| 9 | Dashboard, laporan, penampil audit | Laporan sesuai role |
| 10 | Uji keamanan, uji beban (k6), latihan restore, persiapan deployment | Laporan uji; validasi A-01…A-05 |
| Berikutnya | Payroll penuh, slip, pembayaran, PSrE, WhatsApp/push (persetujuan terpisah) | — |

## Prioritas
- **MVP-1:** Fase 2 sampai 7 (operasional: member, rekrutmen, PKWT, penempatan, absensi).
- **MVP-2:** Fase 8 dan 9 (rekap payroll, dashboard, laporan).
- Fase 10 wajib sebelum produksi.

## Keputusan terbuka yang mempengaruhi jadwal
Penyedia hosting dan operator; admin awal dan Direktur; template PKWT resmi; warna dan logo final; penyedia email; format ekspor; lisensi dan visibilitas repo.
