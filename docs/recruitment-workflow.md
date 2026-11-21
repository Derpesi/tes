# Alur Rekrutmen, PKWT, dan Penempatan

Status akun, profil, lamaran, kontrak, dan penempatan dipisah. "Tahap member" hanya tampilan turunan. Setiap transisi dicatat di `status_histories` (waktu, petugas, alasan).

## Member
```mermaid
stateDiagram-v2
  [*] --> TERDAFTAR
  TERDAFTAR --> PROFIL_BELUM_LENGKAP
  PROFIL_BELUM_LENGKAP --> MENUNGGU_VERIFIKASI: biodata lengkap
  MENUNGGU_VERIFIKASI --> TERVERIFIKASI: HRD setuju
  MENUNGGU_VERIFIKASI --> PROFIL_BELUM_LENGKAP: perlu revisi
  TERVERIFIKASI --> BELUM_DITEMPATKAN
  BELUM_DITEMPATKAN --> KARYAWAN_AKTIF: PKWT aktif + penempatan aktif
  KARYAWAN_AKTIF --> KONTRAK_AKAN_BERAKHIR
  KONTRAK_AKAN_BERAKHIR --> KARYAWAN_AKTIF: diperpanjang
  KONTRAK_AKAN_BERAKHIR --> KONTRAK_BERAKHIR
  KONTRAK_BERAKHIR --> BELUM_DITEMPATKAN: verifikasi HRD
  KONTRAK_BERAKHIR --> NONAKTIF
  BELUM_DITEMPATKAN --> NONAKTIF
```

## Lowongan dan lamaran
- Member belum ditempatkan melihat dan melamar lowongan **semua perusahaan Group**. Tiap lowongan wajib punya perusahaan pengelola.
- Staff mengelola lowongan dan lamaran hanya pada perusahaan dalam scope-nya.
- Guard backend `CanApply`: tolak (403) bila status `KARYAWAN_AKTIF` atau `KONTRAK_AKAN_BERAKHIR`; UI menyembunyikan menu lowongan, tetapi backend yang menegakkan.
- Kembali ke pencari kerja setelah `KONTRAK_BERAKHIR` hanya lewat verifikasi HRD.

```mermaid
stateDiagram-v2
  [*] --> DIAJUKAN
  DIAJUKAN --> SELEKSI_ADMINISTRASI
  SELEKSI_ADMINISTRASI --> INTERVIEW: lolos
  SELEKSI_ADMINISTRASI --> DITOLAK
  INTERVIEW --> DITERIMA
  INTERVIEW --> DITOLAK
  DITERIMA --> MENUNGGU_PKWT
  DIAJUKAN --> DITARIK
  SELEKSI_ADMINISTRASI --> DITARIK
  INTERVIEW --> DITARIK
```

## PKWT
Tahap awal: generate PDF, cetak, tanda tangan basah, scan dan unggah, verifikasi HRD. Tombol "setuju" bukan tanda tangan sah. Template resmi menyusul dan **tidak ada klausul hukum karangan**; template berstatus `BELUM_DIVERIFIKASI` tidak dapat dipakai untuk kontrak aktif. Arsitektur menyediakan `SignatureProvider` untuk integrasi PSrE tersertifikasi pada fase berikutnya.

```mermaid
stateDiagram-v2
  [*] --> DRAFT
  DRAFT --> REVIEW
  REVIEW --> DRAFT: revisi
  REVIEW --> PERSETUJUAN
  PERSETUJUAN --> PENANDATANGANAN
  PERSETUJUAN --> DRAFT: ditolak
  PENANDATANGANAN --> MENUNGGU_VERIFIKASI_DOKUMEN: scan diunggah
  MENUNGGU_VERIFIKASI_DOKUMEN --> DITANDATANGANI: HRD verifikasi
  MENUNGGU_VERIFIKASI_DOKUMEN --> PENANDATANGANAN: ditolak + alasan
  DITANDATANGANI --> AKTIF: tanggal mulai tiba
  AKTIF --> BERAKHIR: jatuh tempo
  AKTIF --> AKTIF: versi baru (perpanjangan)
  DRAFT --> DIBATALKAN
  REVIEW --> DIBATALKAN
  PENANDATANGANAN --> DIBATALKAN
  AKTIF --> DIAKHIRI_LEBIH_AWAL
```
Setiap perubahan = versi baru di `contract_versions` (tidak menimpa). Masa kerja, perpanjangan, dan kompensasi mengikuti aturan berversi yang diverifikasi ahli hukum.

> **Status implementasi (Fase 5):** alur member dan lamaran di atas sudah diimplementasikan sampai lamaran `MENUNGGU_PKWT` dan member `BELUM_DITEMPATKAN`. PKWT, penempatan, dan status `KARYAWAN_AKTIF` dan seterusnya (otomatis) dikerjakan di Fase 6; `CanApply` sudah menegakkan blokir karyawan aktif di backend.

## Penempatan
```mermaid
stateDiagram-v2
  [*] --> DIRENCANAKAN
  DIRENCANAKAN --> MENUNGGU_KONTRAK
  MENUNGGU_KONTRAK --> AKTIF: PKWT aktif
  AKTIF --> DITANGGUHKAN
  DITANGGUHKAN --> AKTIF
  AKTIF --> DIPINDAHKAN: penempatan baru
  AKTIF --> SELESAI: kontrak berakhir
  DIRENCANAKAN --> DIBATALKAN
```
Dua penempatan aktif yang tumpang tindih untuk satu karyawan ditolak oleh database.
