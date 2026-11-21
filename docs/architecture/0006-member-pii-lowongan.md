# ADR-0006: Member, Perlindungan PII, Lowongan, dan Lamaran

- Status: **Disetujui** (diimplementasikan dan diuji pada Fase 5)
- Tanggal: 2026-11-21

## Konteks
Member (pencari kerja) bersifat lintas perusahaan Group, sedangkan lowongan dan lamaran dikelola per perusahaan. Biodata, NIK, dan dokumen identitas adalah PII sensitif. Aturan keras: karyawan aktif diblokir melamar **di backend (403)**; isolasi perusahaan ditegakkan di backend + RLS.

## Keputusan
1. **Tabel member global** (`member_profiles`, `member_documents`, `member_status_histories`) tanpa `company_id`. Akses staff dijaga permission `member.*`; self-service dijaga `person_id` dari sesi (tidak pernah dari input). Status member adalah kolom `member_profiles.status`; Fase 5 menggerakkan sampai `BELUM_DITEMPATKAN`, Fase 6 menggerakkan sisanya.
2. **NIK:** AES-256-GCM (AAD `member_profile:<id>:nik`) + blind index HMAC berprefiks domain `pii:nik:` (unik) + `key_version`. NIK tersamar di API staff; pembukaan penuh hanya `member.review` dan diaudit. Duplikat NIK = 409 dengan pesan generik. Rotasi kunci belum ada (keterbatasan).
3. **Dokumen identitas:** isi dienkripsi sebelum disimpan (AAD = kunci objek `<person_id>/<uuid>`), validasi magic bytes/ukuran/ekstensi, unduhan hanya lewat API (pemilik, atau `member.review` dengan audit), hapus lunak.
4. **Lowongan** memakai kolom `company_id` (perusahaan pengelola) dengan RLS tenant; member membaca lowongan DIBUKA lintas perusahaan lewat kebijakan RLS `lowongan_baca_member` yang hanya aktif bila transaksi diberi `memberRead` (`ScopedDb`); member juga membaca lowongan yang pernah dilamar (`lowongan_baca_pelamar`). DTO member tidak memuat catatan internal.
5. **Lamaran** (`job_applications`): `company_id` diturunkan dari lowongan, `person_id` dari sesi; kebijakan RLS memastikan member hanya membuat lamaran atas namanya ke lowongan yang **sedang dibuka** dan hanya dapat menarik (status DITARIK). Riwayat hanya-tambah (trigger) di `application_status_histories` ber-`company_id`.
6. **CanApply** (`canApply()` di `member-recruitment.service.ts`) adalah satu-satunya sumber aturan: hanya `TERVERIFIKASI`/`BELUM_DITEMPATKAN` boleh melamar; `KARYAWAN_AKTIF`/`KONTRAK_AKAN_BERAKHIR` 403, `KONTRAK_BERAKHIR` perlu verifikasi HRD, `NONAKTIF` 403, selain itu belum terverifikasi 403. Dievaluasi dalam transaksi yang sama dengan baris profil (`FOR SHARE`) dan sebelum pemeriksaan lowongan. UI hanya menyembunyikan menu.
7. **Seleksi:** DIAJUKAN → SELEKSI_ADMINISTRASI → INTERVIEW → DITERIMA → MENUNGGU_PKWT, atau DITOLAK/DITARIK. Pindah tahap/tolak = `vacancy_application.review`, terima = `vacancy_application.approve`; pelamar yang sudah karyawan aktif tidak dapat diterima. Akhir Fase 5 = `MENUNGGU_PKWT`; PKWT dan penempatan di Fase 6.

## Konsekuensi dan keterbatasan
Rotasi kunci enkripsi belum ada; belum ada pemindai virus; audit peristiwa member tanpa perusahaan hanya terlihat Direktur/IT (A-22), HRD melihat riwayat status lewat API/UI; notifikasi email status lamaran belum ada; kualifikator sel matriks (mis. Adm "U(validasi)") belum ditegakkan; biodata final dan masa retensi dokumen identitas menunggu pemilik/UU PDP; konkurensi (`FOR UPDATE/SHARE`) dijaga guard status atomik tetapi tes serentak tidak membedakannya.
