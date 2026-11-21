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

## Autentikasi staff (Fase 3B)
- **Alur:** undangan (token sekali pakai, 7 hari) → kata sandi → daftar TOTP (+10 kode pemulihan, ditampilkan sekali) → sesi penuh. Login: kata sandi → sesi *tertunda* → TOTP/kode pemulihan → sesi penuh. Sesi tertunda tidak dapat mengakses endpoint apa pun selain verifikasi MFA, info sesi, dan keluar.
- **Sesi:** server-side; hanya hash token disimpan; cookie `__Host-sid` (`HttpOnly`, `Secure`, `Path=/`, `SameSite=Lax`, tanpa `Domain`); token dirotasi saat naik state; reset password mencabut semua sesi; akun nonaktif langsung tidak berlaku.
- **CSRF:** `Origin` harus sama dengan `APP_BASE_URL` untuk semua method tulis (termasuk endpoint publik/login); sesi wajib membawa `X-CSRF-Token` yang diturunkan dari id sesi.
- **Anti enumerasi:** pesan dan bentuk respons login/lupa kata sandi sama untuk email terdaftar dan tidak; hash tiruan menyamakan waktu. Kunci akun dihitung dari `login_attempts` (email di-HMAC) sehingga email tak dikenal berperilaku sama.
- **Kunci akun:** 5 gagal berturut-turut (kata sandi atau MFA) → 15 menit; kegagalan MFA juga mencabut sesi tertunda.
- **TOTP:** secret dienkripsi AES-256-GCM (AAD terikat user); kode tidak dapat dipakai ulang (dua lapis: `afterTimeStep` dan `UPDATE` atomik); kode pemulihan di-HMAC dan sekali pakai.
- **Kata sandi:** argon2id; panjang 12–128; menolak kata umum sederhana dan yang memuat bagian email. Keterbatasan: daftar kata umum kecil dan **tidak** memeriksa daftar kebocoran (tidak ada layanan eksternal agar tidak mengirim data).
- **Pesan error:** pesan bawaan framework/library tidak diteruskan; hanya pesan beralamat kode aplikasi (Indonesia) atau pesan standar.
- **Keterbatasan yang diketahui:** (1) pembatas laju di memori, bukan lintas instance; (2) tidak ada OTP email; (3) waktu respons `lupa kata sandi` tidak sepenuhnya seragam; (4) `TRUST_PROXY` harus benar atau IP klien keliru; (5) pemulihan MFA lewat admin dengan persetujuan ganda menyusul di 3D.

