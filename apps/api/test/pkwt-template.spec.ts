import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { urlAplikasiTanpaBypass } from './helpers/role-app';

const DB_URL = process.env.TEST_DATABASE_URL;
const jalan = DB_URL ? describe : describe.skip;

const ORIGIN = 'https://hris.contoh.invalid';
process.env.APP_BASE_URL = ORIGIN;
process.env.AUTH_HMAC_KEY = randomBytes(32).toString('base64');
process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString('base64');
process.env.TRUST_PROXY = '1';
const STORAGE = mkdtempSync(join(tmpdir(), 'hris-member-'));
process.env.STORAGE_DIR = STORAGE;

interface Sesi { cookie: string; csrf: string; userId: string; personId: string }

// Semua NIK/nama di bawah ini SINTETIS (bukan data pekerja nyata).

jalan('template PKWT dan nomor kontrak otomatis (PostgreSQL asli)', () => {
  let app: INestApplication;
  let pool: Pool;
  let nomorIp = 1;
  let perusahaanA: string;
  let perusahaanB: string;
  let sessions: import('../src/auth/session.service').SessionService;

  beforeAll(async () => {
    execFileSync('node', ['scripts/migrate.js', 'up'], { env: { ...process.env, DATABASE_URL: DB_URL } });
    const { AppModule } = await import('../src/app.module');
    const { konfigurasiApp } = await import('../src/app.factory');
    const { SessionService } = await import('../src/auth/session.service');
    process.env.DATABASE_URL = await urlAplikasiTanpaBypass(DB_URL!);
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    konfigurasiApp(app);
    await app.init();
    sessions = app.get(SessionService);
    pool = new Pool({ connectionString: DB_URL, max: 4 });
    perusahaanA = (await pool.query(`INSERT INTO companies (name) VALUES ($1) RETURNING id`, [`PT SINTETIS A ${randomBytes(3).toString('hex')}`])).rows[0].id;
    perusahaanB = (await pool.query(`INSERT INTO companies (name) VALUES ($1) RETURNING id`, [`PT SINTETIS B ${randomBytes(3).toString('hex')}`])).rows[0].id;
  });
  afterAll(async () => {
    await pool?.end();
    await app?.close();
    fs.rmSync(STORAGE, { recursive: true, force: true });
  });

  const ipBaru = () => `10.50.${Math.floor(nomorIp / 250)}.${(nomorIp++ % 250) + 1}`;
  const http = (metode: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string, s?: Pick<Sesi, 'cookie' | 'csrf'>, o: { origin?: string | null; tanpaCsrf?: boolean } = {}) => {
    let r = request(app.getHttpServer())[metode](path).set('X-Forwarded-For', ipBaru());
    if (o.origin !== null) r = r.set('Origin', o.origin ?? ORIGIN);
    if (s) r = r.set('Cookie', s.cookie);
    if (s && !o.tanpaCsrf) r = r.set('X-CSRF-Token', s.csrf);
    return r;
  };
  const buatStaff = async (role: string, companyIds: string[] = []): Promise<Sesi> => {
    const u = (await pool.query(`INSERT INTO users (realm, email, status) VALUES ('staff', $1, 'AKTIF') RETURNING id`, [`s-${randomBytes(4).toString('hex')}@contoh.invalid`])).rows[0].id as string;
    await pool.query(`INSERT INTO user_roles (user_id, role_code, grant_source) VALUES ($1, $2, 'MANUAL')`, [u, role]);
    for (const c of companyIds) await pool.query(`INSERT INTO user_company_scopes (user_id, scope_company_id) VALUES ($1, $2)`, [u, c]);
    const s = await sessions.buat({ userId: u, realm: 'staff', state: 'PENUH' });
    return { cookie: `__Host-sid=${s.token}`, csrf: s.csrfToken, userId: u, personId: '' };
  };




  /** Query tabel tenant/audit lewat koneksi bersekop (RLS berlaku juga bagi koneksi pemilik). */
  const dalamScopeDb = async <T>(companyIds: string[], fn: (c: import('pg').PoolClient) => Promise<T>): Promise<T> => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.company_ids', $1, true)`, [companyIds.join(',')]);
      await c.query(`SELECT set_config('app.audit_global', 'on', true)`);
      const r = await fn(c);
      await c.query('ROLLBACK');
      return r;
    } finally {
      c.release();
    }
  };
  const auditObjek = (company: string, aksi: string, objekId: string) => dalamScopeDb([company], async (c) => (await c.query(`SELECT company_id FROM audit_logs WHERE action = $1 AND object_id = $2`, [aksi, objekId])).rows as { company_id: string }[]);

  const TPL = 'CONTOH UJI — BUKAN DOKUMEN HUKUM. Nama: {{nama}}; Nomor: {{nomor}}; Jabatan: {{jabatan}}';
  const hrdA = () => buatStaff('HRD', [perusahaanA]);
  const buatTpl = (s: Sesi, o: object = {}) => http('post', '/pkwt/templates', s).send({ name: `Template SINTETIS ${randomBytes(3).toString('hex')}`, body: TPL, ...o });

  it('prasyarat: aplikasi berjalan sebagai role non-superuser tanpa BYPASSRLS (RLS benar-benar berlaku)', async () => {
    const { POOL } = await import('../src/database/tokens');
    const r = await app.get<Pool>(POOL).query(`SELECT current_user AS u, (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass`);
    expect(r.rows[0]).toEqual({ u: 'hris_app_uji', bypass: false });
  });

  describe('template PKWT', () => {
    it('daftar putih variabel; versi otomatis per nama; isi tervalidasi (variabel asing ditolak, pesan Indonesia)', async () => {
      const hrd = await hrdA();
      const v = (await http('get', '/pkwt/templates/variabel', hrd).expect(200)).body.items as string[];
      expect(v).toEqual(expect.arrayContaining(['nama', 'nik', 'nomor', 'jabatan']));
      expect(v).not.toContain('gaji');
      const nama = `Tpl ${randomBytes(3).toString('hex')}`;
      const t1 = (await buatTpl(hrd, { name: nama }).expect(201)).body;
      expect(t1.version).toBe(1);
      expect(t1.status).toBe('BELUM_DIVERIFIKASI');
      expect(t1.companyId).toBe(perusahaanA);
      expect((await buatTpl(hrd, { name: nama, body: `${TPL} revisi` }).expect(201)).body.version).toBe(2);
      expect((await buatTpl(hrd).expect(201)).body.version).toBe(1); // nama lain
      expect(JSON.stringify((await buatTpl(hrd, { body: 'Gaji {{gaji_pokok}} {{password}}' }).expect(400)).body)).toMatch(/Variabel tidak dikenal: gaji_pokok, password/);
      expect(JSON.stringify((await buatTpl(hrd, { body: '' }).expect(400)).body)).toMatch(/wajib/);
      await buatTpl(hrd, { name: '' }).expect(400);
      expect((await http('get', `/pkwt/templates/${t1.id}`, hrd).expect(200)).body.body).toBe(TPL);
      const daftar = (await http('get', '/pkwt/templates?limit=100', hrd).expect(200)).body.items as Record<string, unknown>[];
      expect(daftar.find((x) => x.id === t1.id)).toBeDefined();
      expect(daftar.every((x) => !('body' in x))).toBe(true); // daftar tanpa isi
    });

    it('versi berurutan walau dibuat serentak', async () => {
      const hrd = await hrdA();
      const nama = `Serentak ${randomBytes(3).toString('hex')}`;
      const r = await Promise.all([1, 2, 3, 4].map(() => buatTpl(hrd, { name: nama })));
      expect(r.map((x) => x.status)).toEqual([201, 201, 201, 201]);
      expect(r.map((x) => x.body.version as number).sort()).toEqual([1, 2, 3, 4]);
    });

    it('ubah hanya saat BELUM_DIVERIFIKASI; setelah verifikasi terkunci (409) dan perubahan = versi baru', async () => {
      const hrd = await hrdA();
      const dir = await buatStaff('DIREKTUR', [perusahaanA]);
      const t = (await buatTpl(hrd).expect(201)).body;
      expect((await http('patch', `/pkwt/templates/${t.id}`, hrd).send({ body: `${TPL} ubah` }).expect(200)).body.body).toBe(`${TPL} ubah`);
      await http('patch', `/pkwt/templates/${t.id}`, hrd).send({}).expect(400);
      await http('patch', `/pkwt/templates/${t.id}`, hrd).send({ status: 'TERVERIFIKASI' }).expect(400); // status tak dapat diubah lewat PATCH
      await http('post', `/pkwt/templates/${t.id}/verify`, dir).send({ note: 'Diverifikasi ahli hukum (uji)' }).expect(200);
      expect((await http('patch', `/pkwt/templates/${t.id}`, hrd).send({ body: 'diretas {{nama}}' }).expect(409)).body.kode).toBe('TEMPLATE_TERKUNCI');
      expect((await buatTpl(hrd, { name: t.name }).expect(201)).body.version).toBe(2);
    });

    it('verifikasi: catatan wajib; Direktur memverifikasi; pembuat tidak dapat memverifikasi sendiri (403, aplikasi + DB); ulang 409; arsip', async () => {
      const hrd = await hrdA();
      const dir = await buatStaff('DIREKTUR', [perusahaanA]);
      const ganda = await buatStaff('HRD', [perusahaanA]);
      await pool.query(`INSERT INTO user_roles (user_id, role_code, grant_source) VALUES ($1, 'DIREKTUR', 'MANUAL')`, [ganda.userId]);
      const t = (await buatTpl(hrd).expect(201)).body;
      await http('post', `/pkwt/templates/${t.id}/verify`, dir).send({}).expect(400);
      await http('post', `/pkwt/templates/${t.id}/verify`, dir).send({ note: 'ab' }).expect(400);
      const milikGanda = (await buatTpl(ganda).expect(201)).body;
      expect((await http('post', `/pkwt/templates/${milikGanda.id}/verify`, ganda).send({ note: 'Verifikasi sendiri' }).expect(403)).body.kode).toBe('PEMISAHAN_TUGAS');
      await http('post', `/pkwt/templates/${t.id}/archive`, hrd).expect(409); // belum terverifikasi tak dapat diarsipkan
      const ok = (await http('post', `/pkwt/templates/${t.id}/verify`, dir).send({ note: 'Diverifikasi ahli hukum (uji)' }).expect(200)).body;
      expect(ok.status).toBe('TERVERIFIKASI');
      expect(ok.verificationNote).toBe('Diverifikasi ahli hukum (uji)');
      await http('post', `/pkwt/templates/${t.id}/verify`, dir).send({ note: 'Sekali lagi' }).expect(409);
      expect((await http('post', `/pkwt/templates/${t.id}/archive`, hrd).expect(200)).body.status).toBe('DIARSIPKAN');
      await http('post', `/pkwt/templates/${t.id}/archive`, hrd).expect(409);
      expect((await auditObjek(perusahaanA, 'pkwt.template.verified', t.id)).length).toBe(1);
      expect((await auditObjek(perusahaanA, 'pkwt.template.created', t.id)).every((x) => x.company_id === perusahaanA)).toBe(true);
    });

    it('lintas perusahaan: scope A tidak melihat/mengubah/memverifikasi template B (404); companyId di luar scope 404; scope jamak wajib memilih', async () => {
      const hA = await hrdA();
      const hB = await buatStaff('HRD', [perusahaanB]);
      const dirA = await buatStaff('DIREKTUR', [perusahaanA]);
      const tB = (await buatTpl(hB).expect(201)).body;
      await http('get', `/pkwt/templates/${tB.id}`, hA).expect(404);
      await http('patch', `/pkwt/templates/${tB.id}`, hA).send({ body: 'diretas' }).expect(404);
      await http('post', `/pkwt/templates/${tB.id}/verify`, dirA).send({ note: 'Lintas perusahaan' }).expect(404);
      await http('post', `/pkwt/templates/${tB.id}/archive`, hA).expect(404);
      expect(((await http('get', '/pkwt/templates?limit=100', hA).expect(200)).body.items as { id: string }[]).map((x) => x.id)).not.toContain(tB.id);
      expect((await http('get', `/pkwt/templates?companyId=${perusahaanB}`, hA).expect(200)).body.items).toEqual([]);
      await buatTpl(hA, { companyId: perusahaanB }).expect(404);
      const ganda = await buatStaff('HRD', [perusahaanA, perusahaanB]);
      expect((await buatTpl(ganda).expect(409)).body.kode).toBe('PERUSAHAAN_WAJIB');
      expect((await buatTpl(ganda, { companyId: perusahaanB }).expect(201)).body.companyId).toBe(perusahaanB);
      expect((await http('get', `/pkwt/templates/${tB.id}`, hB).expect(200)).body.status).toBe('BELUM_DIVERIFIKASI'); // utuh
    });

    it('keyset daftar: tanpa duplikat; batas ukuran, status, dan kursor divalidasi', async () => {
      const hrd = await buatStaff('HRD', [perusahaanB]);
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) ids.push((await buatTpl(hrd).expect(201)).body.id);
      const lihat = new Set<string>();
      let kursor: string | null = null;
      let n = 0;
      do {
        const r: request.Response = await http('get', `/pkwt/templates?limit=2${kursor ? `&cursor=${kursor}` : ''}`, hrd).expect(200);
        for (const x of r.body.items as { id: string }[]) {
          expect(lihat.has(x.id)).toBe(false);
          lihat.add(x.id);
        }
        kursor = r.body.nextCursor;
        n++;
      } while (kursor && n < 50);
      for (const id of ids) expect(lihat.has(id)).toBe(true);
      await http('get', '/pkwt/templates?limit=101', hrd).expect(400);
      await http('get', '/pkwt/templates?status=ASAL', hrd).expect(400);
      await http('get', '/pkwt/templates?cursor=bukan-kursor', hrd).expect(400);
    });

    // [lihat (pkwt.view), buat/ubah/arsip (pkwt.update), verifikasi (pkwt.approve)] sesuai tabel "PKWT" di docs/rbac.md
    const izin: Record<string, [boolean, boolean, boolean]> = {
      DIREKTUR: [true, false, true],
      MANAGER_OPERASIONAL: [true, false, false],
      IT_ADMIN: [false, false, false],
      HRD: [true, true, false],
      MARKETING: [false, false, false],
      STAFF_ADMINISTRASI: [true, false, false],
      STAFF_PAYROLL_ABSENSI_REKANAN: [true, false, false],
      STAFF_KEUANGAN: [true, false, false],
      STAFF_PAYROLL_INTERNAL: [false, false, false],
    };
    it.each(Object.entries(izin))('izin %s', async (peranKode, [v, u, ap]) => {
      const hrd = await hrdA();
      const t = (await buatTpl(hrd).expect(201)).body;
      const s = await buatStaff(peranKode, [perusahaanA]);
      const cek = async (boleh: boolean, res: request.Test) => {
        const r = await res;
        if (boleh) expect(r.status).not.toBe(403);
        else expect(r.status).toBe(403);
      };
      await cek(v, http('get', '/pkwt/templates', s));
      await cek(v, http('get', `/pkwt/templates/${t.id}`, s));
      await cek(v, http('get', '/pkwt/templates/variabel', s));
      await cek(u, buatTpl(s));
      await cek(u, http('patch', `/pkwt/templates/${t.id}`, s).send({ body: TPL }));
      await cek(u, http('post', `/pkwt/templates/${t.id}/archive`, s));
      await cek(ap, http('post', `/pkwt/templates/${t.id}/verify`, s).send({ note: 'uji izin' }));
    });

    it('mencakup semua peran; tanpa sesi 401; member tidak dapat memakai rute staff', async () => {
      expect(Object.keys(izin)).toHaveLength(9);
      await http('get', '/pkwt/templates').expect(401);
      const p = (await pool.query(`INSERT INTO persons (display_name) VALUES ('SINTETIS Member') RETURNING id`)).rows[0].id as string;
      const u = (await pool.query(`INSERT INTO users (person_id, realm, email, status) VALUES ($1, 'member', $2, 'AKTIF') RETURNING id`, [p, `m-${randomBytes(4).toString('hex')}@contoh.invalid`])).rows[0].id as string;
      const ss = await sessions.buat({ userId: u, realm: 'member', state: 'PENUH' });
      await http('get', '/pkwt/templates', { cookie: `__Host-sid=${ss.token}`, csrf: ss.csrfToken }).expect(403);
    });
  });

  describe('nomor kontrak otomatis', () => {
    const tahun = 2090 + Math.floor(Math.random() * 9);
    const terbitkan = async (company: string, th = tahun) => {
      const { ScopedDb } = await import('../src/database/scoped-db');
      const { NumberingService } = await import('../src/pkwt/numbering.service');
      return app.get(ScopedDb).tx({ companyIds: [company] }, (c) => app.get(NumberingService).terbitkan(c, company, th));
    };
    it('format <prefiks>/<kode>/<tahun>/<urut>; prefiks dari pengaturan perusahaan; urut terpisah per perusahaan dan per tahun', async () => {
      await pool.query(`UPDATE companies SET short_code = $2 WHERE id = $1`, [perusahaanA, `A${randomBytes(2).toString('hex').toUpperCase()}`]);
      await pool.query(`UPDATE companies SET short_code = $2, document_settings = '{"contractNumberPrefix": "KTR"}'::jsonb WHERE id = $1`, [perusahaanB, `B${randomBytes(2).toString('hex').toUpperCase()}`]);
      const kodeA = (await pool.query(`SELECT short_code FROM companies WHERE id = $1`, [perusahaanA])).rows[0].short_code;
      const kodeB = (await pool.query(`SELECT short_code FROM companies WHERE id = $1`, [perusahaanB])).rows[0].short_code;
      expect(await terbitkan(perusahaanA)).toBe(`PKWT/${kodeA}/${tahun}/0001`);
      expect(await terbitkan(perusahaanA)).toBe(`PKWT/${kodeA}/${tahun}/0002`);
      expect(await terbitkan(perusahaanB)).toBe(`KTR/${kodeB}/${tahun}/0001`); // prefiks dan urutan sendiri
      expect(await terbitkan(perusahaanA, tahun + 1)).toBe(`PKWT/${kodeA}/${tahun + 1}/0001`); // tahun baru mulai lagi
    });

    it('serentak: nomor unik dan berurutan tanpa celah; transaksi yang dibatalkan tidak meninggalkan celah', async () => {
      const th = 2100 + Math.floor(Math.random() * 90);
      const hasil = await Promise.all(Array.from({ length: 12 }, () => terbitkan(perusahaanA, th)));
      expect(new Set(hasil).size).toBe(12);
      expect(hasil.map((n) => Number(n.split('/').pop())).sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
      const { ScopedDb } = await import('../src/database/scoped-db');
      const { NumberingService } = await import('../src/pkwt/numbering.service');
      await expect(app.get(ScopedDb).tx({ companyIds: [perusahaanA] }, async (c) => { await app.get(NumberingService).terbitkan(c, perusahaanA, th); throw new Error('batal'); })).rejects.toThrow('batal');
      expect(Number((await terbitkan(perusahaanA, th)).split('/').pop())).toBe(13); // nomor yang dibatalkan dipakai ulang
    });
  });
});
