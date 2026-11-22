# ADR-0012: Selfie Absensi Ditiadakan Sementara

- Status: **Diimplementasikan** (menunggu persetujuan pemilik). Tanggal: 2026-11-22. Mengubah sebagian ADR-0008.

## Konteks
Pemilik meminta selfie absensi ditiadakan dulu. Sebelumnya selfie wajib pada `POST /member/attendance` (tanpa selfie ditolak `SELFIE_WAJIB`) dan UI memaksa kamera. "Dulu" berarti sementara.

## Keputusan
1. **Saklar `ABSENSI_SELFIE` (`on`|`off`), bawaan `off`** (`config/env.ts`, `selfieAktif()`); nilai lain ditolak saat start.
2. **Saat off**: validasi `SELFIE_WAJIB/TERLALU_BESAR/TIDAK_VALID` dilewati; berkas `selfie` yang tetap terkirim **diabaikan** (tidak divalidasi, tidak disimpan, tanpa baris `attendance_selfies`, tanpa objek). Urutan penilaian lain tak berubah (radius, duplikat, perangkat, anomali). `GET /member/attendance/today` mengembalikan `selfieAktif` agar UI mengikuti server; halaman `/absen` tanpa bagian selfie dan tanpa `getUserMedia`; `Permissions-Policy` `/absen` menutup kamera (ditanam saat build web; `ARG ABSENSI_SELFIE` di Dockerfile).
3. **Dipertahankan** (tanpa migrasi): tabel `attendance_selfies`, izin `selfie.view`, endpoint lihat/legal hold (berizin + diaudit), worker retensi. Selfie lama tetap dapat dilihat sampai dihapus retensi.
4. **Mengaktifkan kembali**: set `ABSENSI_SELFIE=on` di API dan bangun ulang web dengan nilai sama; tinjau ulang retensi/PDP dan ukuran penyimpanan sebelum aktif.

## Konsekuensi dan risiko (dicatat jujur)
- **Risiko titip absen naik** (A-59): selfie bukan pengenalan wajah otomatis, tetapi memberi petugas bukti visual; tanpanya tinggal geofence, perangkat, skor anomali, dan tinjauan. Rekomendasi: pantau rasio `PERLU_VERIFIKASI` selama pilot.
- Tidak ada PII foto baru; penyimpanan objek tak lagi bertambah oleh selfie (A-55). Beban scan lebih ringan: 100 req/dtk p95 ≈ 20 ms tanpa selfie (≈ 40 ms dengan selfie) pada VM uji.
- Dua jalur uji dipertahankan: integrasi menguji off (bawaan) dan on; E2E mengikuti saklar (`ABSENSI_SELFIE=on` saat build+E2E untuk jalur selfie).
