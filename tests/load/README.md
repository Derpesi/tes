# Uji Beban (k6) — kerangka

Status: **kerangka saja, belum dieksekusi**. Tidak ada hasil uji beban yang boleh diklaim dari berkas ini.

- `smoke-health.js`: skenario asap terhadap `/health`. Ambang `p95 < 1000 ms` dan `error < 1%` adalah asumsi A-04 (bukan SLA).
- `BASE_URL` wajib diisi; arahkan hanya ke **staging**, tidak pernah ke production.
- Tanpa data nyata: skenario berikutnya wajib memakai data sintetis (lihat `tests/helpers/data-sintetis.ts`).

## Skenario yang akan dibuat
| Skenario | Fase | Asumsi yang divalidasi |
|---|---|---|
| Puncak check-in absensi (10.000 pekerja dalam ±15 menit, burst ≈100 req/dtk) | 7 | A-04, A-05 |
| Daftar besar dengan keyset pagination (lowongan, lamaran, rekap) | 5, 8 | A-04 |
| Ekspor rekap via pekerjaan latar | 8 | A-04 |
| Latihan restore database dan bucket (RPO 24 jam, RTO 8 jam) | 10 | A-02 |
