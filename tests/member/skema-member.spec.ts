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
const bytes = () => randomBytes(40);

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

ada('member dan lowongan: invarian skema dan isolasi RLS', () => {
  let pool: Pool;
  let userId: string;
  let person1: string;
  let person2: string;
  const lowongan = { A: { dibuka: '', draft: '', ditutup: '', kedaluwarsa: '' }, B: { dibuka: '', draft: '', ditutup: '', kedaluwarsa: '' } };
  const lamaran = { A: '', B: '' };

  const buatPerson = async () => (await pool.query(`INSERT INTO persons (display_name) VALUES ('SINTETIS Member') RETURNING id`)).rows[0].id as string;
  const sisipLowongan = (company: string, status: string, closes: string | null, judul = `Lowongan ${unik()}`) => ({
    text: `INSERT INTO job_vacancies (company_id, title, description, status, closes_on, internal_notes, created_by) VALUES ($1, $2, 'Deskripsi sintetis', $3, $4, 'CATATAN-INTERNAL', $5)`,
    values: [company, judul, status, closes, userId],
  });

  beforeAll(async () => {
    migrasiNaik();
    pool = bukaPool();
    await siapkanRoleUji(pool);
    await pool.query(`GRANT ALL ON ALL TABLES IN SCHEMA public TO ${ROLE_UJI}`);
    for (const [id, nama] of [[A, 'PT SINTETIS A'], [B, 'PT SINTETIS B']]) {
      await pool.query(`INSERT INTO companies (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [id, nama]);
    }
    const p = await buatPerson();
    userId = (await pool.query(`INSERT INTO users (person_id, realm, email, status) VALUES ($1, 'staff', $2, 'AKTIF') RETURNING id`, [p, `member-${unik()}@contoh.invalid`])).rows[0].id;
    person1 = await buatPerson();
    person2 = await buatPerson();
    for (const [kode, id] of [['A', A], ['B', B]] as const) {
      await dalamScope(pool, [id], async (c) => {
        for (const [nama, status, closes] of [['dibuka', 'DIBUKA', null], ['draft', 'DRAFT', null], ['ditutup', 'DITUTUP', null], ['kedaluwarsa', 'DIBUKA', '2020-01-01']] as const) {
          const q = sisipLowongan(id, status, closes);
          lowongan[kode][nama] = (await c.query(`${q.text} RETURNING id`, q.values)).rows[0].id;
        }
      }, { commit: true });
    }
    for (const [kode, id] of [['A', A], ['B', B]] as const) {
      await dalamScope(pool, [id], async (c) => {
        lamaran[kode] = (await c.query(`INSERT INTO job_applications (company_id, vacancy_id, person_id) VALUES ($1, $2, $3) RETURNING id`, [id, lowongan[kode].dibuka, person2])).rows[0].id;
      }, { commit: true });
    }
  });
  afterAll(async () => {
    await pool.end();
  });

  const dalamTransaksi = async (fn: (c: PoolClient) => Promise<void>) => dalamScope(pool, [A, B], async (c) => fn(c));

  describe('invarian dijaga database', () => {
    it('profil: satu per person, status sah, NIK ber-blind-index unik, biodata wajib lengkap setelah diajukan', async () => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const p = (await c.query(`INSERT INTO persons (display_name) VALUES ('SINTETIS') RETURNING id`)).rows[0].id;
        await c.query(`INSERT INTO member_profiles (person_id) VALUES ($1)`, [p]);
        await harusGagal(c, `INSERT INTO member_profiles (person_id) VALUES ($1)`, [p], /member_profiles_person_id_key/);
        const p2 = (await c.query(`INSERT INTO persons (display_name) VALUES ('SINTETIS 2') RETURNING id`)).rows[0].id;
        await harusGagal(c, `INSERT INTO member_profiles (person_id, status) VALUES ($1, 'ASAL')`, [p2], /status_check|lengkap_saat_diajukan/);
        await harusGagal(c, `INSERT INTO member_profiles (person_id, status) VALUES ($1, 'MENUNGGU_VERIFIKASI')`, [p2], /lengkap_saat_diajukan/);
        await harusGagal(c, `UPDATE member_profiles SET nik_hmac = '\\x00' WHERE person_id = $1`, [p], /nik_hmac_check/);
        const nik = hash();
        await c.query(`UPDATE member_profiles SET nik_enc = $2, nik_hmac = $3 WHERE person_id = $1`, [p, bytes(), nik]);
        await c.query(`INSERT INTO member_profiles (person_id, nik_enc, nik_hmac) VALUES ($1, $2, $3)`, [p2, bytes(), hash()]);
        await harusGagal(c, `UPDATE member_profiles SET nik_hmac = $2 WHERE person_id = $1`, [p2, nik], /nik_hmac_key/);
        await harusGagal(c, `UPDATE member_profiles SET phone = 'abc' WHERE person_id = $1`, [p], /phone_check/);
        await harusGagal(c, `UPDATE member_profiles SET gender = 'X' WHERE person_id = $1`, [p], /gender_check/);
        await harusGagal(c, `UPDATE member_profiles SET birth_date = current_date + 1 WHERE person_id = $1`, [p], /birth_date_check/);
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
    });

    it('status terverifikasi wajib punya pemeriksa dan waktu verifikasi', async () => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const p = (await c.query(`INSERT INTO persons (display_name) VALUES ('SINTETIS') RETURNING id`)).rows[0].id;
        const lengkap = `full_name='N', nik_enc=$2, nik_hmac=$3, birth_place='K', birth_date='1990-01-01', gender='L', address='A', city='C', province='P', phone='08123456', education='SMA', emergency_contact_name='E', emergency_contact_phone='08123457'`;
        await c.query(`INSERT INTO member_profiles (person_id) VALUES ($1)`, [p]);
        await c.query(`UPDATE member_profiles SET ${lengkap}, status = 'MENUNGGU_VERIFIKASI' WHERE person_id = $1`, [p, bytes(), hash()]);
        await harusGagal(c, `UPDATE member_profiles SET status = 'TERVERIFIKASI' WHERE person_id = $1`, [p], /terverifikasi_punya_pemeriksa/);
        await expect(c.query(`UPDATE member_profiles SET status = 'TERVERIFIKASI', verified_by = $2, verified_at = now() WHERE person_id = $1`, [p, userId])).resolves.toBeDefined();
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
    });

    it('dokumen member: jenis/mime/ukuran/sha sah, kunci objek unik, satu KTP aktif (ganti = hapus lalu unggah)', async () => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const dok = (kind: string, mime = 'application/pdf', ukuran = 10, kunci = `${person1}/${randomUUID()}`, status = 'AKTIF') =>
          c.query(`INSERT INTO member_documents (person_id, kind, object_key, original_filename, mime_type, size_bytes, sha256, status) VALUES ($1, $2, $3, 'a.pdf', $4, $5, $6, $7)`, [person1, kind, kunci, mime, ukuran, hash(), status]);
        await dok('KTP');
        await harusGagal(c, `INSERT INTO member_documents (person_id, kind, object_key, original_filename, mime_type, size_bytes, sha256) VALUES ($1, 'KTP', $2, 'b.pdf', 'application/pdf', 10, $3)`, [person1, `${person1}/${randomUUID()}`, hash()], /satu_aktif/);
        await expect(dok('KTP', 'application/pdf', 10, `${person1}/${randomUUID()}`, 'DIHAPUS')).resolves.toBeDefined();
        await expect(dok('IJAZAH')).resolves.toBeDefined();
        await expect(dok('IJAZAH')).resolves.toBeDefined(); // ijazah boleh banyak
        await harusGagal(c, `INSERT INTO member_documents (person_id, kind, object_key, original_filename, mime_type, size_bytes, sha256) VALUES ($1, 'SELFIE', $2, 'b.pdf', 'application/pdf', 10, $3)`, [person1, `${person1}/${randomUUID()}`, hash()], /kind_check/);
        await harusGagal(c, `INSERT INTO member_documents (person_id, kind, object_key, original_filename, mime_type, size_bytes, sha256) VALUES ($1, 'LAINNYA', $2, 'b.exe', 'application/x-msdownload', 10, $3)`, [person1, `${person1}/${randomUUID()}`, hash()], /mime_type_check/);
        await harusGagal(c, `INSERT INTO member_documents (person_id, kind, object_key, original_filename, mime_type, size_bytes, sha256) VALUES ($1, 'LAINNYA', $2, 'b.pdf', 'application/pdf', 10485761, $3)`, [person1, `${person1}/${randomUUID()}`, hash()], /size_bytes_check/);
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
    });

    it('riwayat status member dan lamaran bersifat hanya-tambah', async () => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const h = (await c.query(`INSERT INTO member_status_histories (person_id, from_status, to_status, actor_user_id) VALUES ($1, 'TERDAFTAR', 'PROFIL_BELUM_LENGKAP', $2) RETURNING id`, [person1, userId])).rows[0].id;
        await harusGagal(c, `UPDATE member_status_histories SET to_status = 'X' WHERE id = $1`, [h], /hanya-tambah/);
        await harusGagal(c, `DELETE FROM member_status_histories WHERE id = $1`, [h], /hanya-tambah/);
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
      await dalamTransaksi(async (c) => {
        const h = (await c.query(`INSERT INTO application_status_histories (company_id, application_id, from_status, to_status, actor_user_id) VALUES ($1, $2, NULL, 'DIAJUKAN', $3) RETURNING id`, [A, lamaran.A, userId])).rows[0].id;
        await harusGagal(c, `UPDATE application_status_histories SET to_status = 'X' WHERE id = $1`, [h], /hanya-tambah/);
        await harusGagal(c, `DELETE FROM application_status_histories WHERE id = $1`, [h], /hanya-tambah/);
      });
    });

    it('lowongan/lamaran: FK komposit mencegah company_id berbeda; satu lamaran aktif per orang per lowongan; tarik boleh melamar ulang', () =>
      dalamTransaksi(async (c) => {
        await harusGagal(c, `INSERT INTO job_applications (company_id, vacancy_id, person_id) VALUES ($1, $2, $3)`, [B, lowongan.A.dibuka, person1], /foreign key/);
        await harusGagal(c, `INSERT INTO application_status_histories (company_id, application_id, to_status, actor_user_id) VALUES ($1, $2, 'DIAJUKAN', $3)`, [B, lamaran.A, userId], /foreign key/);
        await harusGagal(c, `INSERT INTO job_applications (company_id, vacancy_id, person_id) VALUES ($1, $2, $3)`, [A, lowongan.A.dibuka, person2], /satu_per_lowongan/);
        await c.query(`UPDATE job_applications SET status = 'DITARIK' WHERE id = $1`, [lamaran.A]);
        await expect(c.query(`INSERT INTO job_applications (company_id, vacancy_id, person_id) VALUES ($1, $2, $3)`, [A, lowongan.A.dibuka, person2])).resolves.toBeDefined();
        await harusGagal(c, `INSERT INTO job_applications (company_id, vacancy_id, person_id, status) VALUES ($1, $2, $3, 'ASAL')`, [A, lowongan.A.draft, person1], /status_check/);
        await harusGagal(c, `INSERT INTO job_vacancies (company_id, title, description, status, created_by) VALUES ($1, 'x', 'y', 'DIBUKA2', $2)`, [A, userId], /status_check/);
        await harusGagal(c, `INSERT INTO job_vacancies (company_id, title, description, positions, created_by) VALUES ($1, 'x', 'y', 0, $2)`, [A, userId], /positions_check/);
        const lokB = (await c.query(`INSERT INTO partners (company_id, name, created_by) VALUES ($1, $2, $3) RETURNING id`, [B, `Rek ${unik()}`, userId])).rows[0].id;
        const lok = (await c.query(`INSERT INTO partner_locations (company_id, partner_id, name, created_by) VALUES ($1, $2, 'L', $3) RETURNING id`, [B, lokB, userId])).rows[0].id;
        await harusGagal(c, `INSERT INTO job_vacancies (company_id, title, description, location_id, created_by) VALUES ($1, 'x', 'y', $2, $3)`, [A, lok, userId], /foreign key/);
      }));
  });

  describe('isolasi RLS tenant (dan bukti tes efektif bila RLS dimatikan)', () => {
    const TABEL: [string, (c: string) => { text: string; values: unknown[] }][] = [
      ['job_vacancies', (c) => sisipLowongan(c, 'DRAFT', null)],
      // person baru per sisipan agar keunikan (lowongan, orang) tidak menutupi hasil uji
      ['job_applications', (c) => ({ text: `WITH p AS (INSERT INTO persons (display_name) VALUES ('SINTETIS Pelamar') RETURNING id) INSERT INTO job_applications (company_id, vacancy_id, person_id) SELECT $1::uuid, $2::uuid, id FROM p`, values: [c, c === A ? lowongan.A.draft : lowongan.B.draft] })],
      ['application_status_histories', (c) => ({ text: `INSERT INTO application_status_histories (company_id, application_id, to_status, actor_user_id) VALUES ($1, $2, 'DIAJUKAN', $3)`, values: [c, c === A ? lamaran.A : lamaran.B, userId] })],
    ];
    it.each(TABEL.map(([t]) => t))('%s: scope A tidak menyentuh baris B; RLS dimatikan => kebocoran terdeteksi', async (tabel) => {
      const [, sisip] = TABEL.find(([t]) => t === tabel)!;
      const buat = (id: string) => dalamScope(pool, [id], async (c) => (await c.query(`${sisip(id).text} RETURNING id`, sisip(id).values)).rows[0].id as string, { commit: true });
      const k: KonfigKebocoran = { tabel, companyA: A, companyB: B, idBarisA: await buat(A), idBarisB: await buat(B), sisipUntuk: (id) => sisip(id) };
      // riwayat hanya-tambah: UPDATE/DELETE ditolak trigger (bukan RLS), sehingga uji UPDATE/DELETE dilewati pada tabel itu.
      const hanyaBaca = tabel === 'application_status_histories';
      const saring = (l: string[]) => l.filter((x) => !(hanyaBaca && /UPDATE|DELETE/.test(x)));
      const tanpa = tabel === 'application_status_histories' ? [] : [];
      expect(saring(await cekKebocoran(pool, k))).toEqual(tanpa);
      await pool.query(`ALTER TABLE ${tabel} DISABLE ROW LEVEL SECURITY`);
      try {
        const bocor = saring(await cekKebocoran(pool, k));
        expect(bocor).toEqual(expect.arrayContaining(['SELECT massal melihat baris perusahaan lain', 'SELECT per ID melihat baris perusahaan lain', 'INSERT menulis baris untuk perusahaan lain', 'Tanpa scope tetap melihat baris']));
      } finally {
        await pool.query(`ALTER TABLE ${tabel} ENABLE ROW LEVEL SECURITY`);
      }
      expect(saring(await cekKebocoran(pool, k))).toEqual([]);
    });
  });

  describe('akses member lewat RLS', () => {
    it('member membaca hanya lowongan DIBUKA dan belum kedaluwarsa, lintas perusahaan; tanpa flag tidak melihat apa pun', async () => {
      const lihat = await dalamScope(pool, [], async (c) => (await c.query(`SELECT id, status FROM job_vacancies`)).rows as { id: string; status: string }[], { memberRead: true });
      const ids = lihat.map((r) => r.id);
      expect(ids).toEqual(expect.arrayContaining([lowongan.A.dibuka, lowongan.B.dibuka]));
      for (const x of [lowongan.A.draft, lowongan.A.ditutup, lowongan.A.kedaluwarsa, lowongan.B.draft, lowongan.B.ditutup, lowongan.B.kedaluwarsa]) expect(ids).not.toContain(x);
      expect(lihat.every((r) => r.status === 'DIBUKA')).toBe(true);
      const tanpa = await dalamScope(pool, [], async (c) => (await c.query(`SELECT id FROM job_vacancies`)).rowCount);
      expect(tanpa).toBe(0);
      // member tidak dapat menulis lowongan
      await dalamScope(pool, [], async (c) => {
        await harusGagal(c, `INSERT INTO job_vacancies (company_id, title, description, status, created_by) VALUES ($1, 'x', 'y', 'DIBUKA', $2)`, [A, userId], /row-level security/);
        const u = await c.query(`UPDATE job_vacancies SET title = 'diretas' WHERE id = $1`, [lowongan.A.dibuka]);
        expect(u.rowCount).toBe(0);
      }, { memberRead: true });
    });

    it('member hanya melihat lamaran miliknya, melamar hanya atas namanya ke lowongan terbuka, dan hanya dapat menarik', async () => {
      const person1 = await buatPerson(); // person segar: tes tenant di atas sudah memakai person1
      const mine = await dalamScope(pool, [], async (c) => (await c.query(`SELECT id FROM job_applications`)).rows.map((r) => r.id as string), { memberRead: true, memberPersonId: person2 });
      expect(mine).toEqual(expect.arrayContaining([lamaran.A, lamaran.B]));
      const orangLain = await dalamScope(pool, [], async (c) => (await c.query(`SELECT id FROM job_applications`)).rowCount, { memberRead: true, memberPersonId: person1 });
      expect(orangLain).toBe(0);
      await dalamScope(pool, [], async (c) => {
        const baru = `INSERT INTO job_applications (company_id, vacancy_id, person_id) VALUES ($1, $2, $3) RETURNING id`;
        await expect(c.query(baru, [A, lowongan.A.dibuka, person1])).resolves.toBeDefined(); // diri sendiri, lowongan terbuka
        await harusGagal(c, baru, [A, lowongan.A.dibuka, person2], /row-level security/); // atas nama orang lain
        await harusGagal(c, baru, [A, lowongan.A.draft, person1], /row-level security/); // lowongan tidak terlihat (DRAFT)
        await harusGagal(c, baru, [A, lowongan.A.ditutup, person1], /row-level security/);
        await harusGagal(c, baru, [A, lowongan.A.kedaluwarsa, person1], /row-level security/);
        await harusGagal(c, `INSERT INTO job_applications (company_id, vacancy_id, person_id, status) VALUES ($1, $2, $3, 'DITERIMA')`, [B, lowongan.B.dibuka, person1], /row-level security/); // status curang
        // menarik lamaran sendiri boleh; mengubah ke status lain ditolak; milik orang lain tak terjangkau
        await harusGagal(c, `UPDATE job_applications SET status = 'DITERIMA' WHERE person_id = $1`, [person1], /row-level security/);
        const tarik = await c.query(`UPDATE job_applications SET status = 'DITARIK' WHERE person_id = $1`, [person1]);
        expect(tarik.rowCount).toBe(1);
        const orang2 = await c.query(`UPDATE job_applications SET status = 'DITARIK' WHERE person_id = $1`, [person2]);
        expect(orang2.rowCount).toBe(0);
        const hapus = await c.query(`DELETE FROM job_applications WHERE person_id = $1`, [person1]);
        expect(hapus.rowCount).toBe(0); // tidak ada kebijakan DELETE untuk member
      }, { memberRead: true, memberPersonId: person1 });
    });

    it('member tetap membaca lowongan yang pernah dilamar (meski ditutup) tetapi tidak dapat melamar ulang ke lowongan tertutup', async () => {
      const pelamar = await buatPerson();
      const q = sisipLowongan(A, 'DIBUKA', null, `Akan ditutup ${unik()}`);
      const vid = await dalamScope(pool, [A], async (c) => (await c.query(`${q.text} RETURNING id`, q.values)).rows[0].id as string, { commit: true });
      const lid = await dalamScope(pool, [], async (c) => (await c.query(`INSERT INTO job_applications (company_id, vacancy_id, person_id) VALUES ($1, $2, $3) RETURNING id`, [A, vid, pelamar])).rows[0].id as string, { memberRead: true, memberPersonId: pelamar, commit: true });
      await dalamScope(pool, [A], async (c) => void (await c.query(`UPDATE job_vacancies SET status = 'DITUTUP' WHERE id = $1`, [vid])), { commit: true });
      await dalamScope(pool, [], async (c) => {
        expect((await c.query(`SELECT id FROM job_vacancies WHERE id = $1`, [vid])).rowCount).toBe(1); // lowongan yang pernah dilamar tetap terbaca
        expect((await c.query(`SELECT id FROM job_vacancies WHERE id = $1`, [lowongan.A.ditutup])).rowCount).toBe(0); // yang lain tidak
        await c.query(`UPDATE job_applications SET status = 'DITARIK' WHERE id = $1`, [lid]);
        await harusGagal(c, `INSERT INTO job_applications (company_id, vacancy_id, person_id) VALUES ($1, $2, $3)`, [A, vid, pelamar], /row-level security/); // tertutup: tidak boleh melamar ulang
      }, { memberRead: true, memberPersonId: pelamar });
      // orang lain tidak ikut melihat lowongan tertutup itu
      await dalamScope(pool, [], async (c) => expect((await c.query(`SELECT id FROM job_vacancies WHERE id = $1`, [vid])).rowCount).toBe(0), { memberRead: true, memberPersonId: await buatPerson() });
    });

    it('bukti efektif: tanpa kebijakan member_read lowongan tidak terlihat; setelah dilepas kebijakan, tes akan mendeteksinya', async () => {
      await pool.query(`ALTER TABLE job_vacancies DISABLE ROW LEVEL SECURITY`);
      try {
        const bocor = await dalamScope(pool, [], async (c) => (await c.query(`SELECT id FROM job_vacancies WHERE status = 'DRAFT'`)).rowCount);
        expect(bocor).toBeGreaterThan(0); // RLS mati => DRAFT terlihat tanpa scope apa pun (tes di atas akan gagal)
      } finally {
        await pool.query(`ALTER TABLE job_vacancies ENABLE ROW LEVEL SECURITY`);
      }
    });
  });
});
