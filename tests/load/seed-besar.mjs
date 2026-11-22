#!/usr/bin/env node
// Seed dataset besar SINTETIS untuk uji beban (Fase 10B). Semua data berlabel "SINTETIS"; tanpa data pekerja nyata.
// Pakai: SEED_DATABASE_URL=<superuser, DB khusus *_load yang sudah dimigrasi> AUTH_HMAC_KEY=... node tests/load/seed-besar.mjs
//   Opsi env: N_PEKERJA (10000), N_LOKASI (500), N_PERUSAHAAN (3), HARI_RIWAYAT (50), N_AUDIT (300000), KELUARAN (tests/load/.keluaran/sesi.json)
// Superuser dipakai agar trigger/FK dapat dinonaktifkan selama muat massal (session_replication_role = replica).
// Berkas keluaran memuat token sesi sintetis sementara (diabaikan git); jangan dibagikan.
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import pg from 'pg';

const url = process.env.SEED_DATABASE_URL;
if (!url) throw new Error('SEED_DATABASE_URL wajib diisi');
const dbName = new URL(url).pathname.slice(1);
if (!/_(load|beban)$/.test(dbName)) throw new Error(`Menolak: nama database "${dbName}" harus berakhiran _load atau _beban`);

const N = Number(process.env.N_PEKERJA ?? 10000);
const LOK = Number(process.env.N_LOKASI ?? 500);
const PER = Number(process.env.N_PERUSAHAAN ?? 3);
const HARI = Number(process.env.HARI_RIWAYAT ?? 50);
const N_AUDIT = Number(process.env.N_AUDIT ?? 300000);
const KELUAR = process.env.KELUARAN ?? 'tests/load/.keluaran/sesi.json';
const sha256 = (s) => createHash('sha256').update(s).digest();

const c = new pg.Client({ connectionString: url });
await c.connect();
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const q = (s, p) => c.query(s, p);

await q(`SET session_replication_role = replica`);
const sudah = (await q(`SELECT count(*)::int n FROM companies WHERE name LIKE 'PT SINTETIS BEBAN%'`)).rows[0].n;
if (sudah) throw new Error('Dataset beban sudah ada di database ini; buat ulang database *_load.');

await q(`INSERT INTO companies (name) SELECT 'PT SINTETIS BEBAN ' || g FROM generate_series(1, $1) g`, [PER]);
await q(`CREATE TEMP TABLE co AS SELECT id, row_number() OVER (ORDER BY name) AS no FROM companies WHERE name LIKE 'PT SINTETIS BEBAN%'`);

// Staf pembuat + staf pembaca (Direktur, semua perusahaan seed)
const staf = [];
for (let i = 0; i < 20; i++) {
  const p = (await q(`INSERT INTO persons (display_name) VALUES ('SINTETIS Staf Beban') RETURNING id`)).rows[0].id;
  const u = (await q(`INSERT INTO users (person_id, realm, email, status) VALUES ($1, 'staff', $2, 'AKTIF') RETURNING id`, [p, `staf-beban-${i}@contoh.invalid`])).rows[0].id;
  await q(`INSERT INTO user_roles (user_id, role_code, grant_source) VALUES ($1, 'DIREKTUR', 'MANUAL')`, [u]);
  await q(`INSERT INTO user_company_scopes (user_id, scope_company_id) SELECT $1, id FROM co`, [u]);
  staf.push(u);
}
const pembuat = staf[0];
await q(`CREATE TEMP TABLE pembuat AS SELECT $1::uuid AS id`, [pembuat]);
log(`perusahaan=${PER}, staf=${staf.length}`);

// Rekanan, lokasi, titik absensi (sekitar Bandung; koordinat sintetis)
await q(`INSERT INTO partners (company_id, name, created_by)
         SELECT co.id, 'SINTETIS Rekanan ' || g, (SELECT id FROM pembuat) FROM co, generate_series(1, 50) g`);
await q(`CREATE TEMP TABLE lok AS
         SELECT gen_random_uuid() AS id, c.id AS company_id,
                (SELECT p.id FROM partners p WHERE p.company_id = c.id ORDER BY p.name LIMIT 1) AS partner_id, g AS no
         FROM generate_series(1, $1) g JOIN co c ON c.no = ((g - 1) % $2) + 1`, [LOK, PER]);
