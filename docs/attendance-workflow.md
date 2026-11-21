# Alur Absensi

## Alur: login → scan QR → GPS → selfie → validasi backend → simpan
1. Karyawan login Google dan membuka menu absensi.
2. Memindai QR cetak. QR hanya berisi pengenal titik publik (UUID acak), **bukan rahasia** karena dapat difoto atau disalin.
3. Browser meminta izin lokasi; koordinat dan akurasi dikirim.
4. Selfie **langsung dari kamera**; unggahan dari galeri tidak diterima.
5. Klien mengirim id titik, koordinat, akurasi, selfie, id perangkat, dan kunci idempotensi.
6. Backend memvalidasi (waktu server): sesi dan akun aktif; titik aktif; penempatan aktif di lokasi itu dan PKWT aktif; jadwal/shift dan toleransi; geofence (Haversine ≤ radius) dan akurasi GPS; duplikat; perangkat terdaftar atau perlu persetujuan; keberadaan selfie; skor anomali.
7. Hasil: `VALID`, `PERLU_VERIFIKASI` (antrean tinjauan), atau `DITOLAK` dengan alasan. Semuanya diaudit.

## Mode online-only
Tanpa jaringan, aplikasi menampilkan pesan gagal beserta prosedur koreksi absensi oleh petugas berwenang. **Tidak ada absensi offline atau antrean offline.**

## Shift dan jadwal
- Shift pagi, siang, malam; shift lintas tengah malam (tanggal-shift = tanggal mulai shift).
- Jadwal fleksibel (target jam dalam jendela waktu).
- Hari libur nasional, perusahaan, dan lokasi.
- Toleransi keterlambatan per shift dengan override per lokasi.
- Check-in dan check-out terpisah; unik per (karyawan, titik, jenis, tanggal-shift).

## Selfie
- Bukti pendukung untuk tinjauan manusia, **tanpa face recognition otomatis** di MVP.
- Bucket privat, URL bertanda tangan singkat, hanya petugas berwenang (lihat `rbac.md`).
- Retensi dapat dikonfigurasi (asumsi 90 hari); purge harian; legal hold; penghapusan diaudit.

## Keamanan dan keterbatasan
- QR statis dan GPS di browser **tidak membuktikan kehadiran secara mutlak**. Mock location tidak terdeteksi andal di PWA.
- Kontrol berlapis: geofence, selfie kamera, device binding, deteksi anomali (lompatan lokasi, koordinat identik berulang, akurasi mencurigakan, waktu klien menyimpang, banyak akun satu perangkat), rate limiting, tinjauan manual.
- Kegagalan GPS/sinyal tidak langsung menolak pekerja: masuk `PERLU_VERIFIKASI`.
- QR dapat dinonaktifkan atau diganti kapan saja; PDF QR memuat nama lokasi dan kode verifikasi visual.

## Koreksi
`attendance_adjustments` terpisah, alasan wajib, diajukan Staff Payroll Absensi, disetujui Manager Operasional. Rekaman asli tidak diubah; semuanya diaudit.

> **Status implementasi (Fase 7):** seluruh alur di atas diimplementasikan (ADR-0008). Rute member: `POST /member/attendance` (multipart), `GET /member/attendance`, `GET /member/attendance/today`; halaman `/absen?t=<kode>` dan `/saya/absensi`. Rute staf: `/attendance/points` (+QR PDF), `/shifts`, `/schedules`, `/holidays`, `/review`, `/records/:id/selfie`, `/adjustments`, `/recap` dan `/recap/export.csv`. Perbedaan dari rancangan awal yang perlu diketahui: selfie dialirkan lewat API berizin dan diaudit (belum URL bertanda tangan, menunggu driver S3); selfie > 300 KB dicatat sebagai `DITOLAK` (bukan galat); rekap belum menurunkan hari tanpa absen dari jadwal (Fase 8).

## Operasi
- Purge selfie berjalan harian di proses API (`SelfieService.purge`); retensi per perusahaan di `documentSettings.selfieRetentionDays` (7–3650, bawaan 90). Gagal hapus objek dicatat di log tanpa kunci objek; periksa dan ulangi.
- Mengganti kode QR: `POST /attendance/points/:id/rotate-code`, lalu cetak ulang poster (kode lama langsung tidak berlaku).
- Absen yang gagal karena tidak ada koneksi tidak dapat disusulkan oleh pekerja; petugas absensi mengajukan koreksi bernomor (disetujui Mgr Ops).
