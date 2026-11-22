# Runbook: Respons Insiden

| Situasi | Tindakan segera | Kemudian |
|---|---|---|
| Dugaan akun staf diambil alih | Nonaktifkan pengguna (menu pengguna) + `cabutSemuaUser` oleh IT Admin; reset password + MFA | Tinjau audit log aktor tsb; cari perubahan peran/akses |
| Rahasia bocor | `secrets.md` bagian "Bila rahasia diduga bocor" | Rotasi + tinjau akses |
| Selfie/NIK terakses tak wajar | Pembekuan akses petugas terkait; ekspor audit `attendance.selfie.viewed`/akses data sensitif | Laporan ke Direktur; pertimbangkan kewajiban UU PDP (hukum) |
| Database rusak/terhapus | Hentikan API; restore ke DB baru (`restore.md`); cabut semua sesi | Analisis penyebab; evaluasi RPO aktual |
| Lonjakan lalu lintas/penyalahgunaan | Periksa 429/5xx; perketat batas di proxy; periksa `TRUST_PROXY` | Tinjau IP/pengguna sumber |
| Rilis bermasalah | Rollback image (`deploy.md`) | Perbaikan + tes regresi |

Semua insiden dicatat (waktu, dampak, tindakan, akar masalah). Tidak ada akun "darurat" permanen; akses darurat lewat prosedur break-glass di `docs/bootstrap-admin.md` (teraudit).
