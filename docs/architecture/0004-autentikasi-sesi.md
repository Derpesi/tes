# ADR-0004: Autentikasi, Sesi, dan Otorisasi

- Status: **Disetujui** (diimplementasikan dan diuji pada Fase 3)
- Tanggal: 2026-11-21

## Konteks
Ada dua kelompok pengguna dengan kebutuhan berbeda: member/tenaga kerja (login Google) dan staff internal (kredensial khusus aplikasi + MFA). Data pribadi sensitif dan isolasi antar perusahaan menuntut otorisasi yang ditegakkan di backend.

## Keputusan
1. **Dua realm terpisah** (`member`, `staff`) di tabel yang sama dengan FK komposit `(user_id, realm)`: identitas Google hanya untuk member; kredensial, MFA, dan peran hanya untuk staff. Sesi, guard, dan endpoint memeriksa realm.
2. **Member:** Google OIDC (Authorization Code + PKCE S256, `state`, `nonce`, cookie pengikat, transaksi sekali pakai, verifikasi `iss/aud/exp/nonce` + tanda tangan JWKS, `email_verified` tegas). Kunci identitas = `sub`. Tidak ada penautan otomatis berdasarkan email (konflik masuk antrean tinjauan HRD).
3. **Staff:** undangan → kata sandi (argon2id) → TOTP wajib (+10 kode pemulihan). Login dua tahap dengan sesi tertunda; kunci akun 5×/15 menit tanpa enumerasi; TOTP anti pakai-ulang dua lapis.
4. **Sesi server-side** di PostgreSQL (hanya hash token), cookie `__Host-sid` (`HttpOnly`, `Secure`, `Path=/`, `SameSite=Lax`), rotasi saat naik tahap, batas idle/mutlak per realm. **Same-origin** web ↔ API lewat prefiks `/api` (rewrite Next.js/reverse proxy).
5. **CSRF:** `Origin` harus sama dengan `APP_BASE_URL` untuk semua method tulis + token CSRF terikat sesi (`X-CSRF-Token`) pada rute bersesi.
6. **Otorisasi:** guard global **deny-by-default**; permission granular `modul.aksi` dari matriks `docs/rbac.md`; izin dihitung dari database per permintaan; scope perusahaan dikirim ke database per transaksi (ADR-0003) sehingga RLS menegakkannya.
7. **Persetujuan ganda** untuk peran berhak tinggi, akses seluruh perusahaan, dan reset MFA; pemohon ≠ penyetuju (aplikasi + constraint database); tidak ada perubahan akses diri sendiri; pengecualian Direktur pertama untuk admin bootstrap.
8. **Bootstrap** admin awal lewat CLI operator (lihat `docs/bootstrap-admin.md`).

## Alasan
Pemisahan realm dan sesi server-side memungkinkan pencabutan seketika dan mengurangi permukaan serangan (tanpa JWT berumur panjang di klien). Deny-by-default dan izin per permintaan mencegah celah akibat lupa dekorator atau cache usang.

## Konsekuensi dan keterbatasan
- Setiap permintaan bersesi melakukan beberapa query (sesi, izin, scope); perlu dipantau pada uji beban (Fase 10).
- Pembatas laju di memori (satu instance); Redis menyusul bila perlu.
- Tidak ada OTP email; pemulihan MFA lewat admin dengan persetujuan ganda.
- Login Google sungguhan belum diuji (menunggu OAuth client pemilik).
- Matriks peran/permission tetap; belum ada UI edit peran.
- CSP web masih memakai `'unsafe-inline'` (Next.js tanpa nonce).
