# Aturan Isolasi Perusahaan
- Setiap tabel tenant wajib punya `company_id` NOT NULL dan kebijakan Row-Level Security.
- Scope (perusahaan + lokasi) diturunkan dari sesi di server, tidak pernah dari input klien.
- Dilarang mengandalkan filter frontend sebagai satu-satunya pemisah data.
- Setiap modul baru wajib disertai tes kebocoran lintas perusahaan (API, ID langsung, ekspor). Tes harus gagal bila RLS dimatikan.
- Menambah perusahaan baru harus lewat master data, bukan perubahan kode.
