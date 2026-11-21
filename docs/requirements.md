# Software Requirements Specification (SRS) — DAMARINDO GROUP HRIS

Status: rancangan Fase 2A. Keputusan dan asumsi: lihat `decision-log.md`.

## 1. Ruang lingkup
HRIS web responsif (mobile-first, Android/tablet/desktop) untuk Damarindo Group (PT. Damarindo Mandiri, PT. OSI, PT. Pancormas Perkasa; perusahaan baru lewat master data). Mencakup: registrasi member, rekrutmen, PKWT, penempatan, absensi QR + GPS + selfie, rekap payroll, dashboard, laporan, audit.

Pengguna hanya dua kategori: **Member/Tenaga Kerja** dan **Staff Internal**. **Perusahaan rekanan bukan pengguna**: tidak ada login, akun, dashboard, atau portal rekanan.

## 2. Kebutuhan fungsional
| Kode | Kebutuhan |
|---|---|
| FR-AUT | Member: Google OIDC (email terverifikasi, satu akun Google = satu member, penanganan duplikat), tanpa password lokal. Staff: email terdaftar + password HRIS + MFA wajib (TOTP diutamakan); hanya via undangan; reset password, batas percobaan, timeout sesi, nonaktifkan akun, log login |
| FR-BOOT | Bootstrap admin awal: CLI operator, token sekali pakai, tanpa kredensial default, tanpa Super Admin permanen |
| FR-ORG | Multi-perusahaan lewat master data; scope akses per pengguna (perusahaan + lokasi); konsolidasi untuk Direktur bila diberi wewenang |
| FR-MEM | Biodata (nama, NIK, TTL, gender, alamat, HP, email, pendidikan, pengalaman, keahlian, posisi diminati, foto, dokumen), persentase kelengkapan, verifikasi HRD |
| FR-LOW | Lowongan lintas perusahaan; wajib punya perusahaan pengelola; filter wilayah, posisi, perusahaan, kualifikasi |
| FR-LAM | Lamaran, seleksi administrasi, interview, keputusan; karyawan aktif diblokir di backend |
| FR-PKWT | Template berversi, nomor otomatis, alur persetujuan, versi/perpanjangan, arsip, notifikasi kontrak akan berakhir |
| FR-PKWT-DOK | Generate PDF, unggah scan bertanda tangan, checksum SHA-256, verifikasi HRD; template `BELUM_DIVERIFIKASI` tidak boleh dipakai untuk kontrak aktif; antarmuka `SignatureProvider` untuk PSrE kelak |
| FR-PEN | Penempatan, jadwal/shift, riwayat |
| FR-RKN | Master rekanan: kontrak layanan, banyak lokasi, PIC, kebutuhan tenaga, perusahaan pengelola |
| FR-ABS | Titik absensi dan QR (PDF cetak), scan, GPS/geofence, selfie kamera, validasi backend, antrean tinjauan, koreksi dengan persetujuan |
| FR-ABS-SHIFT | Shift pagi/siang/malam, lintas tengah malam (tanggal-shift = tanggal mulai), jadwal fleksibel, hari libur, toleransi per shift/lokasi |
| FR-ABS-ONLINE | Online-only; tanpa jaringan tampil pesan gagal dan prosedur koreksi oleh petugas |
| FR-SELFIE-RET | Retensi selfie dapat dikonfigurasi; purge harian; legal hold; audit penghapusan |
| FR-PAY1 | Periode, rekap absensi, komponen payroll, verifikasi, persetujuan rekap, ekspor |
| FR-EXP | Ekspor xlsx/CSV/PDF via pekerjaan latar, bucket privat, proteksi formula injection, diaudit |
| FR-NTF | Notifikasi email; abstraksi kanal; WhatsApp/push stub nonaktif |
| FR-DSH | Dashboard member (berubah mengikuti status) dan dashboard internal per role |
| FR-AUD | Audit log append-only, riwayat status, laporan |

