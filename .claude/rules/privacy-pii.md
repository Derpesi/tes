# Aturan Data Pribadi (PII)
- NIK, foto/KTP, selfie, rekening, dan gaji adalah data sensitif: enkripsi saat disimpan, akses minimum, setiap akses sensitif diaudit.
- Selfie (**ditiadakan sementara**, `ABSENSI_SELFIE=off`; aturan ini berlaku bila diaktifkan): bucket privat, URL bertanda tangan berumur pendek, hanya petugas berwenang, tanpa face recognition otomatis, retensi dapat dikonfigurasi (usulan 90 hari) dengan pengecualian legal hold.
- Dilarang menaruh PII, token, atau rahasia di log, pesan error, URL, atau pesan commit.
- Data uji harus sintetis dan diberi label jelas; dilarang memakai data pekerja nyata.
- Kebijakan retensi final wajib ditinjau terhadap kebutuhan operasional dan UU Pelindungan Data Pribadi.
