# Runbook: Deploy

Status: **siap staging; belum pernah dideploy ke hosting mana pun**. Hosting, domain, TLS, dan penyedia PostgreSQL adalah keputusan pemilik (belum diambil). Berkas contoh ada di `deploy/` dan **bukan** konfigurasi final.

## Komponen
| Komponen | Image / berkas | Catatan |
|---|---|---|
| API (NestJS) | `apps/api/Dockerfile` | Non-root, `HEALTHCHECK` ke `/ready`, SIGTERM ditangani (graceful shutdown). **Satu instans** (lihat Batasan). |
| Web (Next.js) | `apps/web/Dockerfile` | `API_URL` ditanam saat **build** (rewrite `/api/*`); ganti alamat API = bangun ulang image. |
| Reverse proxy + TLS | `deploy/nginx.example.conf` | Contoh. Batas body 12 MB, HSTS, `/api/health` dan `/api/ready` tidak dipublikasikan. |
| PostgreSQL 16 | terkelola / mandiri | Role aplikasi **bukan superuser dan tanpa BYPASSRLS** (RLS ditegakkan). Role migrasi terpisah (pemilik skema). |
| Compose contoh | `deploy/docker-compose.prod.example.yml` | Variabel di `deploy/env.production.contoh` (isi di server; **jangan commit**). |

> Image **belum pernah dibangun** di lingkungan pengembangan ini (daemon Docker tidak tersedia). Verifikasi pengganti yang sudah dijalankan: `pnpm --filter @hris/api deploy --prod --legacy`, start dari `dist` dengan env produksi, tes konfigurasi produksi, uji SIGTERM. Bangun dan uji image di staging sebelum dipakai.

## Konfigurasi produksi (gagal-cepat)
Proses menolak start bila: `APP_BASE_URL` bukan `https://`, `STORAGE_DIR` kosong, `AUTH_HMAC_KEY` = `APP_ENCRYPTION_KEY`, kunci hampir seragam/lemah, `GOOGLE_ISSUER` diubah, atau variabel wajib hilang. Pesan tidak memuat nilai rahasia. `API_DOCS` bawaan **off** di produksi. `TRUST_PROXY` = jumlah proxy tepercaya (nginx contoh + Next = 2); salah isi membuat pembatas laju/IP keliru.

## Provisioning role database (sekali, oleh operator)
Migrasi **tidak** membuat role atau GRANT. RLS dipaksa (FORCE) sehingga pemilik tabel pun tunduk pada kebijakan; role aplikasi tidak perlu dan tidak boleh melewati RLS. Usulan (verifikasi di staging; tes integrasi memakai `GRANT ALL` pada role non-superuser tanpa BYPASSRLS):
```sql
-- sebagai superuser/admin; kata sandi dari secret manager, jangan ditulis di berkas
CREATE ROLE hris_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
GRANT CONNECT ON DATABASE <db> TO hris_app;
GRANT USAGE ON SCHEMA public TO hris_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO hris_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hris_app;
ALTER DEFAULT PRIVILEGES FOR ROLE <role-migrasi> IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hris_app;
ALTER DEFAULT PRIVILEGES FOR ROLE <role-migrasi> IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO hris_app;
```
Tabel `audit_logs` dilindungi trigger hanya-tambah (UPDATE/DELETE/TRUNCATE ditolak untuk semua role). Role cadangan/restore: lihat `restore.md`. Alternatif sederhana: aplikasi memakai role pemilik skema (tetap tunduk RLS) — kurang disarankan karena pemilik dapat mengubah skema.

## Urutan deploy
1. **Cadangan dulu** (`docs/ops/restore.md`): `node scripts/ops/backup.mjs`. Jangan lanjut tanpa cadangan yang checksum-nya tercatat.
2. Tarik image baru (tag tetap, bukan `latest`).
3. **Migrasi** (role pemilik skema): `docker compose run --rm migrasi`. Migrasi bersifat maju; kebijakan: *expand → deploy → contract* (kolom/tabel baru dulu, kode baru, baru hapus yang lama pada rilis berikutnya) agar rollback aplikasi tanpa rollback skema aman. Untuk tabel besar, buat indeks baru di luar transaksi lebih dulu: `CREATE INDEX CONCURRENTLY IF NOT EXISTS ...` (migrasi memakai `IF NOT EXISTS`).
4. Naikkan API: `docker compose up -d api`; tunggu `/ready` = 200 (`docker compose ps` menunjukkan *healthy*).
5. Naikkan web lalu proxy. Uji asap: halaman `/`, login staf, `GET /api/auth/session` tanpa sesi = 401.
6. Pantau log 15 menit (lihat `monitoring.md`).

## Rollback
- **Aplikasi**: pasang kembali tag image sebelumnya (`up -d api`). Aman bila migrasi mengikuti *expand/contract*.
- **Skema**: hanya bila terpaksa dan setelah cadangan: `node scripts/migrate.js down` (satu migrasi per perintah). Migrasi yang menghapus data tidak dapat dibalik tanpa restore.
- **Data rusak**: restore ke database baru (`restore.md`), verifikasi, lalu alihkan `DATABASE_URL`.

## Bootstrap administrator awal (sekali)
`docker compose run --rm -it api node dist/cli/bootstrap.js --email <email> --nama "<Nama>"` — wajib terminal interaktif (TTY); lihat `docs/bootstrap-admin.md`. Tidak ada kredensial/OTP bawaan.

## Setelah restore atau insiden: cabut semua sesi
`UPDATE sessions SET revoked_at = now(), revoked_reason = 'restore' WHERE revoked_at IS NULL;` (role pemilik). Semua pengguna login ulang.

## Batasan yang diketahui (jujur)
- **API satu instans**: worker latar (outbox email, masa berlaku kontrak, retensi selfie) belum memakai kunci terdistribusi; pembatas laju berada di memori per proses. Skala horizontal membutuhkan pekerjaan tambahan (kunci advisory untuk worker, penyimpanan pembatas bersama) — lihat `docs/performance.md`.
- **Driver penyimpanan objek lokal saja** (volume). Driver S3 belum ada; cadangan volume `objek` wajib (restore.md).
- **Rotasi kunci enkripsi belum ada** (`secrets.md`).
- Ekspor besar masih sinkron di request (A-44).
