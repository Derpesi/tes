# ADR-0013: Rotasi Kunci Enkripsi Berversi

- Status: **Diimplementasikan** (Fase 11B; menunggu persetujuan pemilik). Tanggal: 2026-11-22. Menutup A-53 dan temuan T-7.

## Konteks
`APP_ENCRYPTION_KEY` tunggal melindungi NIK, rahasia TOTP, payload outbox, berkas member/kontrak, dan selfie. Tanpa rotasi, kebocoran atau kebijakan penggantian kunci tidak dapat dilaksanakan tanpa risiko kehilangan data.

## Keputusan
1. **Kunci berversi**: `APP_ENCRYPTION_KEYS="1:<b64>,2:<b64>"`; id tertinggi = aktif; `APP_ENCRYPTION_KEY` = id 1 bila `KEYS` kosong. Validasi gagal-cepat (32 byte, unik, tidak lemah di produksi, beda dari `AUTH_HMAC_KEY`, konsisten bila keduanya diisi).
2. **Format**: `0xE1 | id | iv | tag | ciphertext`. Pembacaan mencoba versi berawalan lalu jatuh ke **format lama** (kunci id 1); aman karena autentikasi GCM pasti gagal pada tebakan salah. Aplikasi memuat semua kunci → rotasi berjalan online. AAD tetap mengikat konteks (baris/objek).
3. **Alat re-encrypt** (`cek`/`jalan`/`verifikasi`): role BYPASSRLS khusus; idempoten; bandingan optimistis (tidak menimpa perubahan serentak); objek ditimpa atomik (tulis sementara + rename); objek hilang/tertukar dilaporkan, tidak dirotasi diam-diam; `verifikasi` membuka semua data hanya dengan kunci aktif; audit teknis hanya hitungan; opsi `--jeda-ms` mengendalikan dampak I/O.
4. **Kunci lama** dipertahankan selama cadangan sebelum rotasi masih dalam retensi.

## Konsekuensi dan batas
- Rotasi `AUTH_HMAC_KEY` belum ada (A-60). Dokumen master tidak dienkripsi aplikasi (A-61).
- Tanpa jeda, rotasi 2,5 GB menaikkan tail latency scan (p95 7,7 dtk); dengan jeda 100 ms/100 objek p95 20 ms. Jalankan di luar jam puncak.
- Tes: unit (cincin, format lama, env), integrasi PostgreSQL asli (penuh di superuser/CI), uji mutasi, uji beban.
