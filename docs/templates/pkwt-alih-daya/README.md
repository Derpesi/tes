# Templat PKWT Alih Daya (dari draf pemilik, 2022)

Sumber: berkas "DRAFT PKWT ALIH DAYA PT. DM 2022" yang diberikan pemilik. **Teks klausul tidak diubah**; hanya data yang berubah per perusahaan/pekerja diganti variabel `{{...}}` (daftar putih di `apps/api/src/pkwt/variabel.ts`). Titik-titik tulis-tangan (hari/tanggal penandatanganan, agama, rincian upah, surat pernyataan) dipertahankan karena sistem tidak menyimpan/menghitungnya.

## Berkas
- `isi.txt` — isi templat generik (tanpa nama perusahaan/orang/nomor legalitas; dijaga tes).
- `pengaturan-damarindo-mandiri.json` — nilai pengaturan PKWT **PT. Damarindo Mandiri** yang diambil dari draf (penandatangan, kota, pengadilan negeri, 5 butir legalitas). **Verifikasi pemilik**: legalitas bertahun 2019–2022 dan dapat kedaluwarsa.

## Menyesuaikan untuk anak perusahaan (PT. OSI, PT. Pancormas Perkasa, dst.)
1. Master perusahaan (UI Perusahaan atau `PATCH /companies/:id`): isi **nama hukum** (`legalName`), alamat, kota, provinsi.
2. UI Perusahaan → **Pengaturan PKWT**: penandatangan, jabatan, kota, pengadilan negeri, dan **dasar legalitas** perusahaan itu (satu butir per baris). Yang dikosongkan dicetak sebagai titik-titik untuk diisi tangan.
3. Impor templat (operator): `IMPOR_DATABASE_URL=<role BYPASSRLS> node apps/api/dist/cli/impor-templat-pkwt.js --isi docs/templates/pkwt-alih-daya/isi.txt --oleh <userId staf>` (opsi `--perusahaan <id>`, `--kering`). Menghasilkan templat **BELUM_DIVERIFIKASI** per perusahaan aktif, idempoten. Alternatif: tempel `isi.txt` di UI Template PKWT.
4. Verifikasi templat oleh staf berwenang **yang bukan pembuat** (kontrol sistem). Sebelum itu setiap PDF bertanda "TEMPLATE BELUM DIVERIFIKASI — DRAF".

Data master PT. Damarindo Mandiri dari draf (isi lewat UI): nama hukum "PT. Damarindo Mandiri"; alamat "Jl. Raya Gatot Subroto KM. 5,4 Ruko Sastra Plasa Blok A No. 06, Jatiuwung"; kota "Kota Tangerang"; provinsi "Banten".

## Catatan untuk peninjau hukum (bukan keputusan sistem)
Draf memuat hal-hal yang sebaiknya ditinjau ahli sebelum diverifikasi: klausul denda/pinalti pada pekerja; pernyataan tidak berserikat dan tidak menuntut menjadi karyawan tetap; rujukan KUHP 322/323; tarif potongan BPJS tertulis di teks (tarif berubah menurut regulasi); legalitas perusahaan bertahun 2019–2022; **Pasal 3 hanya memuat "Mulai tanggal" tanpa tanggal berakhir** padahal sistem menyimpan tanggal akhir (variabel `{{tanggal_akhir}}` tersedia bila peninjau ingin menambahkannya); nomor kontrak mengikuti format sistem (`<prefiks>/<kode>/<tahun>/<urut>`), bukan `…/DM/PKWT/…/20…`.
