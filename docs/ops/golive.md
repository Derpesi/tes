# Daftar Blokir Go-Live (milik pemilik)

Status sistem: **kode siap staging**. Item berikut belum dapat diselesaikan oleh pengembang dan **memblokir produksi**:

| # | Item | Pemilik | Catatan |
|---|---|---|---|
| 1 | Hosting, domain, TLS, penyedia PostgreSQL | Pemilik | Belum dipilih (ADR). Image belum pernah dibangun di sini. |
| 2 | OAuth Google (client id/secret, redirect URI) | Pemilik | `docs/google-oauth-setup.md`; tanpa ini member tidak dapat login. |
| 3 | SMTP produksi (invitasi/reset staf) | Pemilik | Tanpa SMTP outbox tidak mengirim. |
| 4 | Template PKWT: **draf pemilik 2022 sudah menjadi templat awal (ADR-0015)** tetapi **wajib ditinjau ahli hukum lalu diverifikasi** (catatan peninjau di `docs/templates/pkwt-alih-daya/README.md`); isi pengaturan PKWT dan legalitas PT. OSI dan PT. Pancormas Perkasa; (opsional) PSrE | Pemilik/Hukum | Tidak ada klausul karangan; tombol setuju bukan tanda tangan sah. |
| 5 | Kebijakan retensi final (dokumen, audit; selfie bila diaktifkan lagi) vs UU PDP | Pemilik/Hukum | Selfie ditiadakan sementara (ADR-0012); usulan 90 hari berlaku bila diaktifkan. |
| 6 | `LICENSE` + nama pemegang hak cipta | Pemilik | Repo proprietary; tidak diubah tanpa persetujuan. |
| 7 | Branch protection `main` + wajib CI hijau | Pemilik | Pengaturan GitHub. |
| 8 | ~~Rotasi kunci enkripsi~~ **Selesai (Fase 11B, `rotasi-kunci.md`)**; tersisa rotasi `AUTH_HMAC_KEY` (A-60) | Pengembang | Latih prosedur di staging. |
| 9 | Driver S3/penyimpanan objek terkelola + replikasi | Pengembang | Volume lokal = titik kegagalan tunggal tanpa cadangan. Kebutuhan ukuran jauh turun selama selfie off. |
| 10 | Skala horizontal (kunci worker, pembatas bersama) | Pengembang | Perlu bila satu instans tidak cukup (lihat `performance.md`). |
| 11 | **Uji penetrasi independen** | Pemilik | Uji otomatis dan tinjauan sendiri BUKAN penggantinya (`docs/security-review.md`). |
| 12 | Latihan restore di infrastruktur produksi/staging nyata | Operator | Latihan di sini memakai data sintetis pada 1 VM. |
| 13 | Pemantauan/peringatan terpasang (`monitoring.md`) | Operator | Platform belum dipilih. |
| 14 | Validasi hukum perhitungan payroll lanjutan | Pemilik/Ahli | Di luar tahap awal (rekap & ekspor). |