## Login member via Google OIDC (Fase 3C)
- **Alur:** Authorization Code + **PKCE S256**; `state` dan `nonce` acak per transaksi; transaksi sekali pakai, kedaluwarsa 10 menit, dikonsumsi atomik; callback wajib datang dari browser yang memulai (cookie pengikat `__Host-oidc`, disimpan sebagai hash) sehingga login-CSRF dan penyuntikan kode ditolak tanpa menghanguskan transaksi sah.
- **Validasi token:** `iss`, `aud`, `exp`, `nonce`, PKCE oleh `openid-client`; **ditambah** verifikasi tanda tangan RS256, `iss`, dan `aud` dengan JWKS penerbit (`jose`). Uji kami menemukan bahwa `openid-client` sendiri tidak memverifikasi tanda tangan id_token dari token endpoint (mengandalkan TLS, sah menurut OIDC Core); pemeriksaan tambahan menutup celah itu bila TLS/penerbit dikompromikan. `email_verified` harus tepat `true` (boolean).
- **Akun:** kunci identitas = `sub` Google (bukan email). Email yang sudah dimiliki akun Google lain **ditolak** dan masuk `member_account_conflicts` (identitas di-HMAC) untuk ditinjau HRD; tidak ada penautan otomatis (mencegah pengambilalihan akun lewat email yang didaur ulang).
- **Data minimum:** tidak meminta `offline_access`, tidak menyimpan access/refresh token Google; hanya `sub`, email, dan nama tampilan.
- **Redirect:** `returnTo` hanya jalur relatif satu-origin (tolak `//`, `\`, skema, karakter kontrol); semua galat berupa redirect ke `/masuk?galat=<kode>` tanpa detail internal; respons start/callback memakai `Cache-Control: no-store` dan `Referrer-Policy: no-referrer`.
- **Log:** serializer log membuang query string sehingga `code`/`state` tidak tercatat (diuji dengan menangkap keluaran log).
- **Pemisahan realm:** sesi member tidak dapat memakai endpoint staff dan sebaliknya (`REALM_TIDAK_SESUAI`); sesi member idle 24 jam, mutlak 30 hari.
- **Keterbatasan:** login Google sungguhan belum teruji (hanya IdP palsu lokal); Safari + `__Host-` pada `http://localhost` belum diuji; penentuan "satu orang satu akun" berdasarkan NIK menyusul di Fase 5.

## RBAC, scope, dan persetujuan ganda (Fase 3D)
Lihat bagian *Implementasi (Fase 3D)* di `rbac.md`. Ringkas: guard global deny-by-default (diuji dengan enumerasi rute), izin dihitung dari database per permintaan, pemisahan realm, persetujuan ganda dengan pemisahan tugas di aplikasi dan database, tidak ada perubahan akses diri sendiri, audit log dibatasi RLS, kursor keyset divalidasi ketat dan berpresisi mikrodetik, token undangan tidak pernah dikembalikan lewat API. **Keterbatasan:** belum ada pencegahan menghapus Direktur terakhir; kualifikator sel matriks belum ditegakkan; penegakan scope pada modul bisnis menyusul bersama modulnya.

## Master data dan dokumen (Fase 4)
Lihat ADR-0005. Ringkas: `company_id` anak diturunkan dari induk yang terlihat lewat RLS (menebak ID = 404); perusahaan di luar scope tidak dibocorkan; unggahan divalidasi magic bytes (PDF/PNG/JPEG, ≤ 10 MB, ekstensi harus cocok), disimpan di penyimpanan privat dengan kunci acak, diunduh hanya lewat API (izin + scope + audit, `attachment`, `nosniff`, `no-store`); audit perubahan hanya memuat nama bidang, bukan nilai. **Keterbatasan:** belum ada pemindai virus; driver S3 belum ada; kode kesalahan penyimpanan tidak memuat jalur; dokumen dihapus lunak (objek dipertahankan).

## Member, PII, dan lamaran (Fase 5)
Lihat ADR-0006. Ringkas: NIK terenkripsi AES-GCM + blind index unik, tersamar di API staff, reveal hanya `member.review` dan diaudit; isi dokumen identitas dienkripsi (AAD = kunci objek) dan hanya diunduh lewat API; duplikat NIK tidak membocorkan pemilik; tidak ada PII di audit/galat/log; member hanya menyentuh data miliknya (`person_id` dari sesi + RLS); lowongan lintas perusahaan dibaca member hanya lewat flag transaksi yang diaktifkan server; **CanApply di backend (403)**; aplikasi uji berjalan sebagai role non-superuser agar RLS terbukti. **Keterbatasan:** rotasi kunci enkripsi belum ada; belum ada pemindai virus; retensi dokumen identitas belum ditetapkan; audit peristiwa member tanpa perusahaan hanya terlihat Direktur/IT.

## PKWT, penempatan, dan status otomatis (Fase 6)
Lihat ADR-0007. Ringkas: tidak ada teks hukum bawaan; verifikasi template dan scan memakai pemisahan tugas yang ditegakkan aplikasi **dan** database; scan kontrak dienkripsi dan diunduh hanya lewat API (`pkwt_document.review`, diaudit); NIK pada PDF didekripsi sesaat dan tidak disimpan/dicatat; penempatan tumpang tindih ditolak database; status member turunan hanya ditulis satu layanan dengan kunci baris yang sama dengan `canApply`; dashboard tanpa NIK/kontak dan member hanya membaca miliknya (RLS); email pengingat berisi data kontrak minimum, payload outbox terenkripsi dan dikosongkan setelah terkirim. **Keterbatasan:** kualifikator sel matriks belum ditegakkan; PSrE belum ada; `pdf-lib` tidak dirilis sejak 2022; worker satu instance; rotasi kunci enkripsi dan pemindai virus masih terbuka.

## Absensi (Fase 7)
Lihat ADR-0008. Ringkas: online-only; waktu dari server; QR hanya pengenal titik; validasi di backend (penempatan + kontrak aktif, geofence, duplikat, perangkat, anomali); selfie hanya dari kamera, JPEG ≤ 300 KB, **terenkripsi**, tanpa face recognition, dilihat hanya `selfie.view` dengan **audit pada setiap akses** (gagal-aman), `no-store`; retensi dapat dikonfigurasi dengan purge harian dan legal hold; tinjauan dan koreksi memakai pemisahan tugas aplikasi **dan** database; rekaman asli tidak diubah; audit absensi tanpa koordinat/selfie; ekspor CSV menetralkan sel rumus dan diaudit; pembatas laju 20/menit pada endpoint absen. **Keterbatasan jujur:** QR dapat difoto, GPS dapat dipalsukan (mock location tidak terdeteksi andal), kamera langsung tidak dapat dibuktikan server — kontrol berlapis hanya menurunkan risiko dan menyerahkan kasus ambigu ke tinjauan manusia. `Permissions-Policy` membuka kamera/lokasi hanya pada `/absen`; CSP `img-src` menambah `blob:` untuk pratinjau selfie di perangkat sendiri.

## Web (Fase 3F)
- **Same-origin:** browser hanya berbicara ke web; `/api/*` diteruskan ke API (rewrite Next.js; tujuan lewat `API_URL`, bawaan `http://localhost:3001`). Tidak ada CORS lintas origin.
- **Header:** CSP (`default-src 'self'`, `frame-ancestors 'none'`, `form-action 'self'`; `'unsafe-inline'` masih diperlukan oleh Next.js), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy` membatasi kamera/mikrofon/lokasi (kamera dan lokasi dibuka hanya di `/absen`); `X-Powered-By` dimatikan.
- **Token di URL:** token undangan/reset dibaca sekali lalu **dibuang dari URL dan riwayat**; kode QR dan kunci TOTP hanya ditampilkan sekali; kode pemulihan wajib dikonfirmasi tersimpan sebelum lanjut.
- **Cookie sesi** tidak terbaca JavaScript (`HttpOnly`); token CSRF diambil dari `GET /auth/session` dan disimpan hanya di memori halaman.
- **Diuji E2E** (Chromium 360 px): alur undangan → kata sandi → TOTP → kode pemulihan → beranda → keluar → masuk ulang dengan MFA; asersi header, flag cookie, tanpa gulir horizontal, input berlabel, target sentuh ≥ 44 px, kontras WCAG AA, tanpa galat konsol/CSP. E2E belum berjalan di CI (butuh browser).

## Role database aplikasi
Aplikasi wajib memakai role PostgreSQL non-superuser, non-owner tabel, tanpa `BYPASSRLS`; superuser mem-bypass RLS walau `FORCE` aktif (ADR-0003). Role migrasi dipisah dari role aplikasi.

## Bootstrap admin
Lihat runbook operator di `bootstrap-admin.md`. Ringkas: CLI dijalankan operator di server (bukan endpoint), menolak non-TTY, email diberikan saat eksekusi (tanpa default), tautan sekali pakai (256-bit, hash, 24 jam) dicetak sekali ke terminal dan tidak masuk email/log/audit; peran IT Administrator bootstrap berumur 7 hari sejak aktivasi; bootstrap ditutup otomatis saat Direktur pertama aktif; `--regenerate` hanya selama belum ada Direktur aktif; dua eksekusi bersamaan dicegah (kunci advisory + baris status terkunci); semuanya diaudit (`auth.bootstrap.*`). Break-glass: manual, nonaktif secara default, tanpa alarm otomatis (pekerjaan lanjutan).

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
