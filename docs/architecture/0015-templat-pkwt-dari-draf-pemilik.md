# ADR-0015: Templat PKWT Alih Daya dari Draf Pemilik, Dapat Disesuaikan per Anak Perusahaan

- Status: **Diimplementasikan** (Fase 12; menunggu persetujuan pemilik). Tanggal: 2026-11-22.

## Konteks
Pemilik menyerahkan "DRAFT PKWT ALIH DAYA PT. DM 2022" dan meminta dipakai sebagai templat awal yang dapat disesuaikan untuk PT. OSI, PT. Pancormas Perkasa, dan anak perusahaan lain. Aturan keras: sistem tidak membawa/mengarang teks hukum; templat hanya "terverifikasi" setelah ditinjau staf berwenang (bukan pembuat); tombol setuju bukan tanda tangan sah.

## Keputusan
1. **Teks dari pemilik, bukan dari kode**: `docs/templates/pkwt-alih-daya/isi.txt` memuat klausul draf **tanpa perubahan** (diverifikasi program: semua paragraf yang tidak berisi data identik dengan draf). Hanya identitas perusahaan, data pekerja, dan penempatan diganti variabel. Tes menjaga templat tetap **generik** (tanpa nama perusahaan/orang/nomor legalitas).
2. **Variabel** (daftar putih): inti wajib (`nama, nik, nomor, jabatan, tanggal_*, perusahaan`) dan variabel data master/penempatan (`perusahaan_hukum(_kapital), perusahaan_alamat, perusahaan_legalitas, penandatangan_*, kota_penandatanganan, pengadilan_negeri, tempat/tanggal_lahir, pendidikan, alamat_pekerja, kontak_pekerja, pengguna_jasa, alamat_pengguna_jasa, jenis_pekerjaan`). Yang kosong dicetak **titik-titik** (isian tangan), dilaporkan di audit hanya sebagai nama variabel. Agama tidak disimpan sistem: tetap titik-titik di dokumen.
3. **Per anak perusahaan** lewat master data: `legal_name`, alamat, kota, provinsi dan `document_settings.pkwt` (penandatangan, jabatan, kota, pengadilan negeri, legalitas) — UI Perusahaan; perusahaan baru tanpa ubah kode. Pengaturan satu perusahaan tidak bocor ke perusahaan lain (RLS; diuji).
4. **Alat impor** (`impor-templat-pkwt`, role BYPASSRLS): membuat templat BELUM_DIVERIFIKASI per perusahaan aktif secara idempoten, tidak pernah memverifikasi, tidak menimpa pengaturan yang sudah disunting pemilik. PDF tetap bertanda "TEMPLATE BELUM DIVERIFIKASI — DRAF" sampai diverifikasi.

## Konsekuensi dan batas
- **Peninjauan hukum wajib** sebelum verifikasi (A-63): denda/pinalti pekerja, pernyataan tidak berserikat/tidak menuntut tetap, tarif BPJS di teks, legalitas bertahun 2019–2022, tidak ada tanggal berakhir di Pasal 3. Sistem tidak mengubah klausul.
- Penyuntingan pengaturan PKWT oleh IT Administrator (izin `company.update`); izin khusus untuk HRD adalah keputusan pemilik (A-64).
- PDF berupa teks polos (tanpa format tebal/tab); tata letak tanda tangan berupa teks. Format cetak yang lebih rapi atau PSrE adalah pekerjaan lanjutan.
