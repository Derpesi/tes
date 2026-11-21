# Catatan Keputusan (Decision Log)

Pisahkan **keputusan final** dari **asumsi sementara**. Asumsi tidak boleh diperlakukan sebagai fakta sebelum divalidasi.

## Keputusan Final
| ID | Keputusan |
|---|---|
| D-01 | ADR-0001: Next.js + TypeScript (web/PWA), NestJS + TypeScript (API), PostgreSQL, modular monolith, REST + OpenAPI, GitHub + GitHub Actions |
| D-02 | Repo private, proprietary, bukan open source. Perubahan lisensi dan visibilitas menunggu persetujuan eksplisit terpisah |
| D-03 | PKWT tahap awal: generate PDF, cetak, tanda tangan basah, scan dan unggah, verifikasi HRD; simpan versi, tanggal, petugas, audit. Siap integrasi PSrE kelak. Template resmi menyusul; tidak ada klausul hukum karangan |
| D-04 | Selfie langsung dari kamera sebagai bukti pendukung; tanpa face recognition otomatis di MVP; hanya petugas berwenang; private object storage; retensi dapat dikonfigurasi |
| D-05 | Asumsi kapasitas (lihat A-01) menjadi dasar capacity planning |
| D-06 | Hosting cloud/VPS region Indonesia; HTTPS, firewall, backup otomatis, monitoring, logging, rencana DR, staging terpisah dari production. Penyedia dan operator ditentukan kemudian |
| D-07 | Notifikasi MVP via email; abstraksi untuk WhatsApp Business API dan push; tanpa layanan berbayar tanpa persetujuan |
| D-08 | Absensi: shift pagi/siang/malam, lintas tengah malam, jadwal fleksibel, hari libur, toleransi per shift/lokasi, check-in/out, QR cetak, GPS/geofence, selfie, koreksi dengan persetujuan, audit. Online-only |
| D-09 | Ekspor rekap payroll: xlsx, CSV, PDF; tanpa transfer otomatis |
| D-10 | Bootstrap admin aman, sekali pakai, teraudit; tanpa email/password/OTP default; tanpa Super Admin permanen |
| D-11 | Brand DAMARINDO GROUP; navy, putih, gold; warna final dan logo resmi menyusul; tanpa logo pengganti |
| D-12 | Member belum ditempatkan melihat dan melamar lowongan semua perusahaan Group; lowongan wajib punya perusahaan pengelola; karyawan aktif diblokir di frontend dan backend |
| D-13 | Member: Google OIDC saja. Staff: password HRIS + MFA wajib. Tanpa portal/akun rekanan. Payroll tahap awal hanya rekap |

## Asumsi Sementara (belum divalidasi)
| ID | Asumsi | Validasi |
|---|---|---|
| A-01 | Awal: 1.000 pekerja, 50 rekanan, 100 lokasi. Target 2 tahun: 10.000, 300, 500 | Data riil + uji beban |
| A-02 | RPO 24 jam, RTO 8 jam (bukan SLA) | Latihan restore |
| A-03 | Retensi selfie 90 hari | Tinjauan hukum/PDP + operasional |
| A-04 | Halaman mobile ≤3 dtk di 4G; scan absensi p95 ≤1–2 dtk pada 100 req/dtk | Uji beban k6 |
| A-05 | Puncak absensi: 10.000 check-in dalam ±15 menit (≈11 req/dtk rata-rata, burst ≈100) | Pola shift riil |
| A-06 | Antrean latar pakai PostgreSQL (pg-boss), tanpa Redis di awal | Uji beban |
| A-07 | Migrasi SQL-first + query builder (mis. Kysely), bukan ORM penuh | ADR-0002 |
| A-08 | Selfie terkompresi ≤150 KB: ≈4 GB/hari dan ≈360 GB pada retensi 90 hari (10.000 pekerja) | Ukur di staging |
| A-09 | Penampil selfie: Manager Operasional, Staff Payroll Absensi Rekanan, Staff Payroll Internal | Persetujuan pemilik |
| A-10 | Library: openid-client, otplib, argon2id, exceljs, pdfkit/pdfmake, pino, @nestjs/swagger, pnpm workspace | ADR-0002 + cek lisensi |
| A-11 | Penyedia email belum dipilih; dev memakai Mailpit lokal | Pemilik menentukan |
| A-12 | Isolasi perusahaan via `set_config('app.company_ids')` per transaksi + `enable_tenant_rls` (ADR-0003, diusulkan) | Harness 2D, lalu modul pertama dan uji beban |
| A-13 | ~~`audit_logs` dikecualikan sementara dari RLS~~ **DITUTUP di Fase 3A**: `audit_logs` memakai kebijakan RLS khusus (baca per scope atau global bila `app.audit_global`; tulis selalu boleh); pengecualian registri kosong | Tes `audit-rls` dan registri |

## Masih Terbuka
Penyedia hosting dan operator server; identitas admin awal dan Direktur; template PKWT resmi; warna dan logo final; penyedia email; format kolom ekspor payroll; nama badan hukum pemegang hak cipta; visibilitas repo dan lisensi proprietary.