## 3. Kebutuhan nonfungsional
- **Keamanan:** RBAC dan scope di backend, RLS, enkripsi in-transit dan at-rest, enkripsi level aplikasi untuk NIK/rekening/selfie, rate limiting, upload aman, CSRF/CORS, manajemen secret.
- **Privasi:** mengikuti UU Pelindungan Data Pribadi; selfie dan KTP data sensitif; persetujuan, retensi, akses terlog.
- **Kapasitas (asumsi A-01):** desain untuk 10.000 pekerja, 300 rekanan, 500 lokasi: indeks, keyset pagination, partisi, pekerjaan latar, uji beban.
- **Kinerja (asumsi A-04):** halaman mobile ≤3 dtk di 4G; scan absensi p95 ≤1–2 dtk pada 100 req/dtk.
- **Ketersediaan/DR (asumsi A-02):** RPO 24 jam, RTO 8 jam, divalidasi lewat latihan restore (bukan SLA).
- **Lingkungan:** staging dan production terpisah total (database, bucket, secret, kredensial OAuth).
- **UX:** UI Bahasa Indonesia, mobile-first, navy-putih-gold, aksesibilitas dasar.
- **Kualitas:** migrasi, tes otomatis, log terstruktur, OpenAPI, modularitas.

## 4. Backlog dan acceptance criteria MVP-1
| ID | Fitur | Kriteria penerimaan utama |
|---|---|---|
| AUT-1 | Login member Google | Hanya email Google terverifikasi; login kedua akun Google sama masuk ke akun sama; tidak ada endpoint password member; email milik akun Google lain ditolak dan masuk antrean tinjauan; state/nonce/PKCE dan cookie pengikat ditegakkan (3C, teruji dengan IdP palsu; Google sungguhan menunggu OAuth client pemilik) |
| AUT-2 | Login staff + MFA | Hanya via undangan; tanpa MFA ditolak; 5 gagal berturut-turut mengunci sementara; tidak ada registrasi staff |
| AUT-3 | Bootstrap admin | Hanya saat belum ada staff; tautan sekali pakai kedaluwarsa 24 jam dan hanya dicetak ke terminal interaktif; tanpa kredensial default; peran awal berumur 7 hari; teraudit; jalur mati otomatis saat Direktur pertama aktif (3E, teruji termasuk CLI) |
| RBA-1 | Permission granular | Endpoint menolak (403) tanpa permission; pembuat dan pemeriksa tidak boleh orang sama; tes matriks otomatis |
| ORG-1 | Isolasi perusahaan | Pengguna scope A tidak dapat membaca data B lewat API, ID langsung, ekspor |
| ORG-2 | Perusahaan baru | Tambah perusahaan lewat master data tanpa deploy ulang |
| REK-1 | Rekanan hanya data | Tidak ada tabel, rute, atau role login rekanan (diuji otomatis) |
| MEM-1 | Biodata | NIK 16 digit tervalidasi, pesan error Indonesia, kelengkapan % akurat, dokumen tersimpan privat |
| LAM-1 | Lamaran | Member terverifikasi belum ditempatkan dapat melamar semua perusahaan; karyawan aktif ditolak API (403) walau UI dimanipulasi |
| PKW-1 | Alur PKWT | Transisi di luar diagram ditolak; tiap perubahan membuat versi baru; template belum terverifikasi tidak bisa dipakai aktif |
| PKW-2 | Dokumen PKWT | Scan terunggah dengan checksum, versi, petugas, waktu; HRD dapat memverifikasi atau menolak dengan alasan |
| PEN-1 | Penempatan | Dua penempatan aktif tumpang tindih ditolak database |
| ABS-1 | Titik dan QR | PDF QR dapat diunduh; titik nonaktif ditolak |
| ABS-2 | Scan absensi | Luar radius ditolak; duplikat ditolak; tanpa selfie kamera ditolak; waktu dari server; shift lintas tengah malam benar |
| ABS-3 | Koreksi | Rekaman asli tak berubah; koreksi butuh persetujuan; teraudit |
| ABS-4 | Retensi selfie | Selfie melewati masa retensi terhapus oleh pekerjaan harian; legal hold dikecualikan; penghapusan teraudit |
| PAY-1 | Rekap absensi | Rekap per periode sesuai data absensi; setelah disetujui tak bisa diubah tanpa koreksi resmi |
| EXP-1 | Ekspor | xlsx, CSV, PDF terbentuk; sel berawalan `=+-@` dinetralkan; ekspor teraudit |
| AUD-1 | Audit | Aksi sensitif tercatat; tabel tidak bisa UPDATE/DELETE |
