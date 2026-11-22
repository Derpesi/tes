# Uji Beban dan Kinerja (Fase 10B)

> **Rotasi kunci enkripsi (Fase 11B):** 10.000 NIK + 24.770 objek (2,5 GB) dirotasi dalam 67 dtk tanpa jeda (scan p95 naik ke 7,7 dtk akibat I/O) atau 96 dtk dengan `--batas 100 --jeda-ms 100` (scan p95 20 ms, 0 galat). Rincian di `ops/rotasi-kunci.md`.
> **Pembaruan (ADR-0012): selfie ditiadakan sementara.** Angka di bawah dengan selfie ±100 KB diukur **sebelum** perubahan (jalur `ABSENSI_SELFIE=on`, runner `--selfie`). Ukuran ulang **tanpa selfie** (bawaan produk; 100 req/dtk, ramp 10 dtk + 60 dtk, 5.499 permintaan, 0 galat): p50 **13,5 ms**, p95 **20,1 ms**, p99 42,6 ms, maks 186 ms; tidak ada penyimpanan objek baru. Bagian 'penyimpanan selfie' dan A-55/A-03 tidak berlaku selama off.
**Cakupan klaim**: angka di bawah diukur pada **1 VM (4 vCPU, 16 GB RAM)**, PostgreSQL 16 dengan **konfigurasi bawaan** (`shared_buffers` 128 MB), API **satu proses Node** (`NODE_ENV=production`), **pembangkit beban berjalan di VM yang sama** (berebut CPU), data **sintetis**. Ini bukan staging/produksi: nilai absolut tidak boleh dijanjikan sebagai SLA; yang sahih adalah **perbandingan relatif**, titik busuk, dan pembuktian bahwa target tidak mustahil. Semua target A-0x tetap perlu divalidasi di staging nyata.

## Metode
- Dataset (`tests/load/seed-besar.mjs`, sintetis berlabel "SINTETIS", tanpa data pekerja nyata): 3 perusahaan, 50 rekanan/perusahaan, **500 lokasi/titik**, **10.000 pekerja** (member `KARYAWAN_AKTIF`, kontrak + penempatan `AKTIF`), **1.000.000 rekaman absensi** (50 hari × 2), 300.000 audit log, 10.020 sesi. Seed ±35 dtk (superuser, trigger dimatikan selama muat massal; hanya untuk DB `*_load`).
- Pembangkit (`tests/load/runner.mjs`, Node tanpa dependency; **k6 tidak terpasang** dan tidak ditambahkan sebagai dependency — `smoke-health.js` tetap kerangka k6 untuk staging): model **open-loop** (laju tetap, tidak menunggu respons) sehingga antrean server tampak sebagai latensi. Tiap scan memakai **pekerja berbeda**, sesi + CSRF + `Origin` sah, multipart dengan selfie JPEG sintetis ±100 KB, koordinat tepat di titik, idempotency key unik.
- Rute yang diuji sama dengan produksi (pipeline validasi penuh, RLS, tulis rekaman + flag + selfie terenkripsi ke disk, audit).

## Hasil
### Scan absensi (A-04, A-05)
| Skenario | Hasil |
|---|---|
| **100 req/dtk**, ramp 10 dtk lalu 60 dtk (5.499 permintaan) | p50 **17–18 ms**, p95 **39–42 ms**, p99 81–172 ms, maks 270–304 ms, **0 galat** (201 semua). Target A-04: p95 ≤ 1–2 dtk → **terpenuhi dengan selisih >40×** pada beban ini. Dua kali ukur (sebelum/sesudah migrasi 021): 42,2 → 38,7 ms; indeks baru tidak menambah latensi tulis yang terukur. |
| **A-05: 10.000 check-in dalam 15 menit** (11,2 req/dtk, 900 dtk, **bersamaan** dengan 1.799 pembacaan staf 2 req/dtk) | 10.079 permintaan, p50 **19,8 ms**, p95 **46,6 ms**, p99 76,4 ms, maks 343 ms, **0 galat**; 10.000 pekerja berbeda, rekaman di DB = jumlah respons 201 (tanpa kehilangan/duplikat). 79 permintaan lebih berasal dari pembulatan laju (pekerja 0–78 terulang → tercatat sebagai duplikat ditolak, bukan ganda). |
| Titik jenuh (target 250 req/dtk, 16 dtk) | Terealisasi ±195 req/dtk; p50 **2,6 dtk**, p95 4,0 dtk (antrean). Titik jenuh API satu proses berada **di antara 100 dan ±190 req/dtk** pada VM ini; tidak dicari lebih presisi. Profil CPU tidak diambil — penyebab (proses Node tunggal vs PostgreSQL vs pembangkit) **belum dipisahkan**. |

