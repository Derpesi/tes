# Daftar Blokir Go-Live (milik pemilik)

Status sistem: **kode siap staging**. Item berikut belum dapat diselesaikan oleh pengembang dan **memblokir produksi**:

| # | Item | Pemilik | Catatan |
|---|---|---|---|
| 1 | Hosting, domain, TLS, penyedia PostgreSQL | Pemilik | Belum dipilih (ADR). Image belum pernah dibangun di sini. |
| 2 | OAuth Google (client id/secret, redirect URI) | Pemilik | `docs/google-oauth-setup.md`; tanpa ini member tidak dapat login. |
| 3 | SMTP produksi (invitasi/reset staf) | Pemilik | Tanpa SMTP outbox tidak mengirim. |
| 4 | Template PKWT resmi + (opsional) PSrE tanda tangan | Pemilik/Hukum | Tidak ada klausul hukum karangan; tombol setuju bukan tanda tangan sah. |
| 5 | Kebijakan retensi final (selfie, dokumen, audit) vs UU PDP | Pemilik/Hukum | Bawaan selfie 90 hari adalah usulan. |
| 6 | `LICENSE` + nama pemegang hak cipta | Pemilik | Repo proprietary; tidak diubah tanpa persetujuan. |
| 7 | Branch protection `main` + wajib CI hijau | Pemilik | Pengaturan GitHub. |
| 8 | **Rotasi kunci enkripsi** (`secrets.md`) | Pengembang (butuh persetujuan fase) | Direkomendasikan sebelum produksi. |
| 9 | Driver S3/penyimpanan objek terkelola + replikasi | Pengembang | Volume lokal = titik kegagalan tunggal tanpa cadangan. |
| 10 | Skala horizontal (kunci worker, pembatas bersama) | Pengembang | Perlu bila satu instans tidak cukup (lihat `performance.md`). |
| 11 | **Uji penetrasi independen** | Pemilik | Uji otomatis dan tinjauan sendiri BUKAN penggantinya (`docs/security-review.md`). |
| 12 | Latihan restore di infrastruktur produksi/staging nyata | Operator | Latihan di sini memakai data sintetis pada 1 VM. |
| 13 | Pemantauan/peringatan terpasang (`monitoring.md`) | Operator | Platform belum dipilih. |
| 14 | Validasi hukum perhitungan payroll lanjutan | Pemilik/Ahli | Di luar tahap awal (rekap & ekspor). |
