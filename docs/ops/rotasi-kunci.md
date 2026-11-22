# Runbook: Rotasi Kunci Enkripsi

Menutup blokir go-live #8 / A-53 (ADR-0013). Mencakup **kunci enkripsi AES-256-GCM** (`APP_ENCRYPTION_KEY(S)`): NIK, rahasia TOTP, payload outbox, berkas member/kontrak, selfie. **Tidak** mencakup `AUTH_HMAC_KEY` (indeks buta; A-60).

## Konsep
- Kunci berversi: `APP_ENCRYPTION_KEYS="1:<b64>,2:<b64>"`. **Id tertinggi = aktif** (semua penulisan baru). Kunci lain hanya untuk membaca data lama. Tanpa `APP_ENCRYPTION_KEYS`, `APP_ENCRYPTION_KEY` = id 1 (kompatibel).
- Ciphertext baru berawalan `0xE1|id`; data lama (tanpa awalan) dibaca sebagai id 1. Aplikasi memuat kedua kunci sehingga rotasi dapat berjalan **sambil aplikasi melayani lalu lintas**.
- Alat: `node dist/cli/rotasi-kunci.js cek|jalan|verifikasi` (`pnpm ops:rotasi -- <perintah>` dari repo). Wajib `ROTASI_DATABASE_URL` = **role BYPASSRLS khusus** (RLS dipaksa; role aplikasi **ditolak**). Opsi: `--kering` (tanpa menulis), `--batas N` (baris per batch, bawaan 500), `--jeda-ms N` (jeda tiap batch; lihat dampak di bawah). Kunci dibaca dari env yang sama dengan aplikasi (`APP_ENCRYPTION_KEYS`, `STORAGE_DIR`).

## Prosedur
1. **Cadangan** dulu (`restore.md`) dan catat kunci lama di brankas.
2. Bangkitkan kunci baru: `openssl rand -base64 32` (berbeda dari semua kunci lain; tersimpan di brankas terpisah dari data).
3. Set `APP_ENCRYPTION_KEYS=1:<lama>,2:<baru>` (kosongkan `APP_ENCRYPTION_KEY` atau samakan dengan id 1); **restart API** (satu instans). Mulai saat ini data baru memakai kunci 2.
4. `cek` — hitungan per tabel per versi (tanpa mengubah). Lalu `jalan --kering` bila ingin gambaran.
5. `jalan --batas 100 --jeda-ms 100` **di luar jam puncak** (lihat di bawah). Idempoten dan aman diulang/diinterupsi; baris yang berubah serentak dilaporkan dan diproses pada run berikutnya.
6. `verifikasi` — membuka semua data **hanya dengan kunci aktif**. Keluaran "Semua data berada pada kunci aktif" (kode 0) = kunci lama tidak lagi dibutuhkan oleh data hidup. Bila ada "gagal dekripsi", selidiki (objek tertukar/rusak) — jangan buang kunci lama.
7. **Kunci lama tetap disimpan di brankas** selama masih ada **cadangan** yang dibuat sebelum rotasi dan masih dalam retensi: cadangan itu hanya terbaca dengan kunci lamanya. Setelah semua cadangan lama kedaluwarsa, hapus id 1 dari `APP_ENCRYPTION_KEYS` dan restart.
8. Cadangan segar setelah rotasi (berisi data v2) dan catat tanggal rotasi.

## Dampak kinerja (diukur, 1 VM, data sintetis; bukan SLA)
Dataset beban: 10.000 NIK + 24.770 objek (2,5 GB), aplikasi melayani scan 40 req/dtk sepanjang rotasi.
| Mode | Durasi | Scan selama rotasi |
|---|---|---|
| Tanpa jeda | 67 dtk | **p95 7,7 dtk** (p50 19 ms): I/O penulisan 2,5 GB (fsync per objek) menumpuk antrean — **jangan di jam puncak** |
| `--batas 100 --jeda-ms 100` | 96 dtk | **p95 20 ms**, p99 38 ms, 0 galat |
| `cek` (cache dingin vs hangat) | 3 mnt 54 dtk vs 8 dtk | baca 2,5 GB dari disk dingin mendominasi |
Estimasi kasar: 180–540 GB objek selfie (jika diaktifkan lagi) → jam hingga hari dengan jeda; selfie ditiadakan sementara (ADR-0012) sehingga objek hidup hanya dokumen. Ukur ulang di infrastruktur nyata.

## Keamanan dan batas
- Alat tidak mencetak nilai rahasia; catatan audit teknis `system.key_rotation.run` hanya berisi hitungan.
- Objek yang AAD-nya tidak cocok (tertukar) **tidak** dirotasi diam-diam: dilaporkan sebagai gagal dekripsi dan dibiarkan utuh.
- Dokumen master (`company_documents`, kontrak layanan rekanan) **tidak dienkripsi aplikasi** (disimpan apa adanya) sehingga di luar lingkup rotasi — lihat A-61.
- Rotasi `AUTH_HMAC_KEY` belum ada (A-60): mengganti kunci itu membatalkan sesi/CSRF dan merusak indeks buta NIK/email/sub dan hash kode pemulihan.
- Kehilangan **semua** salinan kunci aktif/lama yang dibutuhkan data = data tidak terbaca selamanya.
