# ADR-0007: PKWT, Penempatan, dan Status Karyawan Otomatis

- Status: **Disetujui** (diimplementasikan dan diuji pada Fase 6)
- Tanggal: 2026-11-21

## Konteks
Setelah lamaran diterima (`MENUNGGU_PKWT`), pekerja perlu dikontrak (PKWT), ditempatkan di lokasi rekanan, dan statusnya (karyawan aktif, kontrak akan berakhir/berakhir) harus berubah otomatis sehingga aturan "karyawan aktif tidak dapat melamar" berlaku oleh alur nyata. Aturan keras: **tidak ada klausul hukum karangan**, **"setuju" bukan tanda tangan sah**, penempatan tumpang tindih ditolak database, isolasi perusahaan di backend + RLS.

## Keputusan
1. **Template** (`contract_templates`) berisi teks yang disediakan pengguna dengan variabel daftar putih (`{{nama}}`, `{{nik}}`, `{{nomor}}`, `{{jabatan}}`, …). **Sistem tidak membawa teks hukum bawaan.** Direktur mencatat verifikasi hukum (di luar sistem) dengan catatan; pemverifikasi ≠ pembuat; isi terkunci setelah diverifikasi (trigger), perubahan = versi baru.
2. **Kontrak** (`employment_contracts`): DRAFT → REVIEW → PERSETUJUAN → PENANDATANGANAN → MENUNGGU_VERIFIKASI_DOKUMEN → DITANDATANGANI → AKTIF → BERAKHIR (juga DIBATALKAN, DIAKHIRI_LEBIH_AWAL). **Pembuat, pemeriksa, penyetuju berbeda** (aplikasi + CHECK database). Template harus terverifikasi sebelum PERSETUJUAN dan scan terverifikasi sebelum DITANDATANGANI (trigger database). Setiap perubahan isi = versi baru hanya-tambah. Riwayat status hanya-tambah.
3. **Perpanjangan = kontrak lanjutan bertaut** (`extends_contract_id`) yang melewati alur penuh (termasuk scan tanda tangan basah); kontrak yang berjalan tidak pernah ditimpa.
4. **Nomor otomatis** `<prefiks>/<kode perusahaan>/<tahun>/<urut>` dari counter per (perusahaan, tahun) yang dikunci saat penerbitan (tanpa duplikat/celah).
5. **PDF** dibangkitkan sesuai permintaan (pdf-lib) dari isi template + catatan kaki sistem, tidak disimpan; NIK didekripsi saat itu juga dan tidak masuk audit/log. Diuji bahwa teks PDF persis judul + template terender + catatan kaki.
6. **Scan bertanda tangan**: hanya saat PENANDATANGANAN, isi dienkripsi, SHA-256, verifikasi/tolak HRD dengan pemverifikasi ≠ pengunggah.
7. **Penempatan** (`placements`): DIRENCANAKAN → (setuju Mgr Ops, penyetuju ≠ pembuat) MENUNGGU_KONTRAK → AKTIF ↔ DITANGGUHKAN → SELESAI/DIPINDAHKAN, DIBATALKAN. **Exclusion constraint `btree_gist`**: satu orang tidak dapat memiliki dua penempatan non-final yang periodenya tumpang tindih.
8. **Status member otomatis** hanya lewat `MemberStatusService` (satu-satunya penulis status turunan): kontrak AKTIF + penempatan AKTIF → `KARYAWAN_AKTIF`; ≤ 30 hari berakhir tanpa kontrak lanjutan ditandatangani → `KONTRAK_AKAN_BERAKHIR`; tanpa kontrak aktif → `KONTRAK_BERAKHIR`; kembali ke `BELUM_DITEMPATKAN` hanya lewat verifikasi HRD (`member.review`). Memakai kunci baris profil yang sama dengan `canApply`. Lamaran aktif lain ditarik otomatis (riwayat bertanda "Otomatis:", aktor kosong, dijaga CHECK).
9. **Siklus hidup** (`ContractLifecycleService`): idempoten, satu transaksi per orang, jam disuntikkan (uji deterministik), urutan aktivasi → pengakhiran → sinkronisasi status; dijalankan worker interval (5 menit, mati saat `NODE_ENV=test`) dan dipicu setelah verifikasi scan, persetujuan/lanjutan penempatan, dan terminasi. Berjalan sebagai SISTEM dengan scope semua perusahaan (diturunkan server).
10. **Dashboard**: member (`/member/dashboard`, hanya data miliknya lewat RLS dan hanya status kontrak yang relevan) dan staf (`/employees`, `/employees/summary`, tanpa NIK/kontak). **Notifikasi** kontrak akan berakhir ke HRD perusahaan (dan HRD akses semua perusahaan) lewat outbox, tepat sekali per kontrak (`expiry_notified_at` dalam transaksi yang sama).

## Operasi
Worker siklus hidup berjalan di proses API (satu instance). Untuk beberapa instance, serialisasi antar proses dijaga kunci baris (`FOR UPDATE`) dan idempotensi; penguncian khusus worker belum ada. Tanpa SMTP, pengingat tetap menunggu di outbox.

## Konsekuensi dan keterbatasan
Template hukum resmi belum ada (sistem sengaja kosong; verifikasi ahli hukum di luar sistem); PSrE/tanda tangan elektronik belum (hanya tanda tangan basah + scan); `pdf-lib` tidak dirilis sejak 2022 (risiko pemeliharaan) dan `pako` berlisensi "MIT AND Zlib" (pengecualian lisensi diajukan ke pemilik); kualifikator sel matriks (mis. PayAbs "U(shift)") belum ditegakkan sehingga `placement.update` mencakup tangguh/selesai/batal/pindah; kontrak aktif tanpa penempatan aktif belum menjadikan karyawan (tidak diblokir melamar sampai penempatan aktif); PDF dibangkitkan sinkron; konkurensi dijaga guard status atomik tetapi tes serentak tidak membedakan kunci baris.
