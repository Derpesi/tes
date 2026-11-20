# RBAC dan Hak Akses Staff Internal

Kode: **V** lihat, **C** buat, **U** ubah, **D** nonaktifkan, **K** periksa/verifikasi, **A** setujui, **E** ekspor, **F** finalisasi. `–` = tidak ada. `S` = hanya ringkasan tanpa PII/nominal. Semua hak dibatasi scope perusahaan + lokasi di backend. Pembayaran/transfer tidak ada pada tahap awal.

| Modul | Direktur | Mgr Ops | IT | HRD | Marketing | Adm | Pay-Abs Rekanan | Keuangan | Pay Internal |
|---|---|---|---|---|---|---|---|---|---|
| Perusahaan | V,A | V | V,U(konfig) | V | V | V | – | V | – |
| Rekanan & lokasi | V | V,C,U | V | V | V,C,U | V,C,U | V | V | – |
| Kontrak layanan rekanan | V,A | V | – | V | V,C,U | V | – | V | – |
| Database member | V | S | S | V,C,U,K,A,E | S | V,U(validasi) | – | – | – |
| Lowongan & lamaran | V | V | – | V,C,U,K,A,E | V | V | – | – | – |
| PKWT | V,A | V | – | V,C,U,K,E | – | C(draft),V | V | V | – |
| Verifikasi dokumen PKWT | – | – | – | K | – | – | – | – | – |
| Penempatan & jadwal | V | V,C,U,A | – | V,C,U | V | V | V,U(shift) | – | – |
| Titik absensi & QR | V | V,C,U,D | V | – | – | C,U,E(PDF) | V | – | – |
| Rekap absensi | V | V,E | – | V | – | V | V,E | V | V(internal) |
| Lihat selfie | – | V | – | – | – | – | V(rekanan) | – | V(internal) |
| Tinjau anomali absensi | V | A | – | – | – | – | K | – | K(internal) |
| Koreksi absensi | V | A | – | – | – | – | C,U | – | C(internal) |
| Rekap payroll rekanan | V | V | – | – | – | – | C,U | K,E | – |
| Rekap payroll internal | V,A | – | – | – | – | – | – | K | C,U,E |
| Persetujuan rekap | A,F | – | – | – | – | – | – | A,F | – |
| Pengguna & role | A | – | C,U,D | – | – | – | – | – | – |
| Retensi/konfigurasi | A | – | U | – | – | – | – | – | – |
| Audit log | V | V* | V(teknis, tanpa PII) | – | – | – | – | V(transaksi) | – |
| Laporan konsolidasi | V,E | V* | – | V* | V* | – | – | V*,E | – |

`*` = hanya dalam scope. Daftar penampil selfie adalah asumsi A-09 (menunggu persetujuan).

## Permission granular (contoh)
`member.verify`, `application.manage`, `contract.document.verify`, `contract.template.manage`, `attendance.adjust.create`, `attendance.adjust.approve`, `selfie.view`, `payroll.recap.prepare`, `payroll.recap.verify`, `payroll.recap.approve`, `export.generate`, `retention.configure`, `user.invite`, `role.assign`. `bootstrap.run` hanya CLI operator, bukan peran.

## Aturan penegakan
- Least privilege dan deny-by-default; izin dicek di backend per endpoint.
- Pemisahan tugas: pembuat ≠ pemeriksa ≠ penyetuju ≠ finalisator untuk dokumen yang sama.
- Pemberian peran admin/tingkat tinggi memerlukan persetujuan ganda (mis. IT mengajukan, Direktur menyetujui).
- IT tidak melihat PII, selfie, atau nominal secara default.
- Selfie tidak terlihat oleh IT, Marketing, Admin, atau Direktur secara default.
- Aksi sensitif (persetujuan rekap, ubah rekening, pemberian peran, akses selfie) masuk audit trail.
- Tidak ada Super Admin permanen; akun bootstrap berumur terbatas.
