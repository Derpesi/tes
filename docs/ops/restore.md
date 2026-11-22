# Runbook: Cadangan dan Restore

> **Cadangan dan rotasi kunci (ADR-0013):** cadangan yang dibuat **sebelum** rotasi hanya terbaca dengan kunci enkripsi **lamanya**. Simpan kunci lama selama cadangan itu masih dalam retensi (`rotasi-kunci.md` langkah 7); restore memerlukan `APP_ENCRYPTION_KEYS` yang memuat semua id yang dipakai data cadangan.
> **Selfie ditiadakan sementara (ADR-0012):** selama `ABSENSI_SELFIE=off` penyimpanan objek tidak bertambah oleh selfie; objek hanya dokumen kontrak dan selfie lama yang belum dihapus retensi. Angka ukuran selfie di bawah berlaku bila diaktifkan kembali.
Target (asumsi A-02, bukan SLA): **RPO 24 jam**, **RTO 8 jam**. Skrip: `scripts/ops/backup.mjs`, `restore.mjs`, `verifikasi-restore.mjs` (Node tanpa dependency baru; butuh `pg_dump`, `pg_restore`, `openssl`, `tar` di PATH).

## Yang dicadangkan
1. **Database** (`pg_dump --format=custom`, satu snapshot konsisten) + hitungan baris tiap tabel pada snapshot yang sama.
2. **Penyimpanan objek** (`STORAGE_DIR`: selfie/dokumen **sudah terenkripsi aplikasi**) sebagai `objek.tar` (tanpa kompresi).
3. **Manifes** (`manifes.json`): checksum SHA-256 tiap berkas, jumlah migrasi, hitungan baris, versi PostgreSQL.
4. **TIDAK ikut**: `APP_ENCRYPTION_KEY`, `AUTH_HMAC_KEY`, frasa sandi cadangan. Simpan **terpisah** (`secrets.md`). Tanpa `APP_ENCRYPTION_KEY`, NIK/selfie/dokumen hasil restore **tidak terbaca**.
5. Hak (GRANT) role aplikasi **tidak** ikut cadangan; terapkan ulang provisioning (`deploy.md`).

## Prasyarat role (ditemukan saat latihan)
RLS **dipaksa** pada semua tabel tenant, sehingga role biasa — termasuk pemilik tabel — tidak dapat membuat cadangan lengkap maupun melakukan restore:
- **Role cadangan**: `LOGIN`, **`BYPASSRLS`**, hanya-baca (`GRANT pg_read_all_data`). Skrip menolak role yang tidak bisa melewati RLS (cadangan akan kosong/ditolak `pg_dump`).
- **Role restore**: superuser atau `BYPASSRLS` + hak membuat objek (validasi FK pada tabel RLS-paksa gagal untuk role biasa). Untuk `RESTORE_OWNER_ROLE`, role restore harus **anggota** role pemilik (`GRANT <pemilik> TO <role restore>`).
- Kedua role ini **tidak dipakai aplikasi** dan kredensialnya hanya di brankas operator.

## Cadangan
```
BACKUP_DATABASE_URL=postgres://<role-cadangan>@<host>/<db> \
BACKUP_DIR=/mnt/cadangan  STORAGE_DIR=/var/lib/hris/objek \
BACKUP_PASSPHRASE_FILE=/rahasia/frasa-cadangan  RETENSI_HARI=14 \
node scripts/ops/backup.mjs
```
Keluaran `hris-<UTC>/` berisi `db.dump.enc`, `objek.tar.enc`, `manifes.json`. Enkripsi `openssl aes-256-cbc -pbkdf2 -iter 600000` — dapat dibuka dengan `openssl` biasa meski skrip hilang. `RETENSI_HARI` hanya menghapus set lama yang cocok pola `hris-<UTC>`. Jadwalkan harian (RPO 24 jam) dan **salin keluar mesin/zona** (cadangan di mesin yang sama dengan data bukan cadangan). Peringatan bila cadangan terakhir > 26 jam (`monitoring.md`).

## Restore (ke database BARU, tidak pernah menimpa)
```
createdb -O <role-restore> hris_pulih
TARGET_DATABASE_URL=postgres://<role-restore>@<host>/hris_pulih \
RESTORE_OWNER_ROLE=<role-pemilik-skema> \
BACKUP_PASSPHRASE_FILE=/rahasia/frasa-cadangan  STORAGE_TARGET_DIR=/var/lib/hris/objek-pulih \
node scripts/ops/restore.mjs /mnt/cadangan/hris-<UTC>
```
Skrip: (1) memeriksa checksum semua berkas (cadangan rusak/diubah ditolak), (2) menolak bila database target tidak kosong, (3) dekripsi + `pg_restore`, (4) mengalihkan kepemilikan, (5) memulihkan objek, (6) **verifikasi otomatis**: jumlah baris semua tabel = manifes, riwayat migrasi sama, RLS aktif+dipaksa+berkebijakan pada **semua** tabel tenant, trigger audit hanya-tambah, fungsi inti, ekstensi.