await q(`INSERT INTO partner_locations (id, company_id, partner_id, name, latitude, longitude, geofence_radius_m, created_by)
         SELECT id, company_id, partner_id, 'SINTETIS Lokasi ' || no, -6.9 + (no % 50) * 0.001, 107.6 + (no % 40) * 0.001, 100, (SELECT id FROM pembuat) FROM lok`);
await q(`INSERT INTO attendance_points (company_id, location_id, created_by) SELECT company_id, id, (SELECT id FROM pembuat) FROM lok`);
log(`lokasi=${LOK}`);

// Pekerja: person, user member, profil KARYAWAN_AKTIF, lamaran, kontrak AKTIF, penempatan AKTIF
await q(`CREATE TEMP TABLE pk AS
  SELECT g AS no, gen_random_uuid() AS person_id, gen_random_uuid() AS user_id, gen_random_uuid() AS profile_id,
         gen_random_uuid() AS app_id, gen_random_uuid() AS contract_id, gen_random_uuid() AS placement_id,
         l.company_id, l.id AS location_id
  FROM generate_series(1, $1) g JOIN lok l ON l.no = ((g - 1) % $2) + 1`, [N, LOK]);
await q(`CREATE TEMP TABLE pk_lok AS SELECT no, location_id FROM pk`);
await q(`INSERT INTO persons (id, display_name) SELECT person_id, 'SINTETIS Pekerja ' || no FROM pk`);
await q(`INSERT INTO users (id, person_id, realm, email, status) SELECT user_id, person_id, 'member', 'pekerja-' || no || '@contoh.invalid', 'AKTIF' FROM pk`);
await q(`INSERT INTO member_profiles (id, person_id, status, full_name, nik_enc, nik_hmac, birth_place, birth_date, gender, address, city, province, phone, education, emergency_contact_name, emergency_contact_phone, verified_by, verified_at)
         SELECT profile_id, person_id, 'KARYAWAN_AKTIF', 'SINTETIS Pekerja ' || no, gen_random_bytes(40), decode(md5(no::text) || md5(no::text || 'x'), 'hex'), 'Kota', date '1990-01-01', 'L', 'Alamat sintetis', 'Bandung', 'Jawa Barat', '08123456', 'SMA/SMK', 'Kontak', '08123457', (SELECT id FROM pembuat), now() FROM pk`);
await q(`INSERT INTO job_vacancies (company_id, title, description, created_by) SELECT id, 'SINTETIS Lowongan', 'Sintetis', (SELECT id FROM pembuat) FROM co`);
await q(`INSERT INTO contract_templates (company_id, name, version, body, status, verified_by, verified_at, verification_note, created_by)
         SELECT id, 'SINTETIS Templat', 1, 'CONTOH UJI BEBAN', 'TERVERIFIKASI', $1, now(), 'sintetis', (SELECT id FROM pembuat) FROM co`, [staf[1]]);
await q(`INSERT INTO job_applications (id, company_id, vacancy_id, person_id, status)
         SELECT pk.app_id, pk.company_id, (SELECT id FROM job_vacancies v WHERE v.company_id = pk.company_id LIMIT 1), pk.person_id, 'MENUNGGU_PKWT' FROM pk`);
await q(`INSERT INTO employment_contracts (id, company_id, application_id, person_id, template_id, contract_number, position, start_date, end_date, status, reviewed_by, reviewed_at, approved_by, approved_at, activated_at, created_by)
         SELECT pk.contract_id, pk.company_id, pk.app_id, pk.person_id, (SELECT id FROM contract_templates t WHERE t.company_id = pk.company_id LIMIT 1),
                'PKWT/SINTETIS/' || pk.no, 'Satpam', current_date - 200, current_date + 400, 'AKTIF', $1, now(), $2, now(), now(), (SELECT id FROM pembuat) FROM pk`, [staf[1], staf[2]]);
await q(`INSERT INTO placements (id, company_id, person_id, contract_id, location_id, start_date, status, approved_by, approved_at, created_by)
         SELECT pk.placement_id, pk.company_id, pk.person_id, pk.contract_id, pl.location_id, current_date - 200, 'AKTIF', $1, now(), (SELECT id FROM pembuat) FROM pk JOIN pk_lok pl ON pl.no = pk.no`, [staf[2]]);
log(`pekerja=${N}`);