### Pembacaan staf pada dataset besar (satu per satu, hangat) dan di bawah beban 2 req/dtk
| Endpoint | Sendiri | Di bawah 2 req/dtk campuran (p50 / p95) |
|---|---|---|
| `GET /audit-logs?limit=50` | 7 ms | 7 / 16 ms |
| `GET /attendance/review?tahap=…` | 224 ms | 206 / 329 ms |
| `GET /dashboard/staff` (Direktur, semua widget) | 525 ms | 418 / 578 ms |
| `GET /reports/workforce` (30 hari) | 395 ms | 422 / 617 ms |
| `GET /attendance/recap` 30 hari, **tanpa filter lokasi** | 2,2 s | **2,3 / 2,8 s** |
| `GET /attendance/recap` 30 hari **per lokasi** | 292 ms → **26 ms** setelah migrasi 021 | — |
| `GET /reports/attendance` 30 hari (471 KB) | 3,5 s | **3,4 / 4,2 s** |
| `GET /reports/attendance/export.csv` 30 hari (sinkron) | 3,5 s | — |

**Temuan penting**: rekap tanpa filter dan laporan absensi bersifat **O(jumlah rekaman pada rentang)** (600 ribu baris/30 hari di sini). Pada percobaan awal **12 req/dtk campuran** pembacaan staf (tidak realistis untuk staf manusia) memenuhi kolam 10 koneksi DB: p50 **40–90 dtk** untuk semua endpoint, tetapi scan tetap di jalurnya sendiri pada skenario A-05 (2 req/dtk). Artinya: beban staf yang berat dapat **menumpuk antrean koneksi** dan mengganggu scan bila terjadi bersamaan secara masif. Mitigasi di bawah.

### Overhead RLS (validasi A-12)
Kueri sama pada role aplikasi (RLS aktif, scope perusahaan lewat `app.company_ids`) vs superuser dengan filter `company_id` eksplisit (tanpa RLS):
| Kueri | RLS aktif | Tanpa RLS |
|---|---|---|
| hitung rekaman 1 perusahaan, 30 hari (±200 ribu baris) | **220–440 ms** | **17–20 ms** (parallel index-only scan) |
| hitung per lokasi, 30 hari | 1,1–2,1 ms | 0,5–0,8 ms |
| 20 rekaman terakhir satu pekerja | 0,10–0,15 ms | 0,06 ms |

**Kesimpulan A-12**: untuk operasi titik/berindeks, overhead RLS **kecil (≈1–2 ms, sub-milidetik–ms)**; untuk **agregat lebar** overhead **≈10–20×** karena kebijakan RLS (`company_id = ANY(...) OR person_id = <member>`) mengandung `current_setting()` dan klausa `OR` pada kolom di luar indeks sehingga perencana tidak dapat memakai *index-only/parallel scan*. Isolasi **tidak dikorbankan** untuk kecepatan; opsi lanjutan (tidak dikerjakan): ringkasan terhitung (A-50), fungsi agregat `SECURITY DEFINER` dengan filter perusahaan eksplisit dan tes isolasi, atau memecah kebijakan.

## Tuning yang dilakukan
1. **Migrasi 021**: indeks `attendance_records (location_id, shift_date DESC)` — rekap per lokasi 292 → 26 ms (11×). Naik–turun–naik teruji. Tidak ada regresi latensi scan.
2. **Dicoba dan DITOLAK** (diukur): indeks cakupan `(company_id, shift_date) INCLUDE (…)` untuk laporan — hanya 829 → 619 ms (−25%) dengan +105 MB indeks; `work_mem=64MB` — 829 → 727 ms. Tidak sepadan.
3. **Ukuran kolam DB** kini dapat diatur `DB_POOL_MAX` (bawaan 10, 2–100).
4. Perbaikan 10A relevan kinerja: pembatas laju per pengguna (NAT kantor tidak saling memblokir); cookie palsu tidak lagi mengungkit DB.

