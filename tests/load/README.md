# Uji Beban — Fase 10B

Hasil, metode, dan keterbatasan: **`docs/performance.md`**. Berkas:
- `seed-besar.mjs` — dataset sintetis besar (10.000 pekerja, 500 lokasi, ≥1 juta rekaman). Menolak database yang namanya tidak berakhiran `_load`/`_beban`. Menulis `.keluaran/sesi.json` (token sesi sintetis; **diabaikan git**, jangan dibagikan).
- `runner.mjs` — pembangkit beban open-loop tanpa dependency (`scan`, `baca`, `ekspor`); menolak `BASE_URL` yang tampak production.
- `smoke-health.js` — kerangka k6 (belum dijalankan; k6 bukan dependency repo). Ambang A-04 adalah asumsi, bukan SLA.

Aturan: hanya **staging/lokal**, hanya **data sintetis**, tidak pernah production, tanpa kredensial nyata.
