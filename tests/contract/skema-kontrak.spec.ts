import { randomBytes, randomUUID } from 'node:crypto';
import { Pool, PoolClient } from 'pg';
import { COMPANY_SINTETIS } from '../helpers/data-sintetis';
import { ROLE_UJI, bukaPool, dalamScope, migrasiNaik, siapkanRoleUji } from '../helpers/db';
import { cekKebocoran, KonfigKebocoran } from '../helpers/kebocoran';

const ada = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const A = COMPANY_SINTETIS.A;
const B = COMPANY_SINTETIS.B;
const unik = () => randomBytes(5).toString('hex');
const hash = () => randomBytes(32);

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

interface Dasar { tpl: string; tplBelum: string; lamaran: string; person: string; kontrak: string; lokasi: string }

ada('PKWT dan penempatan: invarian skema, pelindung database, dan isolasi RLS', () => {
  let pool: Pool;
  let u1: string; // pembuat
  let u2: string; // pemeriksa / pemverifikasi
  let u3: string; // penyetuju
  const d: { A: Dasar; B: Dasar } = { A: {} as Dasar, B: {} as Dasar };
  const cadangan: { A: { l: string; p: string }[]; B: { l: string; p: string }[] } = { A: [], B: [] }; // lamaran siap pakai untuk sisipan uji kebocoran

  const buatUser = async () => {
    const p = (await pool.query(`INSERT INTO persons (display_name) VALUES ('SINTETIS Staff') RETURNING id`)).rows[0].id;
    return (await pool.query(`INSERT INTO users (person_id, realm, email, status) VALUES ($1, 'staff', $2, 'AKTIF') RETURNING id`, [p, `pkwt-${unik()}@contoh.invalid`])).rows[0].id as string;
  };
  const buatPerson = async () => (await pool.query(`INSERT INTO persons (display_name) VALUES ('SINTETIS Pekerja') RETURNING id`)).rows[0].id as string;

  /** Rantai induk dalam scope perusahaan: lowongan -> lamaran -> template terverifikasi -> kontrak DRAFT, + lokasi. */
  const siapkan = async (company: string): Promise<Dasar> =>
    dalamScope(pool, [company], async (c) => {
      const v = (await c.query(`INSERT INTO job_vacancies (company_id, title, description, created_by) VALUES ($1, 'L', 'D', $2) RETURNING id`, [company, u1])).rows[0].id;
      const person = await buatPerson();
      const lamaran = (await c.query(`INSERT INTO job_applications (company_id, vacancy_id, person_id, status) VALUES ($1, $2, $3, 'MENUNGGU_PKWT') RETURNING id`, [company, v, person])).rows[0].id;
      const tpl = (await c.query(`INSERT INTO contract_templates (company_id, name, version, body, created_by) VALUES ($1, $2, 1, 'CONTOH UJI — BUKAN DOKUMEN HUKUM {{nama}}', $3) RETURNING id`, [company, `Tpl ${unik()}`, u1])).rows[0].id;
      await c.query(`UPDATE contract_templates SET status = 'TERVERIFIKASI', verified_by = $2, verified_at = now(), verification_note = 'uji' WHERE id = $1`, [tpl, u2]);
      const tplBelum = (await c.query(`INSERT INTO contract_templates (company_id, name, version, body, created_by) VALUES ($1, $2, 1, 'CONTOH UJI', $3) RETURNING id`, [company, `Belum ${unik()}`, u1])).rows[0].id;
      const kontrak = (await c.query(`INSERT INTO employment_contracts (company_id, application_id, person_id, template_id, contract_number, position, start_date, end_date, created_by) VALUES ($1, $2, $3, $4, $5, 'Satpam', '2026-01-01', '2026-12-31', $6) RETURNING id`, [company, lamaran, person, tpl, `PKWT/${unik()}`, u1])).rows[0].id;
      const pr = (await c.query(`INSERT INTO partners (company_id, name, created_by) VALUES ($1, $2, $3) RETURNING id`, [company, `Rek ${unik()}`, u1])).rows[0].id;
      const lokasi = (await c.query(`INSERT INTO partner_locations (company_id, partner_id, name, created_by) VALUES ($1, $2, 'Lok', $3) RETURNING id`, [company, pr, u1])).rows[0].id;
      return { tpl, tplBelum, lamaran, person, kontrak, lokasi };
    }, { commit: true });

  /** Mengantar kontrak sampai AKTIF lewat jalur sah (reviewer, penyetuju, scan terverifikasi). */
  const aktifkan = async (c: PoolClient, company: string, kontrak: string) => {
    await c.query(`UPDATE employment_contracts SET status = 'PERSETUJUAN', reviewed_by = $2, reviewed_at = now() WHERE id = $1`, [kontrak, u2]);
    await c.query(`UPDATE employment_contracts SET status = 'PENANDATANGANAN', approved_by = $2, approved_at = now() WHERE id = $1`, [kontrak, u3]);
    await c.query(`INSERT INTO contract_documents (company_id, contract_id, version_no, object_key, original_filename, mime_type, size_bytes, sha256, status, uploaded_by, verified_by, verified_at) VALUES ($1, $2, 1, $3, 's.pdf', 'application/pdf', 10, $4, 'TERVERIFIKASI', $5, $6, now())`, [company, kontrak, `${company}/${randomUUID()}`, hash(), u1, u2]);
    await c.query(`UPDATE employment_contracts SET status = 'DITANDATANGANI' WHERE id = $1`, [kontrak]);
    await c.query(`UPDATE employment_contracts SET status = 'AKTIF', activated_at = now() WHERE id = $1`, [kontrak]);
  };

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
    for (const [kode, id] of [['A', A], ['B', B]] as const) {
      for (let i = 0; i < 5; i++) {
        const p = await buatPerson();
        await dalamScope(pool, [id], async (c) => {
          const v = (await c.query(`INSERT INTO job_vacancies (company_id, title, description, created_by) VALUES ($1, 'L', 'D', $2) RETURNING id`, [id, u1])).rows[0].id;
          cadangan[kode].push({ l: (await c.query(`INSERT INTO job_applications (company_id, vacancy_id, person_id, status) VALUES ($1, $2, $3, 'MENUNGGU_PKWT') RETURNING id`, [id, v, p])).rows[0].id, p });
        }, { commit: true });
      }
    }
  });
  afterAll(async () => {
    await pool.end();
  });
  const tx = (fn: (c: PoolClient) => Promise<void>) => dalamScope(pool, [A, B], async (c) => fn(c)); // selalu ROLLBACK

  describe('template', () => {
    it('verifikasi wajib lengkap dan pemverifikasi bukan pembuat; isi terkunci setelah diverifikasi; versi unik', () =>
      tx(async (c) => {
        const t = (await c.query(`INSERT INTO contract_templates (company_id, name, version, body, created_by) VALUES ($1, 'T', 1, 'CONTOH', $2) RETURNING id`, [A, u1])).rows[0].id;
        await c.query(`UPDATE contract_templates SET body = 'CONTOH DIUBAH' WHERE id = $1`, [t]); // belum diverifikasi: boleh
        await harusGagal(c, `UPDATE contract_templates SET status = 'TERVERIFIKASI' WHERE id = $1`, [t], /verifikasi_lengkap/);
        await harusGagal(c, `UPDATE contract_templates SET status = 'TERVERIFIKASI', verified_by = $2, verified_at = now(), verification_note = 'x' WHERE id = $1`, [t, u1], /pemverifikasi_bukan_pembuat/);
        await c.query(`UPDATE contract_templates SET status = 'TERVERIFIKASI', verified_by = $2, verified_at = now(), verification_note = 'ahli hukum' WHERE id = $1`, [t, u2]);
        await harusGagal(c, `UPDATE contract_templates SET body = 'DIRETAS' WHERE id = $1`, [t], /tidak boleh diubah/);
        await harusGagal(c, `UPDATE contract_templates SET version = 9 WHERE id = $1`, [t], /tidak boleh diubah/);
        await harusGagal(c, `DELETE FROM contract_templates WHERE id = $1`, [t], /tidak boleh dihapus/);
        await c.query(`UPDATE contract_templates SET status = 'DIARSIPKAN' WHERE id = $1`, [t]); // status boleh berubah, isi tidak
        await harusGagal(c, `INSERT INTO contract_templates (company_id, name, version, body, created_by) VALUES ($1, 'T', 1, 'X', $2)`, [A, u1], /versi_unik/);
        await expect(c.query(`INSERT INTO contract_templates (company_id, name, version, body, created_by) VALUES ($1, 'T', 2, 'X', $2)`, [A, u1])).resolves.toBeDefined();
      }));
  });

  describe('kontrak', () => {
    const lamaranBaru = async (c: PoolClient, company: string) => {
      const v = (await c.query(`INSERT INTO job_vacancies (company_id, title, description, created_by) VALUES ($1, 'L', 'D', $2) RETURNING id`, [company, u1])).rows[0].id;
      const person = await buatPerson();
      const l = (await c.query(`INSERT INTO job_applications (company_id, vacancy_id, person_id, status) VALUES ($1, $2, $3, 'MENUNGGU_PKWT') RETURNING id`, [company, v, person])).rows[0].id;
      return { l, person };
    };
    const kontrakBaru = (c: PoolClient, company: string, l: string, person: string, tpl: string, nomor = `N-${unik()}`, ekstra = '') =>
      c.query(`INSERT INTO employment_contracts (company_id, application_id, person_id, template_id, contract_number, position, start_date, end_date, created_by ${ekstra ? ', ' + ekstra.split('=')[0] : ''}) VALUES ($1, $2, $3, $4, $5, 'Satpam', '2026-01-01', '2026-12-31', $6 ${ekstra ? ', ' + ekstra.split('=')[1] : ''}) RETURNING id`, [company, l, person, tpl, nomor, u1]);

    it('SoD (pembuat/pemeriksa/penyetuju berbeda), status sah, periode, nomor unik per perusahaan, FK komposit', () =>
      tx(async (c) => {
        const { l, person } = await lamaranBaru(c, A);
        const nomor = `N-${unik()}`;
        const k = (await kontrakBaru(c, A, l, person, d.A.tpl, nomor)).rows[0].id;
        await harusGagal(c, `UPDATE employment_contracts SET status = 'PERSETUJUAN', reviewed_by = $2, reviewed_at = now() WHERE id = $1`, [k, u1], /employment_contracts_sod/);
        await harusGagal(c, `UPDATE employment_contracts SET status = 'PERSETUJUAN' WHERE id = $1`, [k], /pemeriksa_wajib/);
        await c.query(`UPDATE employment_contracts SET status = 'PERSETUJUAN', reviewed_by = $2, reviewed_at = now() WHERE id = $1`, [k, u2]);
        await harusGagal(c, `UPDATE employment_contracts SET status = 'PENANDATANGANAN', approved_by = $2, approved_at = now() WHERE id = $1`, [k, u2], /employment_contracts_sod/);
        await harusGagal(c, `UPDATE employment_contracts SET status = 'PENANDATANGANAN', approved_by = $2, approved_at = now() WHERE id = $1`, [k, u1], /employment_contracts_sod/);
        await harusGagal(c, `UPDATE employment_contracts SET status = 'PENANDATANGANAN' WHERE id = $1`, [k], /penyetuju_wajib/);
        await harusGagal(c, `UPDATE employment_contracts SET status = 'ASAL' WHERE id = $1`, [k], /status_check|penyetuju_wajib/);
        await harusGagal(c, `UPDATE employment_contracts SET end_date = '2025-01-01' WHERE id = $1`, [k], /periode/);
        // nomor unik di perusahaan yang sama; boleh sama di perusahaan lain
        const l2 = await lamaranBaru(c, A);
        await harusGagal(c, `INSERT INTO employment_contracts (company_id, application_id, person_id, template_id, contract_number, position, start_date, end_date, created_by) VALUES ($1, $2, $3, $4, $5, 'S', '2026-01-01', '2026-02-01', $6)`, [A, l2.l, l2.person, d.A.tpl, nomor, u1], /nomor_unik/);
        const lb = await lamaranBaru(c, B);
        await expect(kontrakBaru(c, B, lb.l, lb.person, d.B.tpl, nomor)).resolves.toBeDefined();
        // template milik perusahaan lain tidak dapat dipakai (FK komposit)
        const l3 = await lamaranBaru(c, A);
        await harusGagal(c, `INSERT INTO employment_contracts (company_id, application_id, person_id, template_id, contract_number, position, start_date, end_date, created_by) VALUES ($1, $2, $3, $4, $5, 'S', '2026-01-01', '2026-02-01', $6)`, [A, l3.l, l3.person, d.B.tpl, `N-${unik()}`, u1], /foreign key/);
        // satu kontrak berjalan per lamaran; kontrak lanjutan (extends) diperbolehkan; yang dibatalkan tidak menghalangi
        await harusGagal(c, `INSERT INTO employment_contracts (company_id, application_id, person_id, template_id, contract_number, position, start_date, end_date, created_by) VALUES ($1, $2, $3, $4, $5, 'S', '2026-01-01', '2026-02-01', $6)`, [A, l, person, d.A.tpl, `N-${unik()}`, u1], /satu_per_lamaran/);
        await expect(c.query(`INSERT INTO employment_contracts (company_id, application_id, person_id, template_id, contract_number, position, start_date, end_date, created_by, extends_contract_id) VALUES ($1, $2, $3, $4, $5, 'S', '2027-01-01', '2027-12-31', $6, $7)`, [A, l, person, d.A.tpl, `N-${unik()}`, u1, k])).resolves.toBeDefined();
      }));

    it('template belum diverifikasi: kontrak tertahan di DRAFT/REVIEW (trigger); template perusahaan lain tidak bisa; scan terverifikasi wajib untuk DITANDATANGANI/AKTIF', () =>
      tx(async (c) => {
        const { l, person } = await lamaranBaru(c, A);
        const k = (await kontrakBaru(c, A, l, person, d.A.tplBelum)).rows[0].id;
        await c.query(`UPDATE employment_contracts SET status = 'REVIEW' WHERE id = $1`, [k]); // masih boleh
        await harusGagal(c, `UPDATE employment_contracts SET status = 'PERSETUJUAN', reviewed_by = $2, reviewed_at = now() WHERE id = $1`, [k, u2], /belum diverifikasi/);
        await harusGagal(c, `INSERT INTO employment_contracts (company_id, application_id, person_id, template_id, contract_number, position, start_date, end_date, created_by, status, reviewed_by, reviewed_at) VALUES ($1, $2, $3, $4, $5, 'S', '2026-01-01', '2026-02-01', $6, 'PERSETUJUAN', $7, now())`, [A, (await lamaranBaru(c, A)).l, person, d.A.tplBelum, `N-${unik()}`, u1, u2], /belum diverifikasi|foreign key/);
        // kontrak dengan template terverifikasi: tanpa scan terverifikasi tidak boleh DITANDATANGANI
        const l2 = await lamaranBaru(c, A);
        const k2 = (await kontrakBaru(c, A, l2.l, l2.person, d.A.tpl)).rows[0].id;
        await c.query(`UPDATE employment_contracts SET status = 'PERSETUJUAN', reviewed_by = $2, reviewed_at = now() WHERE id = $1`, [k2, u2]);
        await c.query(`UPDATE employment_contracts SET status = 'PENANDATANGANAN', approved_by = $2, approved_at = now() WHERE id = $1`, [k2, u3]);
        await harusGagal(c, `UPDATE employment_contracts SET status = 'DITANDATANGANI' WHERE id = $1`, [k2], /scan bertanda tangan/);
        await c.query(`INSERT INTO contract_documents (company_id, contract_id, version_no, object_key, original_filename, mime_type, size_bytes, sha256, uploaded_by) VALUES ($1, $2, 1, $3, 's.pdf', 'application/pdf', 10, $4, $5)`, [A, k2, `${A}/${randomUUID()}`, hash(), u1]);
        await harusGagal(c, `UPDATE employment_contracts SET status = 'DITANDATANGANI' WHERE id = $1`, [k2], /scan bertanda tangan/); // masih menunggu verifikasi
        await c.query(`UPDATE contract_documents SET status = 'TERVERIFIKASI', verified_by = $2, verified_at = now() WHERE contract_id = $1`, [k2, u2]);
        await expect(c.query(`UPDATE employment_contracts SET status = 'DITANDATANGANI' WHERE id = $1`, [k2])).resolves.toBeDefined();
      }));

    it('versi kontrak bersifat hanya-tambah dan unik per kontrak', () =>
      tx(async (c) => {
        const v = await c.query(`INSERT INTO contract_versions (company_id, contract_id, version_no, contract_number, position, start_date, end_date, template_id, template_version, created_by) VALUES ($1, $2, 1, 'N', 'P', '2026-01-01', '2026-12-31', $3, 1, $4) RETURNING id`, [A, d.A.kontrak, d.A.tpl, u1]);
        await harusGagal(c, `INSERT INTO contract_versions (company_id, contract_id, version_no, contract_number, position, start_date, end_date, template_id, template_version, created_by) VALUES ($1, $2, 1, 'N', 'P', '2026-01-01', '2026-12-31', $3, 1, $4)`, [A, d.A.kontrak, d.A.tpl, u1], /contract_versions_unik/);
        await harusGagal(c, `UPDATE contract_versions SET position = 'X' WHERE id = $1`, [v.rows[0].id], /hanya-tambah/);
        await harusGagal(c, `DELETE FROM contract_versions WHERE id = $1`, [v.rows[0].id], /hanya-tambah/);
        await harusGagal(c, `INSERT INTO contract_versions (company_id, contract_id, version_no, contract_number, position, start_date, end_date, template_id, template_version, created_by) VALUES ($1, $2, 2, 'N', 'P', '2026-01-01', '2026-12-31', $3, 1, $4)`, [B, d.A.kontrak, d.A.tpl, u1], /foreign key/);
      }));
  });

  describe('dokumen scan', () => {
    it('satu dokumen berjalan per kontrak; pemverifikasi bukan pengunggah; ditolak wajib beralasan; tipe/ukuran/sha sah', () =>
      tx(async (c) => {
        const dok = (status = 'MENUNGGU_VERIFIKASI', mime = 'application/pdf', ukuran = 10, sha = hash()) =>
          c.query(`INSERT INTO contract_documents (company_id, contract_id, version_no, object_key, original_filename, mime_type, size_bytes, sha256, status, uploaded_by) VALUES ($1, $2, 1, $3, 's.pdf', $4, $5, $6, $7, $8) RETURNING id`, [A, d.A.kontrak, `${A}/${randomUUID()}`, mime, ukuran, sha, status, u1]);
        const id = (await dok()).rows[0].id;
        await harusGagal(c, `INSERT INTO contract_documents (company_id, contract_id, version_no, object_key, original_filename, mime_type, size_bytes, sha256, uploaded_by) VALUES ($1, $2, 1, $3, 's.pdf', 'application/pdf', 10, $4, $5)`, [A, d.A.kontrak, `${A}/${randomUUID()}`, hash(), u1], /satu_berjalan/);
        await harusGagal(c, `UPDATE contract_documents SET status = 'TERVERIFIKASI', verified_by = $2, verified_at = now() WHERE id = $1`, [id, u1], /pemverifikasi_bukan_pengunggah/);
        await harusGagal(c, `UPDATE contract_documents SET status = 'DITOLAK', verified_by = $2, verified_at = now() WHERE id = $1`, [id, u2], /keputusan_lengkap/);
        await c.query(`UPDATE contract_documents SET status = 'DITOLAK', verified_by = $2, verified_at = now(), reject_reason = 'Buram' WHERE id = $1`, [id, u2]);
        await expect(dok()).resolves.toBeDefined(); // yang ditolak tidak menghalangi unggahan ulang
        await harusGagal(c, `INSERT INTO contract_documents (company_id, contract_id, version_no, object_key, original_filename, mime_type, size_bytes, sha256, status, uploaded_by) VALUES ($1, $2, 1, $3, 'a.exe', 'application/x-msdownload', 10, $4, 'MENUNGGU_VERIFIKASI', $5)`, [A, d.A.kontrak, `${A}/${randomUUID()}`, hash(), u1], /mime_type_check/);
        await harusGagal(c, `INSERT INTO contract_documents (company_id, contract_id, version_no, object_key, original_filename, mime_type, size_bytes, sha256, status, uploaded_by) VALUES ($1, $2, 1, $3, 'a.pdf', 'application/pdf', 10485761, $4, 'MENUNGGU_VERIFIKASI', $5)`, [A, d.A.kontrak, `${A}/${randomUUID()}`, hash(), u1], /size_bytes_check/);
        await harusGagal(c, `INSERT INTO contract_documents (company_id, contract_id, version_no, object_key, original_filename, mime_type, size_bytes, sha256, status, uploaded_by) VALUES ($1, $2, 1, $3, 'a.pdf', 'application/pdf', 10, '\\x00', 'MENUNGGU_VERIFIKASI', $4)`, [A, d.A.kontrak, `${A}/${randomUUID()}`, u1], /sha256_check/);
      }));
  });

  describe('penempatan', () => {
    it('dua penempatan non-final tumpang tindih ditolak DATABASE; berdampingan dan yang final/dibatalkan boleh; orang berbeda boleh', () =>
      tx(async (c) => {
        const p = d.A.person;
        const baru = (mulai: string, akhir: string | null, status = 'DIRENCANAKAN', person = p) =>
          c.query(`INSERT INTO placements (company_id, person_id, location_id, start_date, end_date, status, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`, [A, person, d.A.lokasi, mulai, akhir, status, u1]);
        await baru('2026-01-01', '2026-06-30');
        await harusGagal(c, `INSERT INTO placements (company_id, person_id, location_id, start_date, end_date, created_by) VALUES ($1, $2, $3, '2026-06-30', '2026-12-31', $4)`, [A, p, d.A.lokasi, u1], /tanpa_tumpang_tindih/); // bersinggungan di 30 Jun
        await harusGagal(c, `INSERT INTO placements (company_id, person_id, location_id, start_date, end_date, created_by) VALUES ($1, $2, $3, '2026-03-01', NULL, $4)`, [A, p, d.A.lokasi, u1], /tanpa_tumpang_tindih/); // tanpa akhir
        await expect(baru('2026-07-01', '2026-12-31')).resolves.toBeDefined(); // berdampingan
        await expect(baru('2026-02-01', '2026-03-01', 'DIBATALKAN')).resolves.toBeDefined(); // dibatalkan tidak menghalangi
        await expect(baru('2026-02-01', '2026-03-01', 'SELESAI')).resolves.toBeDefined();
        await expect(baru('2026-02-01', '2026-03-01', 'DIRENCANAKAN', await buatPerson())).resolves.toBeDefined(); // orang lain
        await harusGagal(c, `INSERT INTO placements (company_id, person_id, location_id, start_date, end_date, created_by) VALUES ($1, $2, $3, '2026-05-01', '2026-04-01', $4)`, [A, await buatPerson(), d.A.lokasi, u1], /placements_periode/);
      }));

    it('AKTIF wajib disetujui (bukan pembuat), berkontrak, dan kontrak AKTIF; kontrak harus milik orang yang sama; lokasi harus satu perusahaan', () =>
      tx(async (c) => {
        const { person, kontrak } = d.A;
        const aktifP = (approver: string, creator = u1) => c.query(`INSERT INTO placements (company_id, person_id, location_id, contract_id, start_date, end_date, status, created_by, approved_by, approved_at) VALUES ($1, $2, $3, $4, '2026-01-01', '2026-12-31', 'AKTIF', $5, $6, now())`, [A, person, d.A.lokasi, kontrak, creator, approver]);
        // kontrak masih DRAFT (atau tanpa kontrak) -> penempatan tidak boleh AKTIF (trigger)
        await harusGagal(c, `INSERT INTO placements (company_id, person_id, location_id, start_date, end_date, status, created_by) VALUES ($1, $2, $3, '2026-01-01', '2026-12-31', 'AKTIF', $4)`, [A, person, d.A.lokasi, u1], /kontraknya aktif/);
        await harusGagal(c, `INSERT INTO placements (company_id, person_id, location_id, contract_id, start_date, end_date, status, created_by, approved_by, approved_at) VALUES ($1, $2, $3, $4, '2026-01-01', '2026-12-31', 'AKTIF', $5, $6, now())`, [A, person, d.A.lokasi, kontrak, u1, u3], /kontraknya aktif/);
        await aktifkan(c, A, kontrak);
        // kontrak AKTIF: sekarang aturan persetujuan yang menentukan
        await harusGagal(c, `INSERT INTO placements (company_id, person_id, location_id, contract_id, start_date, end_date, status, created_by) VALUES ($1, $2, $3, $4, '2026-01-01', '2026-12-31', 'AKTIF', $5)`, [A, person, d.A.lokasi, kontrak, u1], /aktif_wajib_disetujui/);
        await harusGagal(c, `INSERT INTO placements (company_id, person_id, location_id, start_date, end_date, status, created_by, approved_by, approved_at) VALUES ($1, $2, $3, '2026-01-01', '2026-12-31', 'DITANGGUHKAN', $4, $5, now())`, [A, person, d.A.lokasi, u1, u3], /aktif_wajib_disetujui/); // tanpa kontrak
        await harusGagal(c, `INSERT INTO placements (company_id, person_id, location_id, contract_id, start_date, end_date, status, created_by, approved_by, approved_at) VALUES ($1, $2, $3, $4, '2026-01-01', '2026-12-31', 'AKTIF', $5, $5, now())`, [A, person, d.A.lokasi, kontrak, u1], /penyetuju_bukan_pembuat/);
        await expect(aktifP(u3)).resolves.toBeDefined();
        // kontrak milik orang lain
        await harusGagal(c, `INSERT INTO placements (company_id, person_id, location_id, contract_id, start_date, end_date, created_by) VALUES ($1, $2, $3, $4, '2027-01-01', '2027-12-31', $5)`, [A, await buatPerson(), d.A.lokasi, kontrak, u1], /foreign key/);
        // lokasi/kontrak perusahaan lain
        await harusGagal(c, `INSERT INTO placements (company_id, person_id, location_id, start_date, end_date, created_by) VALUES ($1, $2, $3, '2027-01-01', '2027-12-31', $4)`, [A, await buatPerson(), d.B.lokasi, u1], /foreign key/);
      }));
  });

  describe('riwayat otomatis', () => {
    it('aktor boleh kosong hanya untuk entri "Otomatis: ..."', () =>
      tx(async (c) => {
        await c.query(`INSERT INTO member_status_histories (person_id, from_status, to_status, actor_user_id, reason) VALUES ($1, 'BELUM_DITEMPATKAN', 'KARYAWAN_AKTIF', NULL, 'Otomatis: kontrak dan penempatan aktif')`, [d.A.person]);
        await harusGagal(c, `INSERT INTO member_status_histories (person_id, from_status, to_status, actor_user_id, reason) VALUES ($1, 'A', 'B', NULL, 'bebas')`, [d.A.person], /aktor_atau_otomatis/);
        await harusGagal(c, `INSERT INTO member_status_histories (person_id, from_status, to_status, actor_user_id) VALUES ($1, 'A', 'B', NULL)`, [d.A.person], /aktor_atau_otomatis/);
        await harusGagal(c, `INSERT INTO application_status_histories (company_id, application_id, from_status, to_status, actor_user_id, reason) VALUES ($1, $2, 'DIAJUKAN', 'DITARIK', NULL, 'bebas')`, [A, d.A.lamaran], /aktor_atau_otomatis/);
        await expect(c.query(`INSERT INTO application_status_histories (company_id, application_id, from_status, to_status, actor_user_id, reason) VALUES ($1, $2, 'DIAJUKAN', 'DITARIK', NULL, 'Otomatis: menjadi karyawan aktif')`, [A, d.A.lamaran])).resolves.toBeDefined();
      }));
  });

  describe('isolasi RLS (dan bukti tes efektif bila RLS dimatikan)', () => {
    const TABEL: [string, (c: string) => { text: string; values: unknown[] }, boolean][] = [
      ['contract_templates', (c) => ({ text: `INSERT INTO contract_templates (company_id, name, version, body, created_by) VALUES ($1, $2, 1, 'CONTOH', $3)`, values: [c, `Iso ${unik()}`, u1] }), false],
      ['employment_contracts', (c) => {
        const x = cadangan[c === A ? 'A' : 'B'].shift()!; // lamaran baru per sisipan (satu kontrak berjalan per lamaran)
        return { text: `INSERT INTO employment_contracts (company_id, application_id, person_id, template_id, contract_number, position, start_date, end_date, created_by) VALUES ($1, $2, $3, $4, $5, 'S', '2026-01-01', '2026-12-31', $6)`, values: [c, x.l, x.p, c === A ? d.A.tpl : d.B.tpl, `ISO-${unik()}`, u1] };
      }, false],
      ['contract_documents', (c) => ({ text: `INSERT INTO contract_documents (company_id, contract_id, version_no, object_key, original_filename, mime_type, size_bytes, sha256, status, uploaded_by, verified_by, verified_at, reject_reason) VALUES ($1, $2, 1, $3, 's.pdf', 'application/pdf', 10, $4, 'DITOLAK', $5, $6, now(), 'uji')`, values: [c, c === A ? d.A.kontrak : d.B.kontrak, `${c}/${randomUUID()}`, hash(), u1, u2] }), false],
      ['contract_versions', (c) => ({ text: `INSERT INTO contract_versions (company_id, contract_id, version_no, contract_number, position, start_date, end_date, template_id, template_version, created_by) VALUES ($1, $2, $3, 'N', 'P', '2026-01-01', '2026-12-31', $4, 1, $5)`, values: [c, c === A ? d.A.kontrak : d.B.kontrak, Math.floor(Math.random() * 1e6) + 10, c === A ? d.A.tpl : d.B.tpl, u1] }), true],
      ['placements', (c) => ({ text: `WITH p AS (INSERT INTO persons (display_name) VALUES ('S') RETURNING id) INSERT INTO placements (company_id, person_id, location_id, start_date, end_date, created_by) SELECT $1::uuid, p.id, $2::uuid, '2026-01-01', '2026-12-31', $3::uuid FROM p`, values: [c, c === A ? d.A.lokasi : d.B.lokasi, u1] }), false],
    ];
    it.each(TABEL.map(([t]) => t))('%s: scope A tidak menyentuh baris B; RLS dimatikan => kebocoran terdeteksi', async (tabel) => {
      const [, sisip, hanyaTambah] = TABEL.find(([t]) => t === tabel)!;
      const buat = (id: string) => dalamScope(pool, [id], async (c) => (await c.query(`${sisip(id).text} RETURNING id`, sisip(id).values)).rows[0].id as string, { commit: true });
      const k: KonfigKebocoran = { tabel, companyA: A, companyB: B, idBarisA: await buat(A), idBarisB: await buat(B), sisipUntuk: (id) => sisip(id) };
      // Template terverifikasi dan versi bersifat terkunci/hanya-tambah oleh trigger: UPDATE/DELETE ditolak trigger, bukan RLS.
      const saring = (l: string[]) => l.filter((x) => !(hanyaTambah && /UPDATE|DELETE/.test(x)));
      expect(saring(await cekKebocoran(pool, k))).toEqual([]);
      await pool.query(`ALTER TABLE ${tabel} DISABLE ROW LEVEL SECURITY`);
      try {
        expect(saring(await cekKebocoran(pool, k))).toEqual(expect.arrayContaining(['SELECT massal melihat baris perusahaan lain', 'SELECT per ID melihat baris perusahaan lain', 'INSERT menulis baris untuk perusahaan lain', 'Tanpa scope tetap melihat baris']));
      } finally {
        await pool.query(`ALTER TABLE ${tabel} ENABLE ROW LEVEL SECURITY`);
      }
      expect(saring(await cekKebocoran(pool, k))).toEqual([]);
    });

    it('contract_number_counters: terisolasi per perusahaan; RLS dimatikan => terdeteksi', async () => {
      await dalamScope(pool, [A], async (c) => void (await c.query(`INSERT INTO contract_number_counters (company_id, year, last_value) VALUES ($1, 2099, 1) ON CONFLICT DO NOTHING`, [A])), { commit: true });
      await dalamScope(pool, [B], async (c) => void (await c.query(`INSERT INTO contract_number_counters (company_id, year, last_value) VALUES ($1, 2099, 1) ON CONFLICT DO NOTHING`, [B])), { commit: true });
      const lihat = () => dalamScope(pool, [A], async (c) => (await c.query(`SELECT company_id FROM contract_number_counters`)).rows.map((r) => r.company_id as string));
      expect(await lihat()).not.toContain(B);
      await dalamScope(pool, [A], async (c) => {
        await harusGagal(c, `INSERT INTO contract_number_counters (company_id, year, last_value) VALUES ($1, 2098, 1)`, [B], /row-level security/);
        expect((await c.query(`UPDATE contract_number_counters SET last_value = 99 WHERE company_id = $1`, [B])).rowCount).toBe(0);
      });
      await pool.query(`ALTER TABLE contract_number_counters DISABLE ROW LEVEL SECURITY`);
      try {
        expect(await lihat()).toContain(B);
      } finally {
        await pool.query(`ALTER TABLE contract_number_counters ENABLE ROW LEVEL SECURITY`);
      }
    });
  });

  describe('akses member ke kontrak dan penempatan miliknya', () => {
    it('member hanya membaca kontrak/penempatan/lokasi yang terkait dirinya; tidak dapat menulis', async () => {
      const pm = await buatPerson();
      const ids = await dalamScope(pool, [A], async (c) => {
        const v = (await c.query(`INSERT INTO job_vacancies (company_id, title, description, created_by) VALUES ($1, 'L', 'D', $2) RETURNING id`, [A, u1])).rows[0].id;
        const l = (await c.query(`INSERT INTO job_applications (company_id, vacancy_id, person_id, status) VALUES ($1, $2, $3, 'MENUNGGU_PKWT') RETURNING id`, [A, v, pm])).rows[0].id;
        const k = (await c.query(`INSERT INTO employment_contracts (company_id, application_id, person_id, template_id, contract_number, position, start_date, end_date, created_by) VALUES ($1, $2, $3, $4, $5, 'S', '2026-01-01', '2026-12-31', $6) RETURNING id`, [A, l, pm, d.A.tpl, `M-${unik()}`, u1])).rows[0].id;
        const pr = (await c.query(`INSERT INTO partners (company_id, name, created_by) VALUES ($1, $2, $3) RETURNING id`, [A, `Rek ${unik()}`, u1])).rows[0].id;
        const lokSendiri = (await c.query(`INSERT INTO partner_locations (company_id, partner_id, name, created_by) VALUES ($1, $2, 'Lokasi Saya', $3) RETURNING id`, [A, pr, u1])).rows[0].id;
        const pen = (await c.query(`INSERT INTO placements (company_id, person_id, location_id, start_date, end_date, created_by) VALUES ($1, $2, $3, '2026-01-01', '2026-12-31', $4) RETURNING id`, [A, pm, lokSendiri, u1])).rows[0].id;
        return { k, pen, lokSendiri };
      }, { commit: true });
      await dalamScope(pool, [], async (c) => {
        expect((await c.query(`SELECT id FROM employment_contracts`)).rows.map((r) => r.id)).toEqual([ids.k]);
        expect((await c.query(`SELECT id FROM placements`)).rows.map((r) => r.id)).toEqual([ids.pen]);
        expect((await c.query(`SELECT id FROM partner_locations`)).rows.map((r) => r.id)).toEqual([ids.lokSendiri]); // hanya lokasi penempatannya
        expect((await c.query(`SELECT id FROM contract_templates`)).rowCount).toBe(0);
        expect((await c.query(`SELECT id FROM contract_documents`)).rowCount).toBe(0);
        await harusGagal(c, `INSERT INTO placements (company_id, person_id, location_id, start_date, end_date, created_by) VALUES ($1, $2, $3, '2030-01-01', '2030-02-01', $4)`, [A, pm, ids.lokSendiri, u1], /row-level security/);
        expect((await c.query(`UPDATE employment_contracts SET position = 'Direktur' WHERE id = $1`, [ids.k])).rowCount).toBe(0);
      }, { memberPersonId: pm });
      // orang lain tidak melihat milik pm
      await dalamScope(pool, [], async (c) => expect((await c.query(`SELECT id FROM employment_contracts`)).rowCount).toBe(0), { memberPersonId: await buatPerson() });
    });
  });
});
