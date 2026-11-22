-- Up Migration
-- Fase 10B: rekap absensi per lokasi (filter locationId) membaca seluruh rekaman perusahaan pada rentang tanggal lalu menyaring lokasi.
-- Pada dataset beban sintetis (10.000 pekerja, 1 juta rekaman) kueri rekap 30 hari berfilter lokasi turun dari ~290 ms ke ~26 ms dengan indeks ini.
-- IF NOT EXISTS: pada tabel produksi yang besar, indeks boleh dibuat lebih dulu di luar transaksi dengan CREATE INDEX CONCURRENTLY (lihat docs/ops/deploy.md).
CREATE INDEX IF NOT EXISTS attendance_records_lokasi_idx ON attendance_records (location_id, shift_date DESC);

-- Down Migration
DROP INDEX IF EXISTS attendance_records_lokasi_idx;
