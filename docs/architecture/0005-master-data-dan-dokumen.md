# ADR-0005: Master Data Multi-Perusahaan dan Penyimpanan Dokumen

- Status: **Disetujui** (diimplementasikan dan diuji pada Fase 4)
- Tanggal: 2026-11-21

## Konteks
Grup membutuhkan perusahaan yang dapat ditambah tanpa ubah kode, rekanan (klien outsourcing) sebagai master data internal, lokasi kerja berkoordinat untuk absensi (Fase 7), kontrak layanan, dan dokumen legalitas. Aturan keras: tidak ada portal/akun/login rekanan; isolasi ditegakkan di backend + RLS.

## Keputusan
1. **Perusahaan baru lewat master data.** IT Administrator membuat perusahaan (nonaktif); perusahaan berlaku setelah **Direktur menyetujui** permintaan aktivasi (`approval_requests` tipe `AKTIVASI_PERUSAHAAN`). Tiga perusahaan awal di-seed oleh operator (`pnpm seed:perusahaan`, hanya nama + kode singkat usulan).
2. **`companies` tanpa RLS** (id-nya adalah tenant dan dibaca untuk menghitung scope). Visibilitas ditegakkan di layanan: perusahaan dalam scope ∪ perusahaan nonaktif buatan sendiri; selain itu 404.
3. **Rekanan dimiliki satu perusahaan** (`partners.company_id`); lokasi, kontak, kontrak, kebutuhan tenaga mewarisi `company_id` lewat FK komposit `(id, company_id)` dan semuanya ber-RLS. Rekanan yang dilayani dua perusahaan = dua catatan (konsekuensi duplikasi diterima).
4. **`company_id` tidak pernah dari input bebas.** Anak diturunkan dari induk yang terlihat lewat RLS; `companyId` pada pembuatan rekanan wajib salah satu dari scope. Menebak ID lintas perusahaan = 404.
5. **Kontrak layanan:** `DRAFT → AKTIF → BERAKHIR`, `DRAFT → DIBATALKAN`; transisi lain 409. Aktivasi/pengakhiran oleh pemegang `partner_contract.approve` (Direktur), penyetuju ≠ pembuat (aplikasi + constraint DB). Isi hanya dapat diubah saat DRAFT. Sistem tidak membuat klausul hukum; template resmi menyusul.
6. **Dokumen:** antarmuka `ObjectStorage` + driver lokal (direktori privat 0700/0600, di luar web root). Unggahan: ≤ 10 MB, hanya PDF/PNG/JPEG berdasarkan **magic bytes**, ekstensi harus cocok, nama disanitasi, SHA-256 disimpan, kunci objek acak `<company_id>/<uuid>`. Unduhan dialirkan lewat API (izin + scope + audit; `attachment`, `nosniff`, `no-store`), tanpa URL publik. Penghapusan lunak (objek dipertahankan untuk audit/hukum). Respons API tidak memuat kunci objek.
7. Pengaturan payroll/dokumen perusahaan berupa JSON tervalidasi ketat (`.strict()`), bentuk final menunggu kebijakan pemilik (A-24).

## Konsekuensi dan keterbatasan
Driver S3 belum ada (menunggu pilihan hosting, D-06); belum ada pemindai virus; UI unggah dokumen belum ada (API siap); logo perusahaan tidak diimplementasi (menunggu aset resmi pemilik); koreksi pasca-aktif kontrak (adendum/versi) ditunda ke Fase 6.
