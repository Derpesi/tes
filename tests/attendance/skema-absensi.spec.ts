import { randomBytes, randomUUID } from 'node:crypto';
import { Pool, PoolClient } from 'pg';
import { COMPANY_SINTETIS } from '../helpers/data-sintetis';
import { ROLE_UJI, bukaPool, dalamScope, migrasiNaik, siapkanRoleUji } from '../helpers/db';
import { cekKebocoran, KonfigKebocoran } from '../helpers/kebocoran';

const ada = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const A = COMPANY_SINTETIS.A;
const B = COMPANY_SINTETIS.B;
const unik = () => randomBytes(5).toString('hex');
const hash = () => randomBytes(32).toString('hex');

async function harusGagal(c: PoolClient, sql: string, params: unknown[], pola: RegExp) {
  await c.query('SAVEPOINT uji');
  try {
    await c.query(sql, params);
  } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT uji');
    expect((e as Error).message).toMatch(pola);
    return;
  }
  throw new Error(`Seharusnya gagal tetapi berhasil: ${sql}`);
}

interface Dasar { person: string; lokasi: string; placement: string; titik: string; shift: string; rekaman: string }

ada('Absensi: invarian skema, pelindung database, dan isolasi RLS', () => {
  let pool: Pool;
  let u1: string;
  let u2: string;
  let u3: string;
  const d: { A: Dasar; B: Dasar } = { A: {} as Dasar, B: {} as Dasar };

  const buatUser = async () => {
    const p = (await pool.query(`INSERT INTO persons (display_name) VALUES ('SINTETIS Staff') RETURNING id`)).rows[0].id;
    return (await pool.query(`INSERT INTO users (person_id, realm, email, status) VALUES ($1, 'staff', $2, 'AKTIF') RETURNING id`, [p, `abs-${unik()}@contoh.invalid`])).rows[0].id as string;
  };

  const SQL_REKAMAN = `INSERT INTO attendance_records (company_id, person_id, placement_id, point_id, location_id, kind, status, reject_reason, shift_date, idempotency_key)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`;
  const rekaman = (c: PoolClient, x: Dasar, company: string, o: { kind?: string; status?: string; alasan?: string | null; tanggal?: string; kunci?: string } = {}) =>
    c.query(`${SQL_REKAMAN} RETURNING id`, [company, x.person, x.placement, x.titik, x.lokasi, o.kind ?? 'MASUK', o.status ?? 'VALID', o.alasan ?? null, o.tanggal ?? '2026-03-10', o.kunci ?? `kunci-${unik()}`]);

  const siapkan = async (company: string): Promise<Dasar> =>
    dalamScope(pool, [company], async (c) => {
      const v = (await c.query(`INSERT INTO job_vacancies (company_id, title, description, created_by) VALUES ($1, 'L', 'D', $2) RETURNING id`, [company, u1])).rows[0].id;
      const person = (await pool.query(`INSERT INTO persons (display_name) VALUES ('SINTETIS Pekerja') RETURNING id`)).rows[0].id as string;
      const lamaran = (await c.query(`INSERT INTO job_applications (company_id, vacancy_id, person_id, status) VALUES ($1, $2, $3, 'MENUNGGU_PKWT') RETURNING id`, [company, v, person])).rows[0].id;
      const tpl = (await c.query(`INSERT INTO contract_templates (company_id, name, version, body, created_by) VALUES ($1, $2, 1, 'CONTOH UJI', $3) RETURNING id`, [company, `Tpl ${unik()}`, u1])).rows[0].id;
      await c.query(`UPDATE contract_templates SET status = 'TERVERIFIKASI', verified_by = $2, verified_at = now(), verification_note = 'uji' WHERE id = $1`, [tpl, u2]);
      const k = (await c.query(`INSERT INTO employment_contracts (company_id, application_id, person_id, template_id, contract_number, position, start_date, end_date, created_by) VALUES ($1, $2, $3, $4, $5, 'Satpam', '2026-01-01', '2026-12-31', $6) RETURNING id`, [company, lamaran, person, tpl, `PKWT/${unik()}`, u1])).rows[0].id;
      await c.query(`UPDATE employment_contracts SET status = 'PERSETUJUAN', reviewed_by = $2, reviewed_at = now() WHERE id = $1`, [k, u2]);
      await c.query(`UPDATE employment_contracts SET status = 'PENANDATANGANAN', approved_by = $2, approved_at = now() WHERE id = $1`, [k, u3]);
      await c.query(`INSERT INTO contract_documents (company_id, contract_id, version_no, object_key, original_filename, mime_type, size_bytes, sha256, status, uploaded_by, verified_by, verified_at) VALUES ($1, $2, 1, $3, 's.pdf', 'application/pdf', 10, decode($4, 'hex'), 'TERVERIFIKASI', $5, $6, now())`, [company, k, `${company}/${randomUUID()}`, hash(), u1, u2]);
      await c.query(`UPDATE employment_contracts SET status = 'DITANDATANGANI' WHERE id = $1`, [k]);
      await c.query(`UPDATE employment_contracts SET status = 'AKTIF', activated_at = now() WHERE id = $1`, [k]);
      const pr = (await c.query(`INSERT INTO partners (company_id, name, created_by) VALUES ($1, $2, $3) RETURNING id`, [company, `Rek ${unik()}`, u1])).rows[0].id;
      const lokasi = (await c.query(`INSERT INTO partner_locations (company_id, partner_id, name, created_by) VALUES ($1, $2, 'Lok', $3) RETURNING id`, [company, pr, u1])).rows[0].id;
      const placement = (await c.query(`INSERT INTO placements (company_id, person_id, contract_id, location_id, start_date, status, approved_by, approved_at, created_by) VALUES ($1, $2, $3, $4, '2026-01-01', 'AKTIF', $5, now(), $6) RETURNING id`, [company, person, k, lokasi, u3, u1])).rows[0].id;
      const titik = (await c.query(`INSERT INTO attendance_points (company_id, location_id, created_by) VALUES ($1, $2, $3) RETURNING id`, [company, lokasi, u1])).rows[0].id;
      const shift = (await c.query(`INSERT INTO shift_patterns (company_id, name, start_time, end_time, crosses_midnight, created_by) VALUES ($1, $2, '22:00', '06:00', true, $3) RETURNING id`, [company, `Malam ${unik()}`, u1])).rows[0].id;
      const x = { person, lokasi, placement, titik, shift, rekaman: '' };
      x.rekaman = (await rekaman(c, x, company, { tanggal: '2026-03-01' })).rows[0].id;
      return x;
    }, { commit: true });

  beforeAll(async () => {
    migrasiNaik();
    pool = bukaPool();
    await siapkanRoleUji(pool);
    await pool.query(`GRANT ALL ON ALL TABLES IN SCHEMA public TO ${ROLE_UJI}`);
    for (const [id, nama] of [[A, 'PT SINTETIS A'], [B, 'PT SINTETIS B']]) await pool.query(`INSERT INTO companies (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [id, nama]);
    u1 = await buatUser();
    u2 = await buatUser();
    u3 = await buatUser();
    d.A = await siapkan(A);
    d.B = await siapkan(B);
  });
  afterAll(async () => {
    await pool.end();
  });
  const tx = (fn: (c: PoolClient) => Promise<void>) => dalamScope(pool, [A, B], async (c) => fn(c));

  describe('titik, shift, jadwal, libur', () => {
    it('satu titik aktif per lokasi; kode publik unik; titik nonaktif boleh banyak', () =>
      tx(async (c) => {
        await harusGagal(c, `INSERT INTO attendance_points (company_id, location_id, created_by) VALUES ($1, $2, $3)`, [A, d.A.lokasi, u1], /satu_aktif_per_lokasi/);
        await c.query(`INSERT INTO attendance_points (company_id, location_id, status, created_by) VALUES ($1, $2, 'NONAKTIF', $3)`, [A, d.A.lokasi, u1]);
        await harusGagal(c, `INSERT INTO attendance_points (company_id, location_id, status, created_by) VALUES ($1, $2, 'NONAKTIF', $3)`, [A, d.B.lokasi, u1], /foreign key/); // lokasi perusahaan lain
        const kode = (await c.query(`SELECT public_code FROM attendance_points WHERE id = $1`, [d.A.titik])).rows[0].public_code;
        await harusGagal(c, `INSERT INTO attendance_points (company_id, location_id, status, public_code, created_by) VALUES ($1, $2, 'NONAKTIF', $3, $4)`, [A, d.A.lokasi, kode, u1], /public_code/);
      }));

    it('shift lintas tengah malam konsisten dengan jam; toleransi terbatas', () =>
      tx(async (c) => {
        await harusGagal(c, `INSERT INTO shift_patterns (company_id, name, start_time, end_time, crosses_midnight, created_by) VALUES ($1, 'X1', '22:00', '06:00', false, $2)`, [A, u1], /lintas_tengah_malam/);
        await harusGagal(c, `INSERT INTO shift_patterns (company_id, name, start_time, end_time, crosses_midnight, created_by) VALUES ($1, 'X2', '07:00', '15:00', true, $2)`, [A, u1], /lintas_tengah_malam/);
        await harusGagal(c, `INSERT INTO shift_patterns (company_id, name, start_time, end_time, late_tolerance_min, created_by) VALUES ($1, 'X3', '07:00', '15:00', 241, $2)`, [A, u1], /tolerance_min/);
        await c.query(`INSERT INTO shift_patterns (company_id, name, start_time, end_time, created_by) VALUES ($1, 'Pagi', '07:00', '15:00', $2)`, [A, u1]);
        await harusGagal(c, `INSERT INTO shift_patterns (company_id, name, start_time, end_time, created_by) VALUES ($1, 'Pagi', '07:00', '15:00', $2)`, [A, u1], /nama_unik/);
      }));

    it('jadwal: hari kerja ISO 1-7, periode sah, tidak lintas perusahaan', () =>
      tx(async (c) => {
        const sisip = `INSERT INTO work_schedules (company_id, placement_id, shift_id, work_days, valid_from, valid_to, created_by) VALUES ($1, $2, $3, $4::smallint[], '2026-03-01', $5, $6)`;
        await c.query(sisip, [A, d.A.placement, d.A.shift, '{1,2,3,4,5}', null, u1]);
        await harusGagal(c, sisip, [A, d.A.placement, d.A.shift, '{0,8}', null, u1], /work_days/);
        await harusGagal(c, sisip, [A, d.A.placement, d.A.shift, '{}', null, u1], /work_days/);
        await harusGagal(c, sisip, [A, d.A.placement, d.A.shift, '{1}', '2026-02-01', u1], /periode/);
        await harusGagal(c, sisip, [A, d.A.placement, d.B.shift, '{1}', null, u1], /foreign key/);
      }));

    it('libur: cakupan LOKASI wajib lokasi; selain itu tanpa lokasi; unik per tanggal dan cakupan', () =>
      tx(async (c) => {
        const sisip = `INSERT INTO holidays (company_id, holiday_date, scope, location_id, name, created_by) VALUES ($1, $2, $3, $4, 'Libur Uji', $5)`;
        await c.query(sisip, [A, '2026-08-17', 'NASIONAL', null, u1]);
        await harusGagal(c, sisip, [A, '2026-08-17', 'NASIONAL', null, u1], /holidays_unik/);
        await harusGagal(c, sisip, [A, '2026-08-18', 'LOKASI', null, u1], /lokasi_sesuai_cakupan/);
        await harusGagal(c, sisip, [A, '2026-08-18', 'PERUSAHAAN', d.A.lokasi, u1], /lokasi_sesuai_cakupan/);
        await c.query(sisip, [A, '2026-08-18', 'LOKASI', d.A.lokasi, u1]);
      }));
  });

  describe('rekaman', () => {
    it('tanpa duplikat MASUK per orang+titik+tanggal-shift, tetapi percobaan DITOLAK dan PULANG diperbolehkan', () =>
      tx(async (c) => {
        await rekaman(c, d.A, A, { tanggal: '2026-03-02' });
        await harusGagal(c, `${SQL_REKAMAN}`, [A, d.A.person, d.A.placement, d.A.titik, d.A.lokasi, 'MASUK', 'PERLU_VERIFIKASI', null, '2026-03-02', `k-${unik()}`], /tanpa_duplikat/);
        await rekaman(c, d.A, A, { tanggal: '2026-03-02', status: 'DITOLAK', alasan: 'DUPLIKAT' });
        await rekaman(c, d.A, A, { tanggal: '2026-03-02', status: 'DITOLAK', alasan: 'DUPLIKAT' });
        await rekaman(c, d.A, A, { tanggal: '2026-03-02', kind: 'PULANG' });
        await rekaman(c, d.A, A, { tanggal: '2026-03-03' });
      }));

    it('kunci idempotensi unik per orang; alasan tolak sesuai status; koordinat lengkap; waktu server default', () =>
      tx(async (c) => {
        await rekaman(c, d.A, A, { kunci: 'idem-kunci-1', tanggal: '2026-03-04' });
        await harusGagal(c, SQL_REKAMAN, [A, d.A.person, d.A.placement, d.A.titik, d.A.lokasi, 'PULANG', 'VALID', null, '2026-03-04', 'idem-kunci-1'], /idempotensi_unik/);
        await harusGagal(c, SQL_REKAMAN, [A, d.A.person, d.A.placement, d.A.titik, d.A.lokasi, 'MASUK', 'DITOLAK', null, '2026-03-05', `k-${unik()}`], /alasan_tolak/);
        await harusGagal(c, SQL_REKAMAN, [A, d.A.person, d.A.placement, d.A.titik, d.A.lokasi, 'MASUK', 'VALID', 'x', '2026-03-05', `k-${unik()}`], /alasan_tolak/);
        await harusGagal(c, `UPDATE attendance_records SET latitude = -6.2 WHERE id = $1`, [d.A.rekaman], /koordinat_lengkap/);
        await harusGagal(c, `UPDATE attendance_records SET latitude = 91, longitude = 0 WHERE id = $1`, [d.A.rekaman], /latitude/);
        await harusGagal(c, `UPDATE attendance_records SET accuracy_m = -1 WHERE id = $1`, [d.A.rekaman], /accuracy_m/);
        const t = (await c.query(`SELECT occurred_at >= now() - interval '1 minute' AS segar FROM attendance_records WHERE id = $1`, [(await rekaman(c, d.A, A, { tanggal: '2026-03-06' })).rows[0].id])).rows[0];
        expect(t.segar).toBe(true);
      }));

    it('rekaman tidak dapat merujuk titik, penempatan, atau lokasi perusahaan lain', () =>
      tx(async (c) => {
        await harusGagal(c, SQL_REKAMAN, [A, d.A.person, d.A.placement, d.B.titik, d.A.lokasi, 'MASUK', 'VALID', null, '2026-03-07', `k-${unik()}`], /foreign key/);
        await harusGagal(c, SQL_REKAMAN, [A, d.A.person, d.B.placement, d.A.titik, d.A.lokasi, 'MASUK', 'VALID', null, '2026-03-07', `k-${unik()}`], /foreign key/);
      }));
  });

  describe('selfie, flag, perangkat', () => {
    it('selfie: satu per rekaman, ukuran <= 300 KB, hash valid, tidak dapat merujuk rekaman perusahaan lain', () =>
      tx(async (c) => {
        const id = (await rekaman(c, d.A, A, { tanggal: '2026-03-08' })).rows[0].id;
        const sisip = `INSERT INTO attendance_selfies (company_id, record_id, storage_key, sha256, size_bytes, purge_after) VALUES ($1, $2, $3, $4, $5, now() + interval '90 days')`;
        await c.query(sisip, [A, id, `${A}/${randomUUID()}`, hash(), 1000]);
        await harusGagal(c, sisip, [A, id, `${A}/${randomUUID()}`, hash(), 1000], /record_id_key/);
        const id2 = (await rekaman(c, d.A, A, { tanggal: '2026-03-09' })).rows[0].id;
        await harusGagal(c, sisip, [A, id2, 'k', hash(), 307201], /size_bytes/);
        await harusGagal(c, sisip, [A, id2, 'k', 'bukan-hash', 10], /sha256/);
        await harusGagal(c, sisip, [B, id2, 'k', hash(), 10], /foreign key/);
      }));

    it('flag unik per rekaman+kode; perangkat unik per orang+hash dan hash 64 heksa', () =>
      tx(async (c) => {
        await c.query(`INSERT INTO attendance_flags (company_id, record_id, code, score) VALUES ($1, $2, 'TERLAMBAT', 0)`, [A, d.A.rekaman]);
        await harusGagal(c, `INSERT INTO attendance_flags (company_id, record_id, code, score) VALUES ($1, $2, 'TERLAMBAT', 0)`, [A, d.A.rekaman], /flags_unik/);
        const h = hash();
        await c.query(`INSERT INTO device_registrations (company_id, person_id, device_hash, status) VALUES ($1, $2, $3, 'DISETUJUI')`, [A, d.A.person, h]);
        await harusGagal(c, `INSERT INTO device_registrations (company_id, person_id, device_hash) VALUES ($1, $2, $3)`, [A, d.A.person, h], /registrations_unik/);
        await harusGagal(c, `INSERT INTO device_registrations (company_id, person_id, device_hash) VALUES ($1, $2, 'pendek')`, [A, d.A.person], /device_hash/);
      }));
  });

  describe('tinjauan dan koreksi (pemisahan tugas dijaga database)', () => {
    it('putusan wajib didahului pemeriksaan oleh orang berbeda; hanya-tambah; satu per tahap', () =>
      tx(async (c) => {
        const id = (await rekaman(c, d.A, A, { tanggal: '2026-03-11', status: 'PERLU_VERIFIKASI' })).rows[0].id;
        const sisip = `INSERT INTO attendance_reviews (company_id, record_id, stage, decision, actor_id, reason) VALUES ($1, $2, $3, $4, $5, 'alasan uji')`;
        await harusGagal(c, sisip, [A, id, 'PUTUSAN', 'DISETUJUI', u2], /didahului pemeriksaan/);
        await c.query(sisip, [A, id, 'PERIKSA', 'DIPERIKSA', u1]);
        await harusGagal(c, sisip, [A, id, 'PUTUSAN', 'DISETUJUI', u1], /orang berbeda/);
        await harusGagal(c, sisip, [A, id, 'PERIKSA', 'DIPERIKSA', u2], /satu_per_tahap/);
        await harusGagal(c, sisip, [A, id, 'PERIKSA', 'DISETUJUI', u2], /tahap_sesuai/);
        await c.query(sisip, [A, id, 'PUTUSAN', 'DITOLAK', u2]);
        await harusGagal(c, `UPDATE attendance_reviews SET decision = 'DISETUJUI' WHERE record_id = $1`, [id], /tidak boleh/i);
        await harusGagal(c, `DELETE FROM attendance_reviews WHERE record_id = $1`, [id], /tidak boleh/i);
        const e = (await c.query(`SELECT original_status, effective_status FROM attendance_effective WHERE id = $1`, [id])).rows[0];
        expect(e).toEqual({ original_status: 'PERLU_VERIFIKASI', effective_status: 'DITOLAK' });
      }));

    it('koreksi: penyetuju bukan pembuat; putusan lengkap; nomor unik; alasan wajib', () =>
      tx(async (c) => {
        const sisip = `INSERT INTO attendance_adjustments (company_id, adjustment_no, person_id, shift_date, effect, reason, created_by) VALUES ($1, $2, $3, '2026-03-12', 'HADIR', $4, $5)`;
        const id = (await c.query(`${sisip} RETURNING id`, [A, 'KOR/1', d.A.person, 'lupa absen', u1])).rows[0].id;
        await harusGagal(c, sisip, [A, 'KOR/1', d.A.person, 'x', u1], /nomor_unik/);
        await harusGagal(c, sisip, [A, 'KOR/2', d.A.person, '  ', u1], /reason/);
        await harusGagal(c, `UPDATE attendance_adjustments SET status = 'DISETUJUI' WHERE id = $1`, [id], /putusan_lengkap/);
        await harusGagal(c, `UPDATE attendance_adjustments SET status = 'DISETUJUI', decided_by = $2, decided_at = now() WHERE id = $1`, [id, u1], /_sod/);
        await c.query(`UPDATE attendance_adjustments SET status = 'DISETUJUI', decided_by = $2, decided_at = now() WHERE id = $1`, [id, u2]);
      }));
  });

  describe('isolasi RLS (dan bukti tes efektif bila RLS dimatikan)', () => {
    // Rekaman cadangan (dibuat di luar uji) untuk tabel anak: induknya tetap ber-RLS sehingga sisipan lintas perusahaan murni menguji tabel anak.
    const cadangan: { A: string[]; B: string[] } = { A: [], B: [] };
    const ambil = (company: string) => (company === A ? cadangan.A : cadangan.B).shift()!;
    const TABEL: [string, (c: string) => { text: string; values: unknown[] }][] = [
      ['attendance_points', (c) => ({ text: `INSERT INTO attendance_points (company_id, location_id, status, created_by) VALUES ($1, $2, 'NONAKTIF', $3)`, values: [c, c === A ? d.A.lokasi : d.B.lokasi, u1] })],
      ['shift_patterns', (c) => ({ text: `INSERT INTO shift_patterns (company_id, name, start_time, end_time, created_by) VALUES ($1, $2, '07:00', '15:00', $3)`, values: [c, `Iso ${unik()}`, u1] })],
      ['work_schedules', (c) => ({ text: `INSERT INTO work_schedules (company_id, placement_id, shift_id, work_days, valid_from, created_by) VALUES ($1, $2, $3, '{1}', '2026-03-01', $4)`, values: [c, c === A ? d.A.placement : d.B.placement, c === A ? d.A.shift : d.B.shift, u1] })],
      ['holidays', (c) => ({ text: `INSERT INTO holidays (company_id, holiday_date, scope, name, created_by) VALUES ($1, '2030-01-01'::date + (random() * 3000)::int, 'PERUSAHAAN', 'Iso', $2)`, values: [c, u1] })],
      ['device_registrations', (c) => ({ text: `INSERT INTO device_registrations (company_id, person_id, device_hash) VALUES ($1, $2, $3)`, values: [c, c === A ? d.A.person : d.B.person, hash()] })],
      ['attendance_records', (c) => ({ text: `${SQL_REKAMAN}`, values: [c, c === A ? d.A.person : d.B.person, c === A ? d.A.placement : d.B.placement, c === A ? d.A.titik : d.B.titik, c === A ? d.A.lokasi : d.B.lokasi, 'MASUK', 'VALID', null, `2028-${String(1 + Math.floor(Math.random() * 12)).padStart(2, '0')}-${String(1 + Math.floor(Math.random() * 28)).padStart(2, '0')}`, `iso-${unik()}-${unik()}`] })],
      ['attendance_selfies', (c) => ({ text: `INSERT INTO attendance_selfies (company_id, record_id, storage_key, sha256, size_bytes, purge_after) VALUES ($1, $2, 'k', $3, 10, now())`, values: [c, ambil(c), hash()] })],
      ['attendance_flags', (c) => ({ text: `INSERT INTO attendance_flags (company_id, record_id, code) VALUES ($1, $2, $3)`, values: [c, c === A ? d.A.rekaman : d.B.rekaman, `ISO_${unik()}`] })],
      ['attendance_reviews', (c) => ({ text: `INSERT INTO attendance_reviews (company_id, record_id, stage, decision, actor_id, reason) VALUES ($1, $2, 'PERIKSA', 'DIPERIKSA', $3, 'iso')`, values: [c, ambil(c), u1] })],
      ['attendance_adjustments', (c) => ({ text: `INSERT INTO attendance_adjustments (company_id, adjustment_no, person_id, shift_date, effect, reason, created_by) VALUES ($1, $2, $3, '2026-03-12', 'HADIR', 'iso', $4)`, values: [c, `ISO/${unik()}`, c === A ? d.A.person : d.B.person, u1] })],
    ];
    beforeAll(async () => {
      for (const [kode, x, id] of [['A', d.A, A], ['B', d.B, B]] as const)
        for (let i = 0; i < 16; i++) cadangan[kode].push(await dalamScope(pool, [id], async (c) => (await rekaman(c, x, id, { tanggal: `2029-01-${String(1 + (i % 28)).padStart(2, '0')}`, kind: i < 28 ? 'MASUK' : 'PULANG', status: 'PERLU_VERIFIKASI', kunci: `cad-${unik()}-${i}` })).rows[0].id as string, { commit: true }));
    });
    it.each(TABEL.map(([t]) => t))('%s: scope A tidak menyentuh baris B; RLS dimatikan => kebocoran terdeteksi', async (tabel) => {
      const [, sisip] = TABEL.find(([t]) => t === tabel)!;
      const buat = (id: string) => dalamScope(pool, [id], async (c) => (await c.query(`${sisip(id).text} RETURNING id`, sisip(id).values)).rows[0].id as string, { commit: true });
      const k: KonfigKebocoran = { tabel, companyA: A, companyB: B, idBarisA: await buat(A), idBarisB: await buat(B), sisipUntuk: (id) => sisip(id) };
      // attendance_reviews bersifat hanya-tambah (trigger), bukan RLS yang menolak UPDATE/DELETE.
      const saring = (l: string[]) => l.filter((x) => !(tabel === 'attendance_reviews' && /UPDATE|DELETE/.test(x)));
      expect(saring(await cekKebocoran(pool, k))).toEqual([]);
      await pool.query(`ALTER TABLE ${tabel} DISABLE ROW LEVEL SECURITY`);
      try {
        expect(saring(await cekKebocoran(pool, k))).toEqual(expect.arrayContaining(['SELECT massal melihat baris perusahaan lain', 'SELECT per ID melihat baris perusahaan lain', 'INSERT menulis baris untuk perusahaan lain', 'Tanpa scope tetap melihat baris']));
      } finally {
        await pool.query(`ALTER TABLE ${tabel} ENABLE ROW LEVEL SECURITY`);
      }
      expect(saring(await cekKebocoran(pool, k))).toEqual([]);
    });

    it('kebijakan sempit titik_baca_kode dan perangkat_baca_hash: hanya baris yang cocok persis dengan variabel transaksi', async () => {
      const kode = (await dalamScope(pool, [A], async (c) => (await c.query(`SELECT public_code FROM attendance_points WHERE id = $1`, [d.A.titik])).rows[0].public_code as string));
      const hashA = hash();
      await dalamScope(pool, [A], async (c) => void (await c.query(`INSERT INTO device_registrations (company_id, person_id, device_hash) VALUES ($1, $2, $3)`, [A, d.A.person, hashA])), { commit: true });
      const baca = (set: [string, string][], sql: string, params: unknown[] = []) =>
        dalamScope(pool, [], async (c) => {
          for (const [k, v] of set) await c.query(`SELECT set_config($1, $2, true)`, [k, v]);
          return (await c.query(sql, params)).rowCount;
        });
      // tanpa scope perusahaan: kosong; dengan variabel yang cocok: tepat satu baris; variabel lain/kode lain: kosong
      expect(await baca([], `SELECT 1 FROM attendance_points`)).toBe(0);
      expect(await baca([['app.titik_kode', kode]], `SELECT 1 FROM attendance_points`)).toBe(1);
      expect(await baca([['app.titik_kode', randomUUID()]], `SELECT 1 FROM attendance_points`)).toBe(0);
      expect(await baca([['app.titik_kode', kode]], `SELECT 1 FROM attendance_points WHERE company_id = $1`, [B])).toBe(0);
      expect(await baca([['app.perangkat_hash', hashA]], `SELECT 1 FROM device_registrations`)).toBe(1);
      expect(await baca([['app.perangkat_hash', hash()]], `SELECT 1 FROM device_registrations`)).toBe(0);
      expect(await baca([], `SELECT 1 FROM device_registrations`)).toBe(0);
      // kebijakan hanya memberi SELECT: tidak dapat menulis/menghapus lewat jalur ini
      await dalamScope(pool, [], async (c) => {
        await c.query(`SELECT set_config('app.titik_kode', $1, true)`, [kode]);
        expect((await c.query(`UPDATE attendance_points SET status = 'NONAKTIF' WHERE id = $1`, [d.A.titik])).rowCount).toBe(0);
        expect((await c.query(`DELETE FROM attendance_points WHERE id = $1`, [d.A.titik])).rowCount).toBe(0);
      });
    });

    it('member hanya membaca penanda rekamannya sendiri (kebijakan absensi_flag_baca_milik)', async () => {
      await dalamScope(pool, [A], async (c) => void (await c.query(`INSERT INTO attendance_flags (company_id, record_id, code) VALUES ($1, $2, 'MILIK_A') ON CONFLICT DO NOTHING`, [A, d.A.rekaman])), { commit: true });
      await dalamScope(pool, [B], async (c) => void (await c.query(`INSERT INTO attendance_flags (company_id, record_id, code) VALUES ($1, $2, 'MILIK_B') ON CONFLICT DO NOTHING`, [B, d.B.rekaman])), { commit: true });
      const baca = (person: string) =>
        dalamScope(pool, [], async (c) => {
          await c.query(`SELECT set_config('app.member_person_id', $1, true)`, [person]);
          return (await c.query(`SELECT code FROM attendance_flags WHERE code LIKE 'MILIK\\_%'`)).rows.map((r) => r.code as string);
        });
      expect(await baca(d.A.person)).toEqual(['MILIK_A']);
      expect(await baca(d.B.person)).toEqual(['MILIK_B']);
      expect(await baca(randomUUID())).toEqual([]);
    });

    it('tampilan attendance_effective mengikuti RLS (scope A tidak melihat rekaman B)', async () => {
      const ids = await dalamScope(pool, [A], async (c) => (await c.query(`SELECT company_id FROM attendance_effective`)).rows.map((r) => r.company_id as string));
      expect(ids.length).toBeGreaterThan(0);
      expect(ids).not.toContain(B);
    });
  });
});
