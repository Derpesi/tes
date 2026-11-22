import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { imporTemplatPkwt } from '../src/ops/impor-templat-pkwt';

/**
 * Alat impor templat PKWT (ADR-0015) pada PostgreSQL asli, skema terisolasi. Wajib role superuser/BYPASSRLS: pada mode non-superuser hanya uji penolakan
 * yang berjalan; uji penuh berjalan di CI dan pada mode superuser lokal.
 */
const DB_URL = process.env.TEST_DATABASE_URL;
const jalan = DB_URL ? describe : describe.skip;
const SKEMA = `impor_${randomBytes(4).toString('hex')}`;
const DOCS = join(__dirname, '../../../docs/templates/pkwt-alih-daya');
const ISI = readFileSync(join(DOCS, 'isi.txt'), 'utf8');
const PENGATURAN_DM = JSON.parse(readFileSync(join(DOCS, 'pengaturan-damarindo-mandiri.json'), 'utf8'));
const NAMA = 'PKWT Alih Daya (uji)';

jalan('Impor templat PKWT (PostgreSQL asli)', () => {
  let adm: Pool;
  let biasa: Pool;
  let bypass = false;
  let staf: string;
  let a: string;
  let b: string;
  let nonaktif: string;

  beforeAll(async () => {
    execFileSync('node', ['scripts/migrate.js', 'up'], { env: { ...process.env, DATABASE_URL: DB_URL, MIGRATE_SCHEMA: SKEMA } });
    const url = (extra: string) => `${DB_URL}${DB_URL!.includes('?') ? '&' : '?'}${extra}`;
    adm = new Pool({ connectionString: url(`options=${encodeURIComponent(`-c search_path=${SKEMA}`)}`), max: 2 });
    bypass = (await adm.query(`SELECT rolsuper OR rolbypassrls AS l FROM pg_roles WHERE rolname = current_user`)).rows[0].l;
    const admin = new Pool({ connectionString: DB_URL, max: 1 });
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hris_app_uji') THEN CREATE ROLE hris_app_uji NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$`);
    await admin.query(`GRANT hris_app_uji TO CURRENT_USER`);
    await admin.end();
    biasa = new Pool({ connectionString: url(`options=${encodeURIComponent('-c role=hris_app_uji')}`), max: 1 });
    if (!bypass) return;
    const p = (await adm.query(`INSERT INTO persons (display_name) VALUES ('SINTETIS Staf Impor') RETURNING id`)).rows[0].id;
    staf = (await adm.query(`INSERT INTO users (person_id, realm, email, status) VALUES ($1, 'staff', $2, 'AKTIF') RETURNING id`, [p, `impor-${randomBytes(4).toString('hex')}@contoh.invalid`])).rows[0].id;
    const co = async (nama: string, aktif: boolean, kode: string) => (await adm.query(`INSERT INTO companies (name, short_code, active) VALUES ($1, $2, $3) RETURNING id`, [nama, kode, aktif])).rows[0].id as string;
    a = await co('PT SINTETIS IMPOR A', true, 'IA');
    b = await co('PT SINTETIS IMPOR B', true, 'IB');
    nonaktif = await co('PT SINTETIS IMPOR NONAKTIF', false, 'IN');
  });
  afterAll(async () => {
    await adm?.query(`DROP SCHEMA IF EXISTS ${SKEMA} CASCADE`).catch(() => undefined);
    await Promise.all([adm?.end(), biasa?.end()]);
  });

  const bila = (nama: string, fn: () => Promise<void>) => it(nama, async () => {
    if (!bypass) return;
    await fn();
  });
  const templat = async (c: string) => (await adm.query(`SELECT version, status, created_by, verified_by, body FROM contract_templates WHERE company_id = $1 AND name = $2 ORDER BY version`, [c, NAMA])).rows;
  const pkwt = async (c: string) => (await adm.query(`SELECT document_settings->'pkwt' AS p FROM companies WHERE id = $1`, [c])).rows[0].p;

  it('role biasa (tanpa BYPASSRLS) DITOLAK', async () => {
    await expect(imporTemplatPkwt({ pool: biasa, isi: ISI, nama: NAMA, oleh: randomUUID() })).rejects.toThrow(/BYPASSRLS/);
  });

  bila('masukan tidak sah ditolak dengan pesan Indonesia: variabel asing, isi kosong/terlalu panjang, nama kosong, pembuat bukan staf, pengaturan tidak valid, perusahaan tak ada', async () => {
    const dasar = { pool: adm, isi: ISI, nama: NAMA, oleh: staf };
    await expect(imporTemplatPkwt({ ...dasar, isi: 'Halo {{gaji_pokok}}' })).rejects.toThrow(/Variabel templat tidak dikenal: gaji_pokok/);
    await expect(imporTemplatPkwt({ ...dasar, isi: '   ' })).rejects.toThrow(/Isi templat kosong/);
    await expect(imporTemplatPkwt({ ...dasar, isi: 'x'.repeat(50001) })).rejects.toThrow(/melebihi 50000/);
    await expect(imporTemplatPkwt({ ...dasar, nama: ' ' })).rejects.toThrow(/Nama templat wajib/);
    await expect(imporTemplatPkwt({ ...dasar, oleh: randomUUID() })).rejects.toThrow(/pengguna staf/);
    await expect(imporTemplatPkwt({ ...dasar, pengaturan: { klausul: 'bebas' } })).rejects.toThrow(/Pengaturan PKWT tidak valid/);
    await expect(imporTemplatPkwt({ ...dasar, perusahaanId: randomUUID() })).rejects.toThrow(/tidak ditemukan/);
    await expect(imporTemplatPkwt({ ...dasar, perusahaanId: nonaktif })).rejects.toThrow(/tidak ditemukan atau tidak aktif/);
    expect((await adm.query(`SELECT count(*)::int n FROM contract_templates`)).rows[0].n).toBe(0);
  });

  bila('percobaan kering: melaporkan rencana tanpa menulis templat, pengaturan, maupun audit', async () => {
    const h = await imporTemplatPkwt({ pool: adm, isi: ISI, nama: NAMA, oleh: staf, pengaturan: PENGATURAN_DM, kering: true });
    expect(h.kering).toBe(true);
    expect(h.perusahaan.map((x) => [x.templat, x.pengaturan])).toEqual([['dibuat', 'diisi'], ['dibuat', 'diisi']]);
    expect(await templat(a)).toEqual([]);
    expect(await pkwt(a)).toBeNull();
    expect((await adm.query(`SELECT count(*)::int n FROM audit_logs WHERE action = 'system.pkwt_template.imported'`)).rows[0].n).toBe(0);
  });

  bila('impor semua perusahaan AKTIF: BELUM_DIVERIFIKASI, pembuat = --oleh, tidak pernah diverifikasi, perusahaan nonaktif dilewati, pengaturan DM terisi, audit tanpa isi templat', async () => {
    const h = await imporTemplatPkwt({ pool: adm, isi: ISI, nama: NAMA, oleh: staf, pengaturan: PENGATURAN_DM });
    expect(h.perusahaan.map((x) => x.id).sort()).toEqual([a, b].sort());
    for (const c of [a, b]) {
      const t = await templat(c);
      expect(t).toHaveLength(1);
      expect(t[0]).toMatchObject({ version: 1, status: 'BELUM_DIVERIFIKASI', created_by: staf, verified_by: null });
      expect(t[0].body).toBe(ISI);
      expect(await pkwt(c)).toMatchObject({ penandatanganNama: 'Yuli Eka Wati', kota: 'Tangerang' });
      expect((await pkwt(c)).legalitas).toHaveLength(5);
    }
    expect(await templat(nonaktif)).toEqual([]);
    const aud = (await adm.query(`SELECT detail::text d, actor_id FROM audit_logs WHERE action = 'system.pkwt_template.imported'`)).rows;
    expect(aud).toHaveLength(2);
    expect(aud.every((x) => x.actor_id === staf && !/PERJANJIAN|Yuli|Akte/.test(x.d))).toBe(true);
  });

  bila('idempoten: ulang tidak menggandakan; isi berbeda menjadi versi 2; pengaturan yang sudah ada tidak ditimpa (dilewati)', async () => {
    await adm.query(`UPDATE companies SET document_settings = jsonb_set(COALESCE(document_settings, '{}'::jsonb), '{pkwt}', '{"kota":"Disunting Pemilik"}'::jsonb) WHERE id = $1`, [a]);
    const ulang = await imporTemplatPkwt({ pool: adm, isi: ISI, nama: NAMA, oleh: staf, pengaturan: PENGATURAN_DM });
    expect(ulang.perusahaan.map((x) => [x.templat, x.versi, x.pengaturan])).toEqual([['sudah-ada', 1, 'dilewati'], ['sudah-ada', 1, 'dilewati']]);
    expect(await templat(a)).toHaveLength(1);
    expect((await pkwt(a)).kota).toBe('Disunting Pemilik');
    const baru = await imporTemplatPkwt({ pool: adm, isi: `${ISI}\nTambahan {{nama}}`, nama: NAMA, oleh: staf, perusahaanId: a });
    expect(baru.perusahaan[0]).toMatchObject({ templat: 'dibuat', versi: 2, pengaturan: 'tidak-diminta' });
    expect((await templat(a)).map((x) => x.version)).toEqual([1, 2]);
    expect(await templat(b)).toHaveLength(1);
  });

  bila('impor serentak untuk perusahaan yang sama tidak menghasilkan versi ganda', async () => {
    const c = (await adm.query(`INSERT INTO companies (name, short_code, active) VALUES ('PT SINTETIS IMPOR C', 'IC', true) RETURNING id`)).rows[0].id as string;
    const hasil = await Promise.allSettled(Array.from({ length: 4 }, () => imporTemplatPkwt({ pool: adm, isi: ISI, nama: NAMA, oleh: staf, perusahaanId: c })));
    expect(hasil.every((h) => h.status === 'fulfilled')).toBe(true);
    expect(await templat(c)).toHaveLength(1);
  });
});
