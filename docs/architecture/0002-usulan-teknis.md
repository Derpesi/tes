# ADR-0002: Usulan Pilihan Teknis Turunan

- Status: **Diusulkan** (belum disetujui; berisi asumsi A-06, A-07, A-10)

## Usulan
1. **Antrean latar:** PostgreSQL (pg-boss), tanpa Redis di tahap awal. Redis dievaluasi bila uji beban menunjukkan kebutuhan (rate limit lintas instance, dll).
2. **Akses SQL:** migrasi SQL-first (RLS, exclusion constraint, partisi memerlukan SQL mentah) dengan query builder (mis. Kysely), bukan ORM penuh.
3. **Library:** `openid-client` (Google OIDC), `otplib` (TOTP), argon2id (hash password), `exceljs` (xlsx), `pdfkit` atau `pdfmake` (PDF), `pino` (log), `@nestjs/swagger` (OpenAPI), pnpm workspace.
4. **Penyimpanan file:** object storage privat S3-kompatibel (MinIO untuk dev), URL bertanda tangan berumur pendek.
5. **Notifikasi:** antarmuka `NotificationChannel` + pola outbox; kanal email aktif, WhatsApp dan push hanya stub nonaktif.
6. **Kebijakan lisensi dependency:** izinkan MIT/Apache-2.0/BSD/ISC; larang GPL/AGPL/SSPL; hasilkan SBOM.

## Syarat sebelum disetujui
Cek lisensi tiap library, uji coba kecil untuk RLS dan partisi, dan persetujuan pemilik proyek.
