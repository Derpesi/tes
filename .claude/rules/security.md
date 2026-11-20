# Aturan Keamanan
- Dilarang menyimpan rahasia (token, kunci API, password, sertifikat) di repo, log, atau pesan commit.
- Gunakan variabel lingkungan atau secret manager; sediakan `.env.example` tanpa nilai asli.
- Periksa dependency baru (reputasi, lisensi, kerentanan) sebelum ditambahkan.
- Validasi semua input eksternal; jangan percaya data klien.
- Jika rahasia terlanjur ter-commit: anggap bocor, rotasi segera, lalu bersihkan riwayat.
