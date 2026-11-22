# ADR-0011: Uji Keamanan, Uji Beban, Cadangan/Restore, dan Kesiapan Deployment

- Status: **Disetujui untuk diimplementasikan** (Fase 10); **menunggu persetujuan pemilik untuk dinyatakan selesai**. Tanggal: 2026-11-22.

## Konteks
Fase 10 adalah gerbang sebelum produksi: uji keamanan, uji beban, latihan restore, persiapan deployment, dan validasi asumsi A-01…A-05. Hosting belum dipilih pemilik; lingkungan pengembangan adalah satu VM tanpa daemon Docker.

## Keputusan
1. **Keamanan sebagai tes yang berjalan terus**: sapuan berbasis OpenAPI (`keamanan-sapuan.spec.ts`) menguji semua rute (tanpa sesi, lintas realm, CSRF/Origin, injeksi, body besar, header, pembatas laju). Temuan nyata diperbaiki di kode dengan tes regresi dan dibuktikan lewat uji mutasi (D-63…D-65). Tinjauan terdokumentasi di `docs/security-review.md`; **bukan** pengganti uji penetrasi independen (A-51).
2. **Pembatas laju per pengguna** untuk rute bersesi (guard kedua setelah `AuthGuard`), per IP untuk rute publik, plus pembatas cookie palsu (D-64). Alasan: pembatas per-IP memblokir seluruh pekerja satu NAT dan mengancam A-05.
3. **Uji beban jujur**: runner Node open-loop tanpa dependency baru + dataset sintetis besar; hasil dilaporkan beserta batas lingkungan. Tuning hanya atas bukti (migrasi 021); eksperimen yang tidak sepadan dicatat dan dibuang (D-66, D-67).
4. **Cadangan yang dapat dibuktikan**: snapshot konsisten + manifes + enkripsi + verifikasi otomatis + latihan nyata. RLS dipaksa berarti **role cadangan/restore khusus BYPASSRLS**; role aplikasi sengaja tidak mampu membuat cadangan (D-68).
5. **Kesiapan deployment tanpa memilih hosting**: konfigurasi produksi gagal-cepat, `/ready`, graceful shutdown (diverifikasi: permintaan berjalan selesai, koneksi baru ditolak, proses berhenti), `DB_POOL_MAX`, Dockerfile + berkas contoh + runbook (D-69, D-70).

## Konsekuensi dan keterbatasan
- Satu instans API; skala horizontal membutuhkan kunci worker dan pembatas bersama (A-52). Rotasi kunci enkripsi belum ada (A-53). Driver S3 belum ada; selfie mendorong ukuran penyimpanan (A-55). Image Docker belum pernah dibangun di sini.
- Overhead RLS pada agregat lebar ≈10–20× (A-12); isolasi tidak dikorbankan. Laporan/rekap besar perlu filter atau ringkasan terhitung (A-50, A-57).
- Angka beban berasal dari satu VM dan pembangkit yang berbagi CPU; wajib diukur ulang di staging.
- Pekerjaan yang memblokir produksi dan milik pemilik: `docs/ops/golive.md`.
