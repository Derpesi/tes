# Runbook: Pemantauan, Log, dan Peringatan Minimal

> **Fase 11C:** respons **503 `SISTEM_SIBUK`** (dengan `Retry-After`) pada `/reports/*` dan `/attendance/recap*` berarti pembatas konkurensi laporan berat penuh (`BATAS_LAPORAN_BERAT`, bawaan 2). Lonjakan terus-menerus = pengguna meminta laporan berat bersamaan atau rentang terlalu lebar; periksa penggunaan, jangan langsung menaikkan batas (kolam DB `DB_POOL_MAX` dibagi dengan scan absen).
Belum ada platform pemantauan terpilih (keputusan pemilik). Berikut kebutuhan **minimum** agar staging/produksi dapat dioperasikan.

## Sinyal kesehatan
| Sinyal | Sumber | Ambang usulan |
|---|---|---|
| Liveness | `GET /health` (200 + database ok) | gagal 3× berturut-turut → restart + peringatan |
| Readiness | `GET /ready` (DB + migrasi + tidak sedang berhenti) | gagal → keluarkan dari load balancer |
| Latensi scan absen | log permintaan (`responseTime`) POST `/member/attendance` | p95 > 2 dtk (A-04) selama 5 menit → peringatan |
| Galat 5xx | log permintaan | > 1% selama 5 menit → peringatan |
| 429 beruntun | log | lonjakan → kemungkinan penyalahgunaan atau `TRUST_PROXY` salah |
| Koneksi DB | `pg_stat_activity` | > 80% `max_connections` |
| Disk (DB, volume objek) | OS | > 80% |
| Cadangan | hasil `backup.mjs` terakhir | tidak ada cadangan berhasil > 26 jam (RPO 24 jam, A-02) |
| Antrean outbox | tabel `notification_outbox` status tertunda | umur tertua > 15 menit |

## Log
- JSON (pino) ke stdout; kumpulkan dengan pengumpul log milik platform. Level produksi `info`: satu baris per permintaan berisi id, metode, **URL tanpa query string**, status, dan waktu respons. Header dan body **tidak** dicatat; `authorization`, `cookie`, dan `set-cookie` di-redact (diuji `src/common/log.spec.ts`). Jangan menaikkan level ke debug di produksi.
- Audit log (tabel `audit_logs`, hanya-tambah) adalah catatan bisnis; bukan pengganti log aplikasi.

## Tuning PostgreSQL awal (ukur ulang di staging)
Hasil uji beban memakai bawaan PostgreSQL pada 1 VM. Titik awal untuk server 16 GB: `shared_buffers=4GB`, `effective_cache_size=12GB`, `work_mem=32MB` (hati-hati × koneksi), `max_connections` ≥ `DB_POOL_MAX` × jumlah instans + cadangan, `random_page_cost=1.1` bila SSD. Nilai ini **usulan**, bukan hasil ukur.
