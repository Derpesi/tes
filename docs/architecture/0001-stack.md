# ADR-0001: Technology Stack

- Status: **Disetujui**
- Tanggal: 2026-11-20

## Konteks
HRIS outsourcing multi-perusahaan untuk Damarindo Group, dioperasikan dari perangkat Android, dengan data pribadi sensitif dan kebutuhan isolasi antar perusahaan. Repo awal kosong sehingga tidak ada stack warisan.

## Keputusan
- Frontend: Next.js + TypeScript (web mobile-first/PWA).
- Backend: NestJS + TypeScript, REST dengan dokumentasi OpenAPI.
- Database: PostgreSQL.
- Arsitektur: modular monolith (satu deployable, modul berbatas jelas), bukan microservices.
- Version control: GitHub. CI/CD: GitHub Actions.

## Alasan
Satu bahasa di seluruh stack; modul NestJS cocok untuk batas modul; PostgreSQL menyediakan transaksi, constraint, tipe NUMERIC, dan Row-Level Security untuk isolasi perusahaan.

## Konsekuensi
- Perlu disiplin batas modul agar monolith tetap modular.
- Pilihan teknis turunan (antrean, akses SQL, library) dibahas di ADR-0002 dan belum final.
- Alternatif yang dipertimbangkan: Laravel dan Django (tidak dipilih).
