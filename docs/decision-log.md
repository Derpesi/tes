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
| D-14 | Redirect URI Google = `<APP_BASE_URL>/api/auth/member/google/callback` (prefiks `/api` untuk same-origin lewat reverse proxy/rewrite; dapat diubah lewat `API_PUBLIC_PATH`) |
| D-15 | Email Google yang sudah dimiliki member lain dengan akun Google berbeda **ditolak dan masuk antrean tinjauan HRD**; tidak ada penautan otomatis berdasarkan email |
| D-16 | Email yang sama sebagai staff dan member adalah dua akun terpisah tanpa penautan |
| D-17 | Peran berhak tinggi (Direktur, IT Administrator), akses seluruh perusahaan, dan reset MFA memerlukan **persetujuan ganda** (pemohon ≠ penyetuju). Pengecualian terbatas: admin bootstrap menunjuk Direktur pertama langsung (teraudit) |
| D-18 | Sembilan peran dan permission bersifat **tetap** (seed dari `docs/rbac.md`); belum ada UI untuk mengedit peran/permission |
| D-19 | Reset MFA = akun kembali ke undangan (kata sandi, MFA, kode pemulihan dihapus; sesi dicabut) |
| D-20 | Tidak ada yang dapat mengubah peran/scope/status akunnya sendiri. Matriks dikoreksi: modul *Pengguna & role* diberi `V` untuk Direktur dan IT |
| D-21 | Bootstrap memakai undangan staff biasa (token 256-bit ber-hash, TTL 24 jam) yang tautannya **dicetak sekali ke terminal interaktif** (CLI menolak non-TTY); tabel `bootstrap_tokens` dihapus. Peran IT Administrator awal berumur 7 hari sejak aktivasi; bootstrap ditutup otomatis saat Direktur pertama aktif |
| D-22 | Perusahaan baru dibuat IT dalam keadaan nonaktif dan berlaku setelah persetujuan aktivasi Direktur (ADR-0005) |
| D-23 | Rekanan dimiliki satu perusahaan grup; `companies` tanpa RLS dengan visibilitas di layanan; anak mewarisi `company_id` dari induk |
| D-24 | Dokumen: `ObjectStorage` + driver lokal sekarang, driver S3 menyusul setelah hosting dipilih; unggahan divalidasi magic bytes; unduhan lewat API terkontrol + audit |
| D-25 | Kontrak layanan diaktifkan Direktur (satu penyetuju, bukan pembuat); isi terkunci setelah aktif |
| D-26 | Adendum/versi kontrak pasca-aktif ditunda ke Fase 6 |
| D-27 | Member = tabel global tanpa `company_id`; akses staff lewat permission `member.*`, self-service lewat `person_id` dari sesi (ADR-0006) |
| D-28 | NIK dienkripsi + blind index berprefiks domain; tersamar di API staff, reveal hanya `member.review` dan diaudit |
| D-29 | Isi dokumen identitas dienkripsi sebelum disimpan; unduhan hanya lewat API dengan audit |
| D-30 | Lowongan ber-`company_id` + RLS; member membaca lowongan DIBUKA lintas perusahaan lewat kebijakan RLS khusus (flag transaksi `memberRead`) |
| D-31 | CanApply di backend (403) sebagai satu-satunya sumber aturan; karyawan aktif/kontrak akan berakhir ditolak, dievaluasi dalam transaksi yang sama dengan status profil |
| D-32 | Verifikasi HRD: kembalikan (alasan wajib, terlihat member) atau setujui (TERVERIFIKASI lalu BELUM_DITEMPATKAN); ubah saat menunggu verifikasi mengembalikan status |
| D-33 | Akhir Fase 5 = lamaran `MENUNGGU_PKWT`; PKWT, penempatan, dan perubahan status karyawan di Fase 6 |
| D-34 | Template PKWT disediakan pengguna tanpa teks hukum bawaan; verifikasi hukum dicatat Direktur (di luar sistem); template terverifikasi terkunci dan berversi (ADR-0007) |
| D-35 | Kontrak: pembuat, pemeriksa, penyetuju berbeda; template terverifikasi sebelum persetujuan; scan terverifikasi sebelum sah; "setuju" bukan tanda tangan sah |
| D-36 | Perpanjangan = kontrak lanjutan bertaut yang melewati alur penuh, tidak menimpa kontrak berjalan |
| D-37 | Penempatan tumpang tindih ditolak database (exclusion constraint btree_gist); persetujuan Mgr Ops, penyetuju ≠ pembuat |
| D-38 | Status member turunan hanya ditulis `MemberStatusService`; kembali BELUM_DITEMPATKAN hanya lewat verifikasi HRD; perubahan otomatis bertanda "Otomatis:" tanpa aktor |
| D-39 | Siklus hidup kontrak idempoten dengan jam disuntikkan; worker interval + pemicu kejadian; notifikasi kontrak akan berakhir sekali per kontrak |
| D-40 | Dependency pdf-lib untuk PDF PKWT; pako (MIT AND Zlib) dicatat sebagai pengecualian lisensi yang diajukan ke pemilik |
| D-41 | Absensi online-only: QR statis = pengenal titik (bukan rahasia), kode dapat diganti, satu titik aktif per lokasi; PDF QR dibangkitkan sesuai permintaan dan diaudit (ADR-0008) |
| D-42 | Tanggal-shift = tanggal mulai shift; penentuan shift fungsi murni berjam-disuntikkan; waktu rekaman selalu waktu server |
| D-43 | Setiap percobaan absen yang dinilai disimpan (termasuk DITOLAK); unik per (orang, titik, jenis, tanggal-shift) untuk non-DITOLAK; idempotensi per kunci; hasil VALID / PERLU_VERIFIKASI / DITOLAK |
| D-44 | Perangkat pertama disetujui otomatis, tambahan perlu verifikasi; id perangkat disimpan sebagai HMAC |
| D-45 | Selfie hanya dari kamera, JPEG ≤ 300 KB, terenkripsi; tanpa face recognition; akses hanya `selfie.view` dan diaudit sebelum byte dikirim |
| D-46 | Retensi selfie per perusahaan (`selfieRetentionDays`, bawaan 90) dengan purge harian dan legal hold; baris rekaman tetap |
| D-47 | Tinjauan absensi dua langkah (periksa PayAbs/PayInt, putus Mgr Ops, orang berbeda di aplikasi dan database); rekaman asli tidak diubah; tampilan efektif memakai putusan |
| D-48 | Koreksi absensi bernomor `KOR/<tahun>/<urut>`; penyetuju ≠ pembuat; hanya koreksi disetujui dipakai rekap |
| D-49 | Rekap absensi per orang-hari dan ekspor CSV (≤ 10.000 baris) dengan perlindungan formula injection dan audit; xlsx/PDF di Fase 8 |
| D-50 | `RequirePermission` mendukung izin alternatif ("salah satu") hanya untuk daftar baca; Permissions-Policy membuka kamera/lokasi hanya di `/absen` |

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
| A-12 | ~~Isolasi perusahaan via `set_config('app.company_ids')` + `enable_tenant_rls`~~ **Diadopsi sebagai ADR-0003 (Fase 3)**; kinerja pada tabel besar masih perlu diukur | Uji beban (Fase 10) |
| A-13 | ~~`audit_logs` dikecualikan sementara dari RLS~~ **DITUTUP di Fase 3A**: `audit_logs` memakai kebijakan RLS khusus (baca per scope atau global bila `app.audit_global`; tulis selalu boleh); pengecualian registri kosong | Tes `audit-rls` dan registri |
| A-14 | Batas sesi staff: idle 30 menit, mutlak 8 jam; **member: idle 24 jam, mutlak 30 hari**; sesi tertunda (menunggu MFA/pendaftaran) 10 menit | Divalidasi pemilik |
| A-15 | Kunci akun: 5 gagal berturut-turut (kata sandi atau MFA) mengunci 15 menit, juga untuk email tak terdaftar; undangan berlaku 7 hari, tautan reset 30 menit (maks 3 permintaan/jam/akun) | Divalidasi pemilik |
| A-16 | argon2id (`@node-rs/argon2`) m=19 MiB, t=2, p=1 (minimum OWASP) | Disetel ulang setelah uji beban |
| A-17 | TOTP via `otplib` 13 (toleransi ±30 detik, proteksi pakai-ulang); **tanpa OTP email**; 10 kode pemulihan sekali pakai | Pemilik |
| A-18 | Pembatas laju per IP di memori (instance tunggal): 10 permintaan/menit untuk endpoint auth, 120/menit umum. Di balik proxy wajib set `TRUST_PROXY` | Redis dievaluasi bila perlu (A-06) |
| A-19 | Node minimal 22.12 (otplib memakai dependency ESM yang dimuat lewat `require`) | CI memakai `.nvmrc` |
| A-20 | Login Google: `prompt=select_account` (perangkat bersama), scope `openid email profile`, tanpa refresh token; tanda tangan id_token diverifikasi ulang dengan JWKS (di atas TLS) | Uji dengan klien Google sungguhan oleh pemilik |
| A-21 | Permintaan persetujuan kedaluwarsa dalam 72 jam | Divalidasi pemilik |
| A-22 | Baris audit global dapat dibaca Direktur dan IT Administrator saja | Divalidasi pemilik |
| A-23 | CSP web memakai `'unsafe-inline'` untuk skrip/gaya (Next.js tanpa nonce); `'unsafe-eval'` hanya di pengembangan | Pengetatan dengan nonce (pekerjaan lanjutan) |
| A-24 | Bentuk pengaturan payroll/dokumen perusahaan: `payrollSettings {periodType, cutOffDay 1–28}`, `documentSettings {contractNumberPrefix}`; hanya titik awal, menunggu kebijakan pemilik | Pemilik |
| A-25 | Kode singkat perusahaan awal (DMR/OSI/PCP) adalah usulan; dapat diubah IT | Pemilik |
| A-26 | Radius geofence bawaan 100 m (batas 20–1000 m); koordinat `numeric(9,6)` | Divalidasi saat Fase 7 |
| A-27 | Biodata minimal: nama lengkap, NIK, tempat/tanggal lahir, jenis kelamin, alamat, kota, provinsi, telepon, pendidikan terakhir, kontak darurat; KTP wajib untuk pengajuan | Pemilik |
| A-28 | Pendidikan terakhir: SD, SMP, SMA/SMK, D1-D3, D4/S1, S2, S3 | Pemilik |
| A-29 | Retensi dokumen identitas member belum ditetapkan (hapus lunak, objek dipertahankan) | Tinjau terhadap UU PDP |
| A-30 | Lowongan yang ditutup/kedaluwarsa tidak terlihat member kecuali oleh pelamarnya; lamaran yang ditolak tetap menghalangi lamaran ulang ke lowongan yang sama | Pemilik |
| A-31 | Jendela "kontrak akan berakhir" = 30 hari; nomor kontrak `<prefiks>/<kode>/<tahun>/<urut 4 digit>` | Pemilik |
| A-32 | Variabel template: nama, nik, nomor, jabatan, tanggal_mulai, tanggal_akhir, perusahaan, tanggal_cetak | Pemilik/ahli hukum |
| A-33 | Kontrak aktif tanpa penempatan aktif belum menjadikan karyawan; kontrak aktif ditangguhkan penempatannya tetap berstatus karyawan | Pemilik |
| A-34 | Ambang anomali: lompatan > 150 km/jam, koordinat identik ≥ 5×, akurasi > 100 m, selisih jam klien > 5 menit, > 3 akun per perangkat; skor per penanda | Kalibrasi dengan data nyata/uji beban (Fase 10) |
| A-35 | Toleransi bawaan shift: terlambat 15 menit, awal 30 menit (batas 0–240); override per lokasi | Pemilik |
| A-36 | Selfie JPEG 640 px, ≤ 300 KB (klien menargetkan ≤ 280 KB); lebih besar ditolak sebagai DITOLAK, > 400 KB ditolak 413 | Ukur kapasitas di staging (A-08) |
| A-37 | Rentang rekap/ekspor ≤ 93 hari; ekspor ≤ 10.000 baris sinkron (belum antrean latar) | Pindah ke antrean bila beban menuntut |
| A-38 | Legal hold diterapkan Mgr Ops (`attendance_anomaly.approve`); matriks belum memiliki izin khusus | Pemilik |
| A-39 | Daftar baca (titik, tinjauan, koreksi) terbuka bagi pemegang izin aksi terkait selain izin lihat | Pemilik meninjau matriks |
| A-40 | Partisi bulanan `attendance_records` ditunda; indeks (orang, tanggal), (titik, waktu), (perusahaan, tanggal) disiapkan | Uji beban k6 (Fase 10) |

## Masih Terbuka
Pembuatan OAuth client Google oleh pemilik (lihat `google-oauth-setup.md`); penyedia hosting dan operator server; identitas admin awal dan Direktur; template PKWT resmi; warna dan logo final; penyedia email; format kolom ekspor payroll; nama badan hukum pemegang hak cipta; visibilitas repo dan lisensi proprietary.
