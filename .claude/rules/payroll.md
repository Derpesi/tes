# Aturan Payroll
- Tahap awal hanya: periode, rekap absensi, komponen payroll, verifikasi, persetujuan rekap, ekspor (xlsx, CSV, PDF).
- Dilarang tanpa persetujuan fase berikutnya: hitung gaji final, PPh 21, BPJS, slip gaji, transfer/pembayaran otomatis.
- Nominal uang memakai NUMERIC/Decimal, tidak pernah float.
- Tarif dan aturan regulasi adalah data berversi dengan tanggal berlaku, bukan konstanta di kode, dan wajib diverifikasi ahli.
- Rekap yang sudah disetujui tidak boleh diubah diam-diam; perubahan lewat koreksi resmi bernomor versi.
- Pembuat, pemeriksa, penyetuju, dan finalisator harus orang berbeda; sistem yang menegakkan.
- Ekspor wajib melindungi dari CSV/formula injection dan wajib diaudit.
