# Keamanan

## Prinsip
Least privilege, deny-by-default, pertahanan berlapis, audit untuk aksi sensitif, data sensitif dilindungi, tidak ada rahasia di repo.

## Kontrol utama
| Area | Kontrol |
|---|---|
| Autentikasi | Member: Google OIDC (email terverifikasi). Staff: password HRIS (argon2id) + TOTP wajib; undangan saja; rate limit; kunci sementara; timeout sesi |
| Otorisasi | RBAC granular di backend; scope perusahaan + lokasi; pemisahan tugas; persetujuan ganda untuk peran tinggi |
| Isolasi | `company_id` + scope sesi + repositori + PostgreSQL RLS + tes kebocoran |
| Sesi | Cookie `HttpOnly`/`Secure`/`SameSite`; sesi di server; CSRF sesuai arsitektur |
| Data sensitif | Enkripsi saat disimpan; enkripsi level aplikasi untuk NIK dan rekening; log tanpa PII |
| File | Bucket privat, URL bertanda tangan singkat, validasi tipe/ukuran, pemindaian jika tersedia |
| Selfie | Hanya petugas berwenang, tanpa face recognition otomatis, retensi dapat dikonfigurasi dan diaudit |
| Audit | `audit_logs` append-only; aksi sensitif tercatat (siapa, apa, kapan, nilai lama/baru tanpa rahasia) |
| Rantai pasok | Audit dependency, kebijakan lisensi (larang GPL/AGPL/SSPL), SBOM, Dependabot, CodeQL |
| Rahasia | Variabel lingkungan/secret manager; gitleaks di CI; repo private; `.env.example` tanpa nilai |
| Pemulihan | Backup terenkripsi, uji restore berkala, rencana DR (RPO 24 jam, RTO 8 jam: asumsi) |

## Bootstrap admin
1. CLI `bootstrap` dijalankan operator di server (bukan endpoint publik), hanya saat belum ada staff.
2. Email admin diisi saat eksekusi (tanpa default); token sekali pakai (256-bit, disimpan hash, kedaluwarsa 24 jam).
3. Penerima menetapkan password sendiri dan wajib mendaftarkan TOTP sebelum akses.
4. Peran awal IT Administrator berumur terbatas (mis. 7 hari), bukan Super Admin permanen; wajib mengundang Direktur.
5. Setelah selesai jalur bootstrap mati, token dicabut, semua langkah diaudit. Prosedur break-glass terdokumentasi, nonaktif default, penggunaannya memicu alarm.

## Risiko utama dan mitigasi
| Risiko | Mitigasi |
|---|---|
| Kebocoran lintas perusahaan | Scope sesi server, RLS, tes otomatis |
| Pemalsuan absensi | QR bukan rahasia, geofence, selfie kamera, device binding, skor anomali, tinjauan manual; batas PWA didokumentasikan |
| Data biometrik/KTP (UU PDP) | Persetujuan, enkripsi, retensi tertulis, akses terlog |
| Kompromi akun staff | MFA wajib, hash kuat, rate limit, timeout |
| Penyalahgunaan hak admin | Persetujuan ganda, audit, IT tanpa akses nominal/PII |
| Manipulasi rekap payroll | Pemisahan tugas, immutability, koreksi bernomor versi |
| PKWT tidak sah | Tanda tangan basah + verifikasi HRD; template menunggu verifikasi hukum; tidak ada klausul karangan |
| Aturan regulasi berubah | Parameter berversi, verifikasi ahli |
| Kehilangan data | Backup, uji restore |
| Pekerja dirugikan GPS/sinyal buruk | Status `PERLU_VERIFIKASI`, bukan tolak otomatis |
| Rahasia bocor | Gitleaks, `.gitignore`, repo private |

## Hal yang belum diputuskan
Kebijakan retensi final, penyedia hosting dan operator, penyedia email, serta lisensi/visibilitas repo (menunggu persetujuan eksplisit).
