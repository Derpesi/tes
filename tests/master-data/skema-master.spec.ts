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

ada('master data: invarian skema dan isolasi RLS pada semua tabel tenant', () => {
  let pool: Pool;
  let userId: string;
  const induk = { A: { partner: '', lokasi: '', kontrak: '' }, B: { partner: '', lokasi: '', kontrak: '' } };

  beforeAll(async () => {
    migrasiNaik();
    pool = bukaPool();
    await siapkanRoleUji(pool);
    await pool.query(`GRANT ALL ON ALL TABLES IN SCHEMA public TO ${ROLE_UJI}`);
    for (const [id, nama] of [[A, 'PT SINTETIS A'], [B, 'PT SINTETIS B']]) {
      await pool.query(`INSERT INTO companies (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [id, nama]);
    }
    const p = await pool.query(`INSERT INTO persons (display_name) VALUES ('SINTETIS') RETURNING id`);
    userId = (await pool.query(`INSERT INTO users (person_id, realm, email, status) VALUES ($1, 'staff', $2, 'AKTIF') RETURNING id`, [p.rows[0].id, `master-${unik()}@contoh.invalid`])).rows[0].id;
    for (const [kode, id] of [['A', A], ['B', B]] as const) {
      await dalamScope(pool, [id], async (c) => {
        const pr = await c.query(`INSERT INTO partners (company_id, name, created_by) VALUES ($1, $2, $3) RETURNING id`, [id, `SINTETIS Rekanan ${kode} ${unik()}`, userId]);
        induk[kode].partner = pr.rows[0].id;
        const lk = await c.query(`INSERT INTO partner_locations (company_id, partner_id, name, created_by) VALUES ($1, $2, 'Lokasi 1', $3) RETURNING id`, [id, pr.rows[0].id, userId]);
        induk[kode].lokasi = lk.rows[0].id;
        const kn = await c.query(`INSERT INTO partner_contracts (company_id, partner_id, contract_number, service_type, start_date, end_date, created_by) VALUES ($1, $2, $3, 'Cleaning', '2026-01-01', '2026-12-31', $4) RETURNING id`, [id, pr.rows[0].id, `K-${unik()}`, userId]);
        induk[kode].kontrak = kn.rows[0].id;
      }, { commit: true });
    }
  });
  afterAll(async () => {
    await pool.end();
  });

  const dalamTransaksi = async (fn: (c: PoolClient) => Promise<void>) =>
    dalamScope(pool, [A, B], async (c) => fn(c)); // selalu ROLLBACK

  // ---------- invarian ----------
  describe('invarian dijaga database', () => {
    it('anak tidak dapat memakai company_id berbeda dari induknya (FK komposit)', () =>
      dalamTransaksi(async (c) => {
        await harusGagal(c, `INSERT INTO partner_locations (company_id, partner_id, name, created_by) VALUES ($1, $2, 'Salah', $3)`, [B, induk.A.partner, userId], /foreign key/);
        await harusGagal(c, `INSERT INTO partner_contacts (company_id, partner_id, name) VALUES ($1, $2, 'Salah')`, [B, induk.A.partner], /foreign key/);
        await harusGagal(c, `INSERT INTO partner_contracts (company_id, partner_id, contract_number, service_type, start_date, end_date, created_by) VALUES ($1, $2, 'X', 'S', '2026-01-01', '2026-02-01', $3)`, [B, induk.A.partner, userId], /foreign key/);
        await harusGagal(c, `INSERT INTO manpower_requirements (company_id, location_id, position, headcount, valid_from, created_by) VALUES ($1, $2, 'P', 1, '2026-01-01', $3)`, [B, induk.A.lokasi, userId], /foreign key/);
        await harusGagal(c, `INSERT INTO partner_contract_documents (company_id, contract_id, title, object_key, original_filename, mime_type, size_bytes, sha256, uploaded_by) VALUES ($1, $2, 't', $3, 'a.pdf', 'application/pdf', 10, $4, $5)`, [B, induk.A.kontrak, `${B}/${randomUUID()}`, hash(), userId], /foreign key/);
      }));

    it('lokasi: koordinat harus lengkap dan dalam rentang; radius 20–1000 m', () =>
      dalamTransaksi(async (c) => {
        const sisip = (lat: unknown, lng: unknown, r: number) => c.query(`INSERT INTO partner_locations (company_id, partner_id, name, latitude, longitude, geofence_radius_m, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [A, induk.A.partner, `L-${unik()}`, lat, lng, r, userId]);
        await expect(sisip(-6.2, 106.8, 100)).resolves.toBeDefined();
        await expect(sisip(null, null, 100)).resolves.toBeDefined();
        await harusGagal(c, `INSERT INTO partner_locations (company_id, partner_id, name, latitude, created_by) VALUES ($1, $2, 'x', -6.2, $3)`, [A, induk.A.partner, userId], /koordinat_lengkap/);
        await harusGagal(c, `INSERT INTO partner_locations (company_id, partner_id, name, latitude, longitude, created_by) VALUES ($1, $2, 'y', 91, 106, $3)`, [A, induk.A.partner, userId], /latitude_check/);
        await harusGagal(c, `INSERT INTO partner_locations (company_id, partner_id, name, latitude, longitude, created_by) VALUES ($1, $2, 'z', -6, 181, $3)`, [A, induk.A.partner, userId], /longitude_check/);
        await harusGagal(c, `INSERT INTO partner_locations (company_id, partner_id, name, geofence_radius_m, created_by) VALUES ($1, $2, 'r1', 19, $3)`, [A, induk.A.partner, userId], /geofence_radius_m_check/);
        await harusGagal(c, `INSERT INTO partner_locations (company_id, partner_id, name, geofence_radius_m, created_by) VALUES ($1, $2, 'r2', 1001, $3)`, [A, induk.A.partner, userId], /geofence_radius_m_check/);
      }));

    it('kontrak: periode valid, nomor unik per perusahaan (boleh sama lintas perusahaan), aktif wajib disetujui, penyetuju bukan pembuat', () =>
      dalamTransaksi(async (c) => {
        const baru = (company: string, partner: string, nomor: string, status = 'DRAFT', mulai = '2026-01-01', akhir = '2026-12-31', setuju: string | null = null) =>
          c.query(`INSERT INTO partner_contracts (company_id, partner_id, contract_number, service_type, start_date, end_date, status, created_by, approved_by, approved_at) VALUES ($1, $2, $3, 'Security', $4, $5, $6, $7, $8, CASE WHEN $8::uuid IS NULL THEN NULL ELSE now() END)`, [company, partner, nomor, mulai, akhir, status, userId, setuju]);
        const nomor = `N-${unik()}`;
        await baru(A, induk.A.partner, nomor);
        await harusGagal(c, `INSERT INTO partner_contracts (company_id, partner_id, contract_number, service_type, start_date, end_date, created_by) VALUES ($1, $2, $3, 'S', '2026-01-01', '2026-02-01', $4)`, [A, induk.A.partner, nomor, userId], /partner_contracts_nomor_unik/);
        await expect(baru(B, induk.B.partner, nomor)).resolves.toBeDefined(); // nomor sama di perusahaan lain: boleh
        await harusGagal(c, `INSERT INTO partner_contracts (company_id, partner_id, contract_number, service_type, start_date, end_date, created_by) VALUES ($1, $2, 'P', 'S', '2026-05-01', '2026-04-01', $3)`, [A, induk.A.partner, userId], /partner_contracts_periode/);
        await harusGagal(c, `INSERT INTO partner_contracts (company_id, partner_id, contract_number, service_type, start_date, end_date, status, created_by) VALUES ($1, $2, 'AK', 'S', '2026-01-01', '2026-02-01', 'AKTIF', $3)`, [A, induk.A.partner, userId], /aktif_wajib_disetujui/);
        await harusGagal(c, `INSERT INTO partner_contracts (company_id, partner_id, contract_number, service_type, start_date, end_date, status, created_by, approved_by, approved_at) VALUES ($1, $2, 'SD', 'S', '2026-01-01', '2026-02-01', 'AKTIF', $3, $3, now())`, [A, induk.A.partner, userId], /penyetuju_bukan_pembuat/);
      }));

    it('rekanan: nama aktif unik per perusahaan (huruf besar/kecil diabaikan); nonaktif boleh dipakai ulang', () =>
      dalamTransaksi(async (c) => {
        const nama = `Rekanan ${unik()}`;
        await c.query(`INSERT INTO partners (company_id, name, created_by) VALUES ($1, $2, $3)`, [A, nama, userId]);
        await harusGagal(c, `INSERT INTO partners (company_id, name, created_by) VALUES ($1, $2, $3)`, [A, nama.toUpperCase(), userId], /partners_nama_aktif_unik/);
        await expect(c.query(`INSERT INTO partners (company_id, name, created_by) VALUES ($1, $2, $3)`, [B, nama, userId])).resolves.toBeDefined();
        await c.query(`UPDATE partners SET status = 'NONAKTIF' WHERE company_id = $1 AND lower(name) = lower($2)`, [A, nama]);
        await expect(c.query(`INSERT INTO partners (company_id, name, created_by) VALUES ($1, $2, $3)`, [A, nama, userId])).resolves.toBeDefined();
      }));

    it('dokumen: hanya PDF/PNG/JPEG, ukuran 1 B–10 MB, SHA-256 32 byte, kunci objek unik', () =>
      dalamTransaksi(async (c) => {
        const dok = (mime: string, ukuran: number, sha: Buffer, kunci = `${A}/${randomUUID()}`) =>
          c.query(`INSERT INTO company_documents (company_id, kind, title, object_key, original_filename, mime_type, size_bytes, sha256, uploaded_by) VALUES ($1, 'NIB', 'NIB', $2, 'a.pdf', $3, $4, $5, $6)`, [A, kunci, mime, ukuran, sha, userId]);
        const kunci = `${A}/${randomUUID()}`;
        await dok('application/pdf', 10, hash(), kunci);
        await harusGagal(c, `INSERT INTO company_documents (company_id, kind, title, object_key, original_filename, mime_type, size_bytes, sha256, uploaded_by) VALUES ($1, 'NIB', 'x', $2, 'a.pdf', 'application/pdf', 10, $3, $4)`, [A, kunci, hash(), userId], /object_key_key/);
        await harusGagal(c, `INSERT INTO company_documents (company_id, kind, title, object_key, original_filename, mime_type, size_bytes, sha256, uploaded_by) VALUES ($1, 'NIB', 'x', $2, 'a.exe', 'application/x-msdownload', 10, $3, $4)`, [A, `${A}/${randomUUID()}`, hash(), userId], /mime_type_check/);
        await harusGagal(c, `INSERT INTO company_documents (company_id, kind, title, object_key, original_filename, mime_type, size_bytes, sha256, uploaded_by) VALUES ($1, 'NIB', 'x', $2, 'a.pdf', 'application/pdf', 10485761, $3, $4)`, [A, `${A}/${randomUUID()}`, hash(), userId], /size_bytes_check/);
        await harusGagal(c, `INSERT INTO company_documents (company_id, kind, title, object_key, original_filename, mime_type, size_bytes, sha256, uploaded_by) VALUES ($1, 'NIB', 'x', $2, 'a.pdf', 'application/pdf', 0, $3, $4)`, [A, `${A}/${randomUUID()}`, hash(), userId], /size_bytes_check/);
        await harusGagal(c, `INSERT INTO company_documents (company_id, kind, title, object_key, original_filename, mime_type, size_bytes, sha256, uploaded_by) VALUES ($1, 'NIB', 'x', $2, 'a.pdf', 'application/pdf', 10, '\\x00', $3)`, [A, `${A}/${randomUUID()}`, userId], /sha256_check/);
      }));

    it('kebutuhan tenaga: headcount 0–100000 dan periode valid; perusahaan: kode singkat/NPWP/email berformat', () =>
      dalamTransaksi(async (c) => {
        await c.query(`INSERT INTO manpower_requirements (company_id, location_id, position, headcount, valid_from, created_by) VALUES ($1, $2, 'Satpam', 5, '2026-01-01', $3)`, [A, induk.A.lokasi, userId]);
        await harusGagal(c, `INSERT INTO manpower_requirements (company_id, location_id, position, headcount, valid_from, created_by) VALUES ($1, $2, 'P', -1, '2026-01-01', $3)`, [A, induk.A.lokasi, userId], /headcount_check/);
        await harusGagal(c, `INSERT INTO manpower_requirements (company_id, location_id, position, headcount, valid_from, valid_to, created_by) VALUES ($1, $2, 'P', 1, '2026-02-01', '2026-01-01', $3)`, [A, induk.A.lokasi, userId], /periode/);
        await harusGagal(c, `INSERT INTO companies (name, short_code) VALUES ('X', 'kecil')`, [], /short_code_format/);
        await harusGagal(c, `INSERT INTO companies (name, short_code, npwp) VALUES ('X', 'XX1', '123')`, [], /npwp_format/);
        await harusGagal(c, `INSERT INTO companies (name, short_code, email) VALUES ('X', 'XX2', 'Besar@Contoh.Invalid')`, [], /email_format/);
      }));

    it('aktivasi perusahaan: approval_requests menerima subjek perusahaan, tepat satu subjek', async () => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const co = (await c.query(`INSERT INTO companies (name, active) VALUES ('PT SINTETIS BARU', false) RETURNING id`)).rows[0].id;
        await c.query(`INSERT INTO approval_requests (type, requested_by, subject_company_id, expires_at) VALUES ('AKTIVASI_PERUSAHAAN', $1, $2, now() + interval '1 day')`, [userId, co]);
        await harusGagal(c, `INSERT INTO approval_requests (type, requested_by, subject_user_id, subject_company_id, expires_at) VALUES ('AKTIVASI_PERUSAHAAN', $1, $1, $2, now() + interval '1 day')`, [userId, co], /subjek_tepat_satu/);
        await harusGagal(c, `INSERT INTO approval_requests (type, requested_by, expires_at) VALUES ('AKTIVASI_PERUSAHAAN', $1, now() + interval '1 day')`, [userId], /subjek_tepat_satu/);
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
    });
  });

  // ---------- isolasi RLS untuk semua tabel tenant baru ----------
  describe('isolasi RLS (dan bukti tes efektif bila RLS dimatikan)', () => {
    const konfig = async (tabel: string, sisip: (companyId: string, p: typeof induk.A) => { text: string; values: unknown[] }): Promise<KonfigKebocoran> => {
      const buat = (id: string, p: typeof induk.A) => dalamScope(pool, [id], async (c) => (await c.query(`${sisip(id, p).text} RETURNING id`, sisip(id, p).values)).rows[0].id as string, { commit: true });
      return {
        tabel, companyA: A, companyB: B,
        idBarisA: await buat(A, induk.A), idBarisB: await buat(B, induk.B),
        sisipUntuk: (companyId) => sisip(companyId, companyId === A ? induk.A : induk.B),
      };
    };
    const TABEL: [string, (c: string, p: typeof induk.A) => { text: string; values: unknown[] }][] = [
      ['partners', (c) => ({ text: `INSERT INTO partners (company_id, name, created_by) VALUES ($1, $2, $3)`, values: [c, `Iso ${unik()}`, userId] })],
      ['partner_contacts', (c, p) => ({ text: `INSERT INTO partner_contacts (company_id, partner_id, name) VALUES ($1, $2, $3)`, values: [c, p.partner, `Kontak ${unik()}`] })],
      ['partner_locations', (c, p) => ({ text: `INSERT INTO partner_locations (company_id, partner_id, name, created_by) VALUES ($1, $2, $3, $4)`, values: [c, p.partner, `Lok ${unik()}`, userId] })],
      ['partner_contracts', (c, p) => ({ text: `INSERT INTO partner_contracts (company_id, partner_id, contract_number, service_type, start_date, end_date, created_by) VALUES ($1, $2, $3, 'S', '2026-01-01', '2026-12-31', $4)`, values: [c, p.partner, `ISO-${unik()}`, userId] })],
      ['partner_contract_documents', (c, p) => ({ text: `INSERT INTO partner_contract_documents (company_id, contract_id, title, object_key, original_filename, mime_type, size_bytes, sha256, uploaded_by) VALUES ($1, $2, 't', $3, 'a.pdf', 'application/pdf', 10, $4, $5)`, values: [c, p.kontrak, `${c}/${randomUUID()}`, hash(), userId] })],
      ['manpower_requirements', (c, p) => ({ text: `INSERT INTO manpower_requirements (company_id, location_id, position, headcount, valid_from, created_by) VALUES ($1, $2, $3, 1, '2026-01-01', $4)`, values: [c, p.lokasi, `Pos ${unik()}`, userId] })],
      ['company_documents', (c) => ({ text: `INSERT INTO company_documents (company_id, kind, title, object_key, original_filename, mime_type, size_bytes, sha256, uploaded_by) VALUES ($1, 'NIB', 't', $2, 'a.pdf', 'application/pdf', 10, $3, $4)`, values: [c, `${c}/${randomUUID()}`, hash(), userId] })],
    ];

    it.each(TABEL.map(([t]) => t))('%s: scope A tidak menyentuh baris B; RLS dimatikan => kebocoran terdeteksi', async (tabel) => {
      const [, sisip] = TABEL.find(([t]) => t === tabel)!;
      const k = await konfig(tabel, sisip);
      expect(await cekKebocoran(pool, k)).toEqual([]);
      await pool.query(`ALTER TABLE ${tabel} DISABLE ROW LEVEL SECURITY`);
      try {
        const bocor = await cekKebocoran(pool, k);
        expect(bocor).toEqual(expect.arrayContaining(['SELECT massal melihat baris perusahaan lain', 'SELECT per ID melihat baris perusahaan lain', 'INSERT menulis baris untuk perusahaan lain', 'Tanpa scope tetap melihat baris']));
      } finally {
        await pool.query(`ALTER TABLE ${tabel} ENABLE ROW LEVEL SECURITY`);
      }
      expect(await cekKebocoran(pool, k)).toEqual([]); // pulih
    });
  });
});