## Status asumsi
| ID | Status | Bukti/catatan |
|---|---|---|
| **A-01** kapasitas 10.000 pekerja/500 lokasi | **Tervalidasi di lingkungan ini (fungsional + beban)**; perlu staging | Dataset penuh dimuat, dioperasikan, dicadangkan, dipulihkan. |
| **A-04** p95 ≤ 1–2 dtk @100 req/dtk | **Tervalidasi di lingkungan ini** (p95 ≈ 40 ms); perlu staging dengan jaringan 4G nyata (angka halaman mobile ≤ 3 dtk tidak diukur di sini) | Bukan SLA. |
| **A-05** 10.000 check-in/15 menit + burst ≈100 | **Tervalidasi di lingkungan ini** | 15 menit penuh, 0 galat. |
| **A-02** RPO 24 jam/RTO 8 jam | **Tervalidasi di lingkungan ini untuk skala data**; perlu infrastruktur nyata | `ops/restore.md`. |
| **A-12** overhead RLS | **Terukur**: kecil untuk titik, 10–20× untuk agregat lebar | di atas. |
| **A-40** partisi `attendance_records` | **Tetap ditunda**: 1 juta baris, kueri titik < 3 ms; belum ada bukti perlu. Tinjau ulang di ±10 juta baris. | |
| **A-44** ekspor sinkron | **Dipertahankan dengan batas**: laporan 30 hari ±3,5 s; rekap dibatasi 10.000 baris. Antrean latar bila ekspor lebih besar. | |
| **A-50** agregat tanpa materialized view | **Terbukti perlu ditinjau**: laporan absensi 30 hari 3,4 s, rekap tanpa filter 2,3 s. Cukup untuk penggunaan beberapa-staf; bukan untuk akses masif. | |
| **A-03** retensi selfie 90 hari | Tidak diukur; **pendorong biaya penyimpanan** (≈180–540 GB, `ops/restore.md`) | |

## Rekomendasi (tidak diubah tanpa persetujuan)
1. **UI**: wajibkan filter lokasi/rekanan atau rentang ≤ 7 hari pada rekap; tampilkan peringatan untuk laporan 30+ hari. (Pekerjaan UI/produk.)
2. **Isolasi beban**: pisahkan kolam koneksi untuk scan dan untuk pembacaan staf, atau batasi konkurensi laporan (mis. 2 bersamaan) agar laporan berat tidak menumpuk antrean koneksi.
3. **Skala**: bila perlu >100 req/dtk berkelanjutan, jalankan lebih dari satu instans API — butuh kunci worker terdistribusi dan pembatas laju bersama (`ops/deploy.md`), dan ukur ulang di staging.
4. **PostgreSQL**: setel `shared_buffers`, `work_mem`, `random_page_cost` sesuai hosting (`ops/monitoring.md`); ukur ulang.
5. **Agregat**: ringkasan harian per lokasi (tabel terhitung) bila laporan konsolidasi dipakai luas (A-50), dengan tes isolasi.
6. **Selfie**: tinjau retensi dan penyimpanan objek terkelola sebelum produksi.

## Cara mengulang
```
createdb hris_load && DATABASE_URL=…/hris_load pnpm db:migrate
SEED_DATABASE_URL=<superuser>/hris_load AUTH_HMAC_KEY=… pnpm load:seed          # menulis tests/load/.keluaran/sesi.json (token sintetis, diabaikan git)
# jalankan API terhadap hris_load (NODE_ENV=production), lalu:
BASE_URL=http://127.0.0.1:3001 APP_BASE_URL=<sama dengan API> AUTH_HMAC_KEY=<sama> \
  pnpm load:run --skenario scan --rps 100 --durasi 60 --ramp 10 --mulai 100
```
Setiap run `scan` memakai pekerja yang belum absen hari itu (`--mulai`); ulangi seed untuk run bersih. **Jangan arahkan ke production.**
