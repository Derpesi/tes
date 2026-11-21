# ADR-0003: Mekanisme Isolasi Perusahaan (RLS)

- Status: **Diusulkan** (diuji lewat harness 2D; belum dipakai tabel bisnis)
- Tanggal: 2026-11-21

## Konteks
Data tiap perusahaan di Damarindo Group harus terpisah. Filter frontend tidak cukup. Dibutuhkan pertahanan terakhir di database.

## Usulan
- Scope perusahaan dikirim per transaksi: `set_config('app.company_ids', '<uuid>,<uuid>', true)` (berlaku lokal di transaksi), diturunkan dari sesi server, **bukan** dari input klien.
- `app_company_ids()` membaca setelan itu; kosong atau tidak diatur berarti tidak ada akses (deny-by-default).
- `enable_tenant_rls(tabel)` mengaktifkan `ENABLE` + `FORCE ROW LEVEL SECURITY` dan kebijakan `USING`/`WITH CHECK (company_id = ANY (app_company_ids()))`.
- Tabel tenant wajib berkolom `company_id uuid NOT NULL` dan memanggil `enable_tenant_rls` pada migrasinya.

## Syarat operasional
Aplikasi **wajib** terhubung memakai role non-superuser, non-owner tabel, tanpa `BYPASSRLS`. Superuser dan role `BYPASSRLS` mem-bypass RLS walau `FORCE` aktif. Role yang menjalankan migrasi harus berbeda dari role aplikasi.

## Bukti (harness 2D)
- Tes isolasi baca, ubah, hapus, sisip lintas perusahaan, dan tanpa scope: lolos sebagai role non-superuser, juga saat koneksi berstatus superuser (via `SET ROLE`).
- Meta-tes: bila RLS dimatikan, kebocoran terdeteksi di semua jalur.
- Tes registri: tabel `public` ber-`company_id` tanpa RLS terpaksa menggagalkan tes, kecuali ada pengecualian tertulis.

## Risiko dan hal terbuka
- Kinerja kebijakan `ANY(array)` pada tabel besar (mis. `attendance_records`) perlu diukur di uji beban.
- Penggunaan connection pool: `set_config` lokal transaksi mengharuskan setiap request berjalan dalam transaksi.
- Pengecualian sementara: `audit_logs` (kebijakan akses baca per perusahaan diputuskan di Fase 3).
- Probe tingkat API dan ekspor ditambahkan bersama modul pertama; harness 2D baru mencakup lapisan database.