// Riwayat absensi: HARI hari x 2 rekaman/pekerja (kemarin ke belakang; hari ini dibiarkan kosong untuk uji scan)
await q(`INSERT INTO attendance_records (company_id, person_id, placement_id, point_id, location_id, kind, status, shift_date, occurred_at, latitude, longitude, accuracy_m, distance_m, anomaly_score, idempotency_key)
  SELECT pk.company_id, pk.person_id, pk.placement_id, t.id, pl.location_id, k.kind,
         CASE WHEN (pk.no + d.d) % 97 = 0 THEN 'PERLU_VERIFIKASI' ELSE 'VALID' END,
         current_date - d.d,
         ((current_date - d.d)::timestamp + CASE k.kind WHEN 'MASUK' THEN interval '7 hours' ELSE interval '15 hours' END) AT TIME ZONE 'Asia/Jakarta',
         -6.9, 107.6, 12.0, 10.0, CASE WHEN (pk.no + d.d) % 97 = 0 THEN 30 ELSE 0 END,
         'seed-' || pk.no || '-' || d.d || '-' || k.kind
  FROM pk JOIN pk_lok pl ON pl.no = pk.no
  JOIN attendance_points t ON t.location_id = pl.location_id
  CROSS JOIN generate_series(1, $1) d(d) CROSS JOIN (VALUES ('MASUK'), ('PULANG')) k(kind)`, [HARI]);
log(`rekaman absensi=${(await q(`SELECT count(*)::int n FROM attendance_records`)).rows[0].n}`);

// Audit sintetis (kategori operasional/transaksi/teknis)
await q(`INSERT INTO audit_logs (occurred_at, action, actor_id, company_id, object_type, object_id, detail)
  SELECT now() - (g % 90) * interval '1 day' - (g % 86400) * interval '1 second',
         (ARRAY['master.partner.update','attendance.review','payroll.recap.verify','auth.login','report.export','recruitment.application.decide'])[1 + g % 6],
         $1, (SELECT id FROM co WHERE no = (g % $3) + 1), 'sintetis', g::text, jsonb_build_object('sintetis', true, 'n', g)
  FROM generate_series(1, $2) g`, [pembuat, N_AUDIT, PER]);
log(`audit=${N_AUDIT}`);
await q(`SET session_replication_role = DEFAULT`);

// Sesi: member (semua pekerja) + staf
const tokenAcak = () => randomBytes(32).toString('base64url');
const member = (await q(`SELECT pk.user_id, pk.person_id, pk.no, t.public_code, l.latitude::float8 AS lat, l.longitude::float8 AS lng FROM pk JOIN attendance_points t ON t.location_id = pk.location_id JOIN partner_locations l ON l.id = pk.location_id ORDER BY pk.no`)).rows;
const daftar = member.map((m) => ({ ...m, token: tokenAcak() }));
const BATCH = 2000;
const sisip = async (baris, realm) => {
  for (let i = 0; i < baris.length; i += BATCH) {
    const bagian = baris.slice(i, i + BATCH);
    const ph = bagian.map((_, j) => `($${j * 3 + 1}, '${realm}', $${j * 3 + 2}, 'PENUH', now() + interval '1 day', $${j * 3 + 3})`).join(',');
    await q(`INSERT INTO sessions (user_id, realm, token_hash, state, expires_at, user_agent) VALUES ${ph}`, bagian.flatMap((b) => [b.user_id ?? b.id, sha256(b.token), 'uji-beban']));
  }
};
await sisip(daftar, 'member');
const stafSesi = staf.map((id) => ({ id, token: tokenAcak() }));
await sisip(stafSesi, 'staff');
const idSesi = (await q(`SELECT s.id, s.token_hash FROM sessions s WHERE s.user_agent = 'uji-beban'`)).rows;
const peta = new Map(idSesi.map((r) => [r.token_hash.toString('hex'), r.id]));
mkdirSync(dirname(KELUAR), { recursive: true });
writeFileSync(KELUAR, JSON.stringify({
  dibuat: new Date().toISOString(),
  member: daftar.map((m) => ({ no: m.no, token: m.token, sesiId: peta.get(sha256(m.token).toString('hex')), kode: m.public_code, lat: m.lat, lng: m.lng })),
  staf: stafSesi.map((s) => ({ token: s.token, sesiId: peta.get(sha256(s.token).toString('hex')) })),
}), { mode: 0o600 });
log(`sesi member=${daftar.length}, staf=${stafSesi.length} -> ${KELUAR}`);
await q(`ANALYZE`);
log('selesai');
await c.end();
