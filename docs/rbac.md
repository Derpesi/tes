# RBAC dan Hak Akses Staff Internal

Kode: **V** lihat, **C** buat, **U** ubah, **D** nonaktifkan, **K** periksa/verifikasi, **A** setujui, **E** ekspor, **F** finalisasi. `–` = tidak ada. `S` = hanya ringkasan tanpa PII/nominal. (Koreksi Fase 4A: IT `C` pada Perusahaan, Manager Operasional `D` pada Rekanan & lokasi, dan modul baru *Dokumen legalitas perusahaan*. Koreksi Fase 3D: modul *Pengguna & role* diberi `V` untuk Direktur dan IT; tanpa `V` tidak ada yang dapat melihat daftar pengguna/persetujuan.) Semua hak dibatasi scope perusahaan + lokasi di backend. Pembayaran/transfer tidak ada pada tahap awal. (Fase 6: terminasi kontrak lebih awal memakai `pkwt.approve`; verifikasi template memakai `pkwt.approve`; reaktivasi member memakai `member.review`; kualifikator sel seperti "U(shift)" belum ditegakkan.)

| Modul | Direktur | Mgr Ops | IT | HRD | Marketing | Adm | Pay-Abs Rekanan | Keuangan | Pay Internal |
|---|---|---|---|---|---|---|---|---|---|
| Perusahaan | V,A | V | V,C,U(konfig) | V | V | V | – | V | – |
| Dokumen legalitas perusahaan | V | – | V,C,U | – | – | V,C,U | – | V | – |
| Rekanan & lokasi | V | V,C,U,D | V | V | V,C,U | V,C,U | V | V | – |
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
| Pengguna & role | V,A | – | V,C,U,D | – | – | – | – | – | – |
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

## Implementasi (Fase 3D)
**Penamaan permission:** `<modul>.<aksi>` dibangkitkan dari matriks (`docs/rbac-pemetaan.json`): V=`view`, C=`create`, U=`update`, D=`deactivate`, K=`review`, A=`approve`, E=`export`, F=`finalize`, S=`view_summary`. Seed ada di migrasi `…rbac-seed` dan `…user-role-view`; tes harness membandingkan database dengan berkas ini.

**Penegakan:** guard global. Rute wajib menyatakan `@Public()`, `@Sesi()`, atau `@RequirePermission('modul.aksi')`; rute tanpa pernyataan ditolak (403 `RUTE_TANPA_IZIN`) dan terdeteksi tes enumerasi rute. Izin dihitung dari database **pada setiap permintaan** (pencabutan, kedaluwarsa peran, dan penonaktifan perusahaan berlaku seketika). Sesi member, sesi tertunda MFA, dan tanpa sesi tidak pernah lolos.

| Endpoint | Permission |
|---|---|
| `GET /roles`, `GET /staff`, `GET /approvals` | `user_role.view` |
| `POST /staff/invitations`, `POST /staff/:id/roles` | `user_role.create` |
| `DELETE /staff/:id/roles/:roleCode`, `POST /staff/:id/deactivate` | `user_role.deactivate` |
| `POST/DELETE /staff/:id/companies…`, `POST/DELETE /staff/:id/all-companies`, `POST /staff/:id/mfa-reset` | `user_role.update` |
| `POST /approvals/:id/approve`, `POST /approvals/:id/reject` | `user_role.approve` |
| `GET /audit-logs` | `audit_log.view` |

**Aturan:**
- Peran **berhak tinggi** (Direktur, IT Administrator) tidak langsung berlaku: dibuat permintaan persetujuan (kedaluwarsa 72 jam) yang harus diputuskan pihak lain pemegang `user_role.approve` (Direktur). Pemohon ≠ penyetuju ditegakkan aplikasi dan constraint database.
- **Pengecualian Direktur pertama:** admin yang memegang peran berasal dari bootstrap dapat menunjuk Direktur **pertama** langsung, hanya selagi belum ada peran Direktur (aktif atau diundang) sama sekali; teraudit (`auth.first_director.exception`).
- **Akses seluruh perusahaan** dan **reset MFA** memerlukan persetujuan. Reset MFA mengembalikan akun ke undangan (faktor MFA, kode pemulihan, dan kata sandi dihapus; semua sesi dicabut) agar yang tahu kata sandi lama tidak dapat mendaftarkan TOTP-nya sendiri.
- Tidak ada yang dapat mengubah peran, scope, atau status akunnya sendiri.
- **Audit log:** pembacaan dibatasi RLS. Baris perusahaan hanya untuk pemegang scope perusahaan itu; baris global (company_id kosong: peristiwa auth/sistem) hanya untuk Direktur dan IT Administrator. IT tidak melihat PII (detail audit tidak memuat PII).
- Kualifikator sel (mis. "rekanan", "internal", "draft") **belum ditegakkan**; diterapkan di modul terkait (Fase 5 dan seterusnya).


## Catatan penegakan Fase 7
`RequirePermission(izin, ...alternatif)` berarti pemegang **salah satu** izin diizinkan; dipakai hanya untuk daftar baca yang harus terbuka bagi pelaksana tindakan (antrean tinjauan: `attendance_anomaly.view|review|approve`; koreksi: `attendance_adjustment.view|create|update|approve`; titik absensi: `attendance_point.view|create|update|export`). Izin aksi tetap tunggal dan tidak berubah. Kualifikator sel (mis. PayAbs "U(shift)", penampil selfie "rekanan/internal") belum ditegakkan di kode.

## Catatan penegakan Fase 8
Rekap payroll: izin dipisah per jenis (`payroll_recap_partner.*` untuk rekanan, `payroll_recap_internal.*` untuk internal) dan diperiksa di layanan; rute baca terbuka bagi pemegang izin apa pun lalu disaring per jenis. Persetujuan dan finalisasi memakai `payroll_approval.approve|finalize` untuk kedua jenis (A-41). Pembuat, pemeriksa, penyetuju, finalisator harus orang berbeda (aplikasi + database).
