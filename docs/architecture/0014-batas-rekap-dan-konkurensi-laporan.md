# ADR-0014: Batas Rentang Rekap dan Pembatas Konkurensi Laporan Berat

- Status: **Diimplementasikan** (Fase 11C; menunggu persetujuan pemilik). Tanggal: 2026-11-22.

## Konteks
Uji beban 10B: rekap absensi tanpa filter dan laporan konsolidasi bersifat O(jumlah rekaman pada rentang) (2,3–3,4 dtk/30 hari pada 10.000 pekerja), dan beban baca berat menumpuk antrean pada kolam 10 koneksi DB sehingga seluruh endpoint — termasuk scan absen — ikut antre.

## Keputusan
1. **Rentang rekap**: tanpa `locationId`/`personId` maksimal 7 hari; dengan filter 93 hari (`RekapQuery`, `RekapEksporQuery`). Ditegakkan di server; UI hanya membantu (pilih lokasi, tombol nonaktif untuk rentang lebar). Rekap payroll tidak terpengaruh (memakai `RecapService.ambil` langsung).
2. **Pembatas konkurensi** (`common/batas-konkurensi.ts`): semaphore dalam proses untuk rute berat; bawaan 2 bersamaan, antrean 20, tunggu 10 dtk; selebihnya 503 `SISTEM_SIBUK` + `Retry-After`. Guard otorisasi berjalan lebih dulu (permintaan tak berizin tidak mengantre). Dapat disetel `BATAS_LAPORAN_BERAT` (1–20).

## Konsekuensi dan batas
- Terukur: scan 40 req/dtk bersama 12 req/dtk baca berat: p95 88 ms (dengan pembatas) vs 38 dtk (tanpa). Pengguna yang meminta laporan berat bersamaan dapat menerima 503 dan harus mencoba lagi.
- Per proses (satu instans; A-52). Agregat terhitung/materialized view (A-50) tetap ditunda.
