# Runbook: Rahasia dan Kunci

Tidak ada rahasia di repo, log, atau pesan commit. Gitleaks berjalan di CI. Semua nilai di bawah diisi **operator di server / secret manager**.

| Rahasia | Fungsi | Pembangkitan | Rotasi |
|---|---|---|---|
| `AUTH_HMAC_KEY` | HMAC token CSRF, indeks buta NIK/email/sub | `openssl rand -base64 32` | **Merotasi mengubah semua indeks buta** (NIK, email/sub Google) → butuh *re-index* data; belum ada alat. Jangan dirotasi tanpa rencana. Mengganti kunci membatalkan sesi/CSRF berjalan (login ulang). |
| `APP_ENCRYPTION_KEY(S)` | AES-256-GCM untuk NIK, selfie, dokumen, rahasia TOTP | `openssl rand -base64 32`, **berbeda** dari kunci HMAC | **Ada rotasi** (`rotasi-kunci.md`, ADR-0013): `APP_ENCRYPTION_KEYS` berversi + alat re-encrypt. Kehilangan semua salinan kunci yang dibutuhkan data = data **tidak dapat dibaca** selamanya; kunci lama disimpan selama masih ada cadangan lama. |
| `GOOGLE_CLIENT_SECRET` | OIDC member | Google Cloud Console | Buat secret baru → isi → restart → hapus yang lama. |
| `SMTP_PASSWORD` | Pengiriman email | Penyedia SMTP | Ganti di penyedia lalu isi ulang, restart. |
| Kata sandi DB (`DATABASE_URL`, `MIGRATE_DATABASE_URL`) | Akses PostgreSQL | Penyedia DB | Rotasi di DB lalu isi ulang, restart. |
| Frasa sandi cadangan (`BACKUP_PASSPHRASE_FILE`) | Enkripsi berkas cadangan | `openssl rand -base64 48 > frasa` (mode 0400) | Cadangan lama tetap butuh frasa lama: simpan versi lama selama masa retensi cadangan. |

## Aturan cadangan kunci
- `APP_ENCRYPTION_KEY` dan frasa cadangan **disimpan terpisah** dari cadangan database/objek (mis. brankas kata sandi organisasi dengan akses dua orang). Satu tempat yang sama dengan data = enkripsi tidak berarti.
- Uji pemulihan kunci setiap kali latihan restore (kunci dari brankas, bukan dari server asal).

## Rotasi kunci enkripsi
Sudah tersedia: lihat `rotasi-kunci.md` (ADR-0013). **Belum ada**: rotasi `AUTH_HMAC_KEY` (A-60).

## Bila rahasia diduga bocor
1. Anggap bocor: rotasi segera (tabel di atas), cabut semua sesi (`deploy.md`).
2. Periksa audit log kategori TEKNIS untuk akses tak wajar.
3. Bila terkait data pribadi: ikuti kewajiban pemberitahuan UU PDP (konsultasikan penasihat hukum; kebijakan final menunggu pemilik).
4. Bersihkan riwayat git bila rahasia sempat ter-commit (`.claude/rules/security.md`).
