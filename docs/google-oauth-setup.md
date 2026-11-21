# Panduan: Membuat OAuth Client Google untuk Login Member

Dikerjakan **oleh pemilik proyek** di Google Cloud Console. Nilai Client ID dan Client Secret **tidak boleh** masuk repo, chat, atau pesan commit. Isi hanya di berkas `.env` lokal atau secret manager server.

## 1. Proyek dan layar persetujuan
1. Buka Google Cloud Console, buat atau pilih proyek (mis. `DAMARINDO HRIS`).
2. Menu **APIs & Services → OAuth consent screen** (atau *Google Auth Platform → Branding*).
3. Jenis pengguna **External**. Isi nama aplikasi `DAMARINDO GROUP HRIS`, email dukungan, dan email kontak pengembang.
4. **Authorized domains**: domain produksi Anda (tanpa `https://`). Logo hanya boleh logo resmi perusahaan; jangan memakai logo pengganti.
5. **Scopes**: hanya `openid`, `email`, `profile` (bukan scope sensitif, tidak perlu verifikasi khusus).
6. Selama pengembangan biarkan status **Testing** dan tambahkan akun uji (maksimal 100). Ubah ke **In production** saat siap.

## 2. Kredensial OAuth
1. **Credentials → Create credentials → OAuth client ID → Web application**.
2. **Authorized redirect URIs** harus **persis** sama dengan:
   - Produksi/staging: `<APP_BASE_URL>/api/auth/member/google/callback` (mis. `https://hris.contoh.id/api/auth/member/google/callback`)
   - Pengembangan lokal: `http://localhost:3000/api/auth/member/google/callback`
3. *Authorized JavaScript origins* tidak diperlukan (alur kode di sisi server).
4. Buat **klien terpisah** untuk staging dan production; jangan berbagi Client Secret.

## 3. Isi `.env` (lokal, tidak di-commit)
```
APP_BASE_URL=http://localhost:3000
GOOGLE_CLIENT_ID=...        # dari Google Cloud Console
GOOGLE_CLIENT_SECRET=...    # dari Google Cloud Console
```
Kedua variabel harus diisi bersamaan atau dikosongkan bersamaan. Tanpa keduanya, `GET /auth/member/google/start` menjawab 503 dengan pesan Indonesia.

Prefiks `/api` dapat diubah lewat `API_PUBLIC_PATH` (mis. `/layanan`), asalkan reverse proxy atau rewrite web meneruskan jalur itu ke API dan redirect URI di Google ikut diubah.

Web meneruskan `/api/*` ke API lewat rewrite Next.js; atur `API_URL` (bawaan `http://localhost:3001`) saat **build** web bila API berjalan di alamat lain.

## 4. Cara menguji
1. Jalankan API dan web, buka `http://localhost:3000/api/auth/member/google/start`.
2. Pilih akun uji, setujui, dan pastikan Anda kembali ke aplikasi.
3. Cek `GET /api/auth/member/me` mengembalikan email Anda.

## 5. Keterbatasan dan catatan
- Cookie sesi memakai awalan `__Host-` sehingga wajib `Secure`. Chrome dan Firefox menerima cookie `Secure` pada `http://localhost`; **Safari belum diuji** dan mungkin memerlukan HTTPS lokal.
- Selama implementasi, jalur ini hanya teruji dengan IdP palsu lokal. **Login Google sungguhan belum pernah diuji** sampai Anda membuat klien di atas.
- Rotasi Client Secret: buat secret baru di Google Cloud Console, ganti di server, lalu hapus secret lama.
