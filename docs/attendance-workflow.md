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
