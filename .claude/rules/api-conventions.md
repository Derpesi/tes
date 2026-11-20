# Konvensi API
- REST + dokumentasi OpenAPI yang dihasilkan dari kode; perubahan kontrak dideteksi di CI.
- Validasi semua input di backend; pesan error berbahasa Indonesia dengan kode error stabil.
- Daftar besar memakai keyset pagination; semua daftar punya batas ukuran halaman.
- Otorisasi per endpoint lewat permission granular; default menolak (deny by default).
- Operasi tulis sensitif idempoten dan masuk audit log (siapa, apa, kapan, nilai lama/baru tanpa rahasia).
- Pekerjaan berat (ekspor, PDF, notifikasi) lewat antrean latar, bukan di request.
