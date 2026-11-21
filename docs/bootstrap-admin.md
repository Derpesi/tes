# Runbook: Bootstrap Administrator Awal

Dipakai **sekali** saat sistem baru, oleh **operator dengan akses server dan database**. Tidak ada email, kata sandi, atau OTP bawaan, dan tidak ada Super Admin permanen.

## Prasyarat
- Migrasi sudah dijalankan; `.env` server terisi (`DATABASE_URL`, `APP_BASE_URL`, `AUTH_HMAC_KEY`, `APP_ENCRYPTION_KEY`).
- Anda berada di **terminal interaktif** (SSH dengan TTY). CLI menolak berjalan bila keluarannya dialihkan ke berkas, pipa, atau log CI.
- Email calon administrator awal ada di tangan Anda saat itu (tidak disimpan di repo).

## Langkah
1. `pnpm bootstrap -- --email <email-admin> --nama "<Nama Admin>"`
2. CLI mencetak **satu tautan** (berlaku 24 jam, sekali pakai). Tautan hanya tampil di layar; tidak dikirim lewat email, tidak ditulis ke database dalam bentuk mentah, dan tidak masuk log atau audit.
3. Kirim tautan **langsung** kepada pemilik email lewat kanal yang tidak tersimpan permanen. Jangan menempelkannya ke chat grup, tiket, atau dokumen.
4. Pemilik membuka tautan, membuat kata sandi (minimal 12 karakter), lalu mendaftarkan TOTP dan menyimpan 10 kode pemulihan.
5. Administrator awal memperoleh peran **IT Administrator** berumur **7 hari sejak aktivasi**.
6. Administrator awal mengundang **Direktur Group pertama** (menu undangan staff, peran `DIREKTUR`). Untuk Direktur pertama ini tidak perlu persetujuan ganda (pengecualian satu kali, teraudit).
7. Saat Direktur pertama menyelesaikan aktivasi, **bootstrap ditutup otomatis**: `system_state.bootstrapped = true`, peran bootstrap dicabut, dan CLI menolak dijalankan lagi.
8. Setelah itu seluruh perubahan peran tinggi memakai persetujuan ganda (lihat `rbac.md`).

## Bila ada masalah
| Situasi | Tindakan |
|---|---|
| Tautan kedaluwarsa atau hilang | `pnpm bootstrap -- --email <email> --regenerate` (tautan lama otomatis mati) |
| Salah mengetik email | `--regenerate` dengan email yang benar; akun lama yang belum aktif dinonaktifkan |
| Peran 7 hari habis sebelum Direktur aktif | `--regenerate` dengan email admin yang sama: peran diberikan ulang tanpa tautan baru |
| "Bootstrap sudah selesai" | Normal setelah Direktur aktif. Gunakan alur undangan/persetujuan biasa |

`--regenerate` hanya bekerja selama **belum ada Direktur aktif**. Semua eksekusi (berhasil, diulang, atau ditolak) tercatat di audit log (`auth.bootstrap.*`) tanpa email atau token mentah.

## Break-glass (darurat)
**Nonaktif secara default dan tidak ada kode untuk itu.** Bila seluruh Direktur dan administrator kehilangan akses dan bootstrap sudah tertutup, pemulihan dilakukan dengan prosedur manual yang dikendalikan pemilik proyek: operator mengubah `system_state.bootstrapped` kembali ke `false` langsung di database **dengan persetujuan tertulis pemilik**, lalu menjalankan runbook ini. Catat alasan, waktu, dan pelaku di dokumen insiden. Tindakan ini harus diaudit manual karena melewati kontrol aplikasi. (Alarm otomatis untuk penggunaan break-glass belum dibuat; dicatat sebagai pekerjaan lanjutan.)

## Keterbatasan
- Keamanan tautan bergantung pada kanal yang dipakai operator untuk menyampaikannya.
- Tidak ada pembatasan alamat IP atau perangkat untuk administrator awal; kontrolnya adalah MFA wajib, umur peran 7 hari, dan penutupan otomatis.