Setelah restore: terapkan GRANT role aplikasi → arahkan `DATABASE_URL` + `STORAGE_DIR` ke hasil restore → **cabut semua sesi** (`deploy.md`) → jalankan `GET /ready` → uji asap (login staf, buka satu selfie) → **jalankan tes isolasi terhadap hasil restore** bila lingkungan non-produksi (`TEST_DATABASE_URL=<hasil restore> pnpm test:isolation`; menulis data uji sintetis, jangan di produksi).

## Hasil latihan (2026-11-22, 1 VM 4 vCPU/16 GB, data SINTETIS, PostgreSQL 16 bawaan)
Dataset: 3 perusahaan, 500 lokasi, 10.000 pekerja, **1,42 juta baris** (60 tabel, 22 migrasi), database 805 MB; penyimpanan objek **2,5 GB** (≈ 25 ribu selfie sintetis ~100 KB). Cadangan terenkripsi.

| Langkah | Waktu |
|---|---|
| Cadangan total (dump konsisten 7,3 dtk + arsip + enkripsi objek) | **23,3 dtk** (dump 54 MB terenkripsi) |
| Restore: checksum + dekripsi | 5,7 dtk |
| Restore: `pg_restore` (4 job) | 12,3 dtk |
| Restore: objek 2,5 GB | 13,4 dtk |
| Restore total + verifikasi otomatis | **31,7 dtk** — 7/7 pemeriksaan lulus |
| Tes isolasi (115) terhadap DB hasil restore | **115 lulus** |
| API dijalankan terhadap hasil restore; selfie dibaca staf, **terdekripsi dengan kunci asli**, tercatat di audit | OK (200, JPEG utuh) |
| Uji rusak: 1 byte berkas diubah | **ditolak** ("Checksum tidak cocok") |
| Uji target tidak kosong | **ditolak** |

Temuan latihan (sudah diperbaiki di skrip/dokumen): `pg_dump` dan restore **gagal untuk role biasa** karena RLS dipaksa (prasyarat role di atas); `ALTER OWNER` butuh keanggotaan role + `GRANT CREATE ON SCHEMA public`; fungsi milik ekstensi (btree_gist) tidak boleh dialihkan pemiliknya; kompresi gzip pada selfie terenkripsi memakan 80% waktu cadangan tanpa manfaat (110 → 23 dtk setelah dihapus). Latihan juga menemukan tes isolasi payroll yang tidak stabil (urutan pelaporan dua indeks unik berubah setelah restore) — diperbaiki.

## Ekstrapolasi (perkiraan kasar, BUKAN hasil ukur)
- Pertumbuhan: ±0,6 KB/rekaman absensi (termasuk indeks). 10.000 pekerja × 2 rekaman/hari × 365 ≈ 7,3 juta rekaman/tahun ≈ **4–5 GB/tahun** database (lebih bila audit/lampiran besar).
- **Selfie adalah pendorong ukuran**: 10.000 pekerja × 2 selfie/hari × 100–300 KB ≈ **2–6 GB/hari**; retensi 90 hari ≈ **180–540 GB** penyimpanan objek (usulan retensi A-03 sangat memengaruhi biaya).
- Restore objek pada disk lokal ≈ 190 MB/dtk di sini; **180–540 GB ≈ 16–48 menit pada disk lokal**; pada jaringan/penyimpanan objek nyata dominan oleh bandwidth. RTO 8 jam **tampak layak secara hitungan** tetapi **harus divalidasi di infrastruktur nyata** (staging) — A-02 belum dinyatakan tervalidasi penuh.
- Cadangan penuh harian atas 180–540 GB objek tidak efisien: gunakan cadangan inkremental/replikasi bucket saat driver S3 ada (blokir go-live #9).

## Keterbatasan
Satu VM, data sintetis, tanpa jaringan antar-zona, tanpa PITR/WAL archiving (RPO 24 jam = cadangan harian; RPO lebih ketat butuh arsip WAL — keputusan setelah hosting dipilih), cadangan objek penuh (bukan inkremental).
