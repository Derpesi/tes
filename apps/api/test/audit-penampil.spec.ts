import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
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

interface Sesi { cookie: string; csrf: string; userId: string }

// Semua data SINTETIS.
jalan('Penampil audit: kategori per peran, scope RLS, filter, dan penyaringan detail (PostgreSQL asli)', () => {
  let app: INestApplication;
  let pool: Pool;
  let nomorIp = 1;
  let A: string;
  let B: string;
  let tag: string;
  let aktor: string;
  let sessions: import('../src/auth/session.service').SessionService;
  const s: Record<string, Sesi> = {};
  const id: Record<string, string> = {};

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
    A = (await pool.query(`INSERT INTO companies (name) VALUES ($1) RETURNING id`, [`PT SINTETIS A ${randomBytes(3).toString('hex')}`])).rows[0].id;
    B = (await pool.query(`INSERT INTO companies (name) VALUES ($1) RETURNING id`, [`PT SINTETIS B ${randomBytes(3).toString('hex')}`])).rows[0].id;
    for (const [nama, roles, scope] of [
      ['dir', ['DIREKTUR'], [A, B]], ['mo', ['MANAGER_OPERASIONAL'], [A]], ['moB', ['MANAGER_OPERASIONAL'], [B]], ['it', ['IT_ADMIN'], []], ['itA', ['IT_ADMIN'], [A]], ['keu', ['STAFF_KEUANGAN'], [A]],
      ['keuB', ['STAFF_KEUANGAN'], [B]], ['hrd', ['HRD'], [A]], ['mkt', ['MARKETING'], [A]], ['adm', ['STAFF_ADMINISTRASI'], [A]], ['payint', ['STAFF_PAYROLL_INTERNAL'], [A]], ['payabs', ['STAFF_PAYROLL_ABSENSI_REKANAN'], [A]],
      ['gandaItKeu', ['IT_ADMIN', 'STAFF_KEUANGAN'], [A]],
    ] as const) s[nama] = await buatStaff([...roles], [...scope]);
    aktor = s.dir.userId;
    tag = randomBytes(4).toString('hex');
    const tulis = async (kunci: string, aksi: string, company: string | null, detail: object = {}, objek: [string, string] = ['uji', randomUUID()]) => {
      id[kunci] = randomUUID(); // tanpa RETURNING: baris tidak terlihat oleh pool tanpa scope (RLS baca)
      await pool.query(`INSERT INTO audit_logs (id, action, actor_id, company_id, object_type, object_id, detail) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [id[kunci], aksi, aktor, company, objek[0], objek[1], JSON.stringify(detail)]);
    };
    await tulis('teknisA', `auth.${tag}.role`, A, { role: 'HRD', email: 'rahasia@contoh.invalid' });
    await tulis('teknisB', `auth.${tag}.role`, B);
    await tulis('teknisG', `auth.${tag}.global`, null, { via: 'cli' });
    await tulis('transA', `payroll.${tag}.approved`, A, { versi: 2, nominal: 'RAHASIA-150000' });
    await tulis('transB', `payroll.${tag}.approved`, B, { versi: 1 });
    await tulis('opA', `member.${tag}.nik`, A, { nik: '9900000000000001', email: 'budi@contoh.invalid', nama: 'Budi Sintetis', jenis: 'ktp', bidang: ['nik'], dalam: { x: 1 } }, ['member_profile', 'obj-uji-1']);
    await tulis('opB', `pkwt.${tag}.x`, B);
    await tulis('opG', `master.${tag}.global`, null);
  });
  afterAll(async () => {
    await pool?.end();
    await app?.close();
  });

  const ipBaru = () => `10.95.${Math.floor(nomorIp / 250)}.${(nomorIp++ % 250) + 1}`;
  const http = (path: string, x: Sesi) => request(app.getHttpServer()).get(path).set('X-Forwarded-For', ipBaru()).set('Origin', ORIGIN).set('Cookie', x.cookie).set('X-CSRF-Token', x.csrf);
  const buatStaff = async (roles: string[], companyIds: string[]): Promise<Sesi> => {
    const u = (await pool.query(`INSERT INTO users (realm, email, status) VALUES ('staff', $1, 'AKTIF') RETURNING id`, [`s-${randomBytes(4).toString('hex')}@contoh.invalid`])).rows[0].id as string;
    for (const role of roles) await pool.query(`INSERT INTO user_roles (user_id, role_code, grant_source) VALUES ($1, $2, 'MANUAL')`, [u, role]);
    for (const c of companyIds) await pool.query(`INSERT INTO user_company_scopes (user_id, scope_company_id) VALUES ($1, $2)`, [u, c]);
    const x = await sessions.buat({ userId: u, realm: 'staff', state: 'PENUH' });
    return { cookie: `__Host-sid=${x.token}`, csrf: x.csrfToken, userId: u };
  };
  /** Kunci baris uji yang terlihat oleh `x` (semua awalan kategori; hanya baris milik tag ini). */
  const lihat = async (x: Sesi, q = '') => {
    const hasil: string[] = [];
    for (const awal of ['auth', 'payroll', 'member', 'pkwt', 'master']) {
      const r = await http(`/audit-logs?action=${awal}.${tag}${q}&limit=100`, x).expect(200);
      for (const it of r.body.items as { id: string }[]) hasil.push(Object.entries(id).find(([, v]) => v === it.id)![0]);
    }
    return hasil.sort();
  };

  describe('kategori menurut peran dan scope', () => {
    it('Direktur: semua kategori pada perusahaan dalam scope dan baris global', async () => {
      expect(await lihat(s.dir)).toEqual(['opA', 'opB', 'opG', 'teknisA', 'teknisB', 'teknisG', 'transA', 'transB']);
    });
    it('Mgr Ops: operasional + transaksi pada scope-nya; TIDAK melihat teknis (walau satu perusahaan) dan tidak melihat perusahaan lain', async () => {
      expect(await lihat(s.mo)).toEqual(['opA', 'transA']);
      expect(await lihat(s.moB)).toEqual(['opB', 'transB']);
    });
    it('IT: HANYA teknis (baris global; dengan scope juga perusahaannya); tidak melihat payroll/member/pkwt/master', async () => {
      expect(await lihat(s.it)).toEqual(['teknisG']);
      expect(await lihat(s.itA)).toEqual(['teknisA', 'teknisG']);
    });
    it('Keuangan: HANYA transaksi (payroll) pada scope-nya', async () => {
      expect(await lihat(s.keu)).toEqual(['transA']);
      expect(await lihat(s.keuB)).toEqual(['transB']);
    });
    it('peran ganda IT + Keuangan = gabungan (teknis + transaksi), tanpa operasional', async () => {
      expect(await lihat(s.gandaItKeu)).toEqual(['teknisA', 'teknisG', 'transA']);
    });
    it('peran tanpa izin audit 403 (HRD, Marketing, Adm, PayInt, PayAbs); tanpa sesi 401', async () => {
      for (const n of ['hrd', 'mkt', 'adm', 'payint', 'payabs']) await http('/audit-logs', s[n]).expect(403);
      await request(app.getHttpServer()).get('/audit-logs').expect(401);
    });
    it('filter kategori: sesuai kewenangan; di luar kewenangan = kosong; nilai salah 400', async () => {
      const k = async (x: Sesi, kat: string) => (await http(`/audit-logs?action=auth.${tag}&kategori=${kat}&limit=100`, x).expect(200)).body.items.length;
      expect(await k(s.dir, 'TEKNIS')).toBe(3);
      expect(await k(s.dir, 'TRANSAKSI')).toBe(0); // awalan auth bukan transaksi
      expect(await k(s.keu, 'TEKNIS')).toBe(0);
      expect(await k(s.it, 'TEKNIS')).toBe(1);
      expect((await http(`/audit-logs?action=payroll.${tag}&kategori=OPERASIONAL&limit=100`, s.dir).expect(200)).body.items).toHaveLength(0);
      await http('/audit-logs?kategori=SALAH', s.dir).expect(400);
    });
    it('item membawa kategori turunan dari aksi', async () => {
      const r = (await http(`/audit-logs?action=payroll.${tag}&limit=100`, s.dir).expect(200)).body.items;
      expect(r.every((x: { category: string }) => x.category === 'TRANSAKSI')).toBe(true);
    });
  });

  describe('detail: tanpa PII dan sesuai peran', () => {
    it('Direktur melihat detail tersaring (kunci PII dibuang, nilai bersarang dibuang); IT tidak melihat detail sama sekali', async () => {
      const d = (await http(`/audit-logs?action=member.${tag}&limit=10`, s.dir).expect(200)).body.items[0];
      expect(d.detail).toEqual({ jenis: 'ktp', bidang: ['nik'] });
      const t = (await http(`/audit-logs?action=auth.${tag}&limit=100`, s.itA).expect(200)).body.items;
      expect(t.length).toBe(2);
      for (const x of t) expect(x.detail).toBeNull();
      const dt = (await http(`/audit-logs?action=auth.${tag}.role&limit=100`, s.dir).expect(200)).body.items.find((x: { id: string }) => x.id === id.teknisA);
      expect(dt.detail).toEqual({ role: 'HRD' }); // email dibuang
    });
    it('respons tidak pernah memuat NIK, email, nama, atau nominal mentah dari detail', async () => {
      for (const n of ['dir', 'mo', 'keu', 'itA', 'gandaItKeu']) {
        for (const awal of ['auth', 'payroll', 'member']) {
          const teks = JSON.stringify((await http(`/audit-logs?action=${awal}.${tag}&limit=100`, s[n]).expect(200)).body);
          expect(teks).not.toMatch(/9900000000000001|rahasia@contoh|budi@contoh|Budi Sintetis|RAHASIA-150000/);
        }
      }
      expect(JSON.stringify((await http(`/audit-logs?action=payroll.${tag}&limit=100`, s.keu).expect(200)).body)).toContain('"versi":2');
    });
  });

  describe('filter, keyset, dan validasi', () => {
    it('filter objek, aktor, perusahaan, waktu, dan awalan aksi (karakter LIKE diperlakukan harfiah)', async () => {
      const q = async (x: string, p = s.dir) => (await http(`/audit-logs?${x}&limit=100`, p).expect(200)).body.items.map((i: { id: string }) => i.id) as string[];
      expect(await q(`objectType=member_profile&objectId=obj-uji-1`)).toEqual([id.opA]);
      expect(await q(`actorId=${aktor}&action=payroll.${tag}`)).toHaveLength(2);
      expect(await q(`actorId=${randomUUID()}&action=payroll.${tag}`)).toHaveLength(0);
      expect(await q(`companyId=${A}&action=payroll.${tag}`)).toEqual([id.transA]);
      expect(await q(`companyId=${B}&action=payroll.${tag}`, s.mo)).toEqual([]); // perusahaan di luar scope: RLS
      expect(await q(`action=payroll.%25&objectType=uji`)).toEqual([]); // "%" literal bukan wildcard
      expect(await q(`action=payroll.${tag}&from=2999-01-01T00:00:00Z`)).toEqual([]);
      expect((await q(`action=payroll.${tag}&to=2999-01-01T00:00:00Z`)).length).toBe(2);
      for (const bad of ['actorId=bukan-uuid', 'companyId=x', 'from=kemarin', 'limit=101', 'limit=0']) await http(`/audit-logs?${bad}`, s.dir).expect(400);
    });
    it('keyset berurutan tanpa duplikat lintas halaman', async () => {
      const sudah: string[] = [];
      let kursor: string | null = null;
      for (let i = 0; i < 6; i++) {
        const r: request.Response = await http(`/audit-logs?action=auth.${tag}&limit=1${kursor ? `&cursor=${kursor}` : ''}`, s.dir).expect(200);
        sudah.push(...r.body.items.map((x: { id: string }) => x.id));
        kursor = r.body.nextCursor;
        if (!kursor) break;
      }
      expect(sudah).toHaveLength(3);
      expect(new Set(sudah).size).toBe(3);
      await http('/audit-logs?cursor=rusak', s.dir).expect(400);
    });
  });

  describe('append-only dan RLS', () => {
    it('audit_logs tidak dapat diubah atau dihapus: RLS tanpa kebijakan UPDATE/DELETE (0 baris) dan trigger append-only menolak walau RLS dimatikan', async () => {
      const dalamScopeA = async (fn: (c: import('pg').PoolClient) => Promise<void>) => {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          await c.query(`SELECT set_config('app.company_ids', $1, true)`, [A]);
          await fn(c);
        } finally {
          await c.query('ROLLBACK').catch(() => undefined);
          c.release();
        }
      };
      await dalamScopeA(async (c) => {
        // Lapis 1: RLS (role non-superuser: 0 baris). Role superuser melewati RLS, tetapi lapis 2 (trigger) menolak; keduanya = baris tidak berubah.
        for (const sql of [`UPDATE audit_logs SET action = 'x' WHERE id = $1`, `DELETE FROM audit_logs WHERE id = $1`]) {
          try {
            expect((await c.query(sql, [id.opA])).rowCount).toBe(0);
          } catch (e) {
            expect((e as Error).message).toMatch(/append-only/);
            await c.query('ROLLBACK');
            await c.query('BEGIN');
            await c.query(`SELECT set_config('app.company_ids', $1, true)`, [A]);
          }
        }
      });
      await pool.query(`ALTER TABLE audit_logs DISABLE ROW LEVEL SECURITY`);
      try {
        for (const sql of [`UPDATE audit_logs SET action = 'x' WHERE id = $1`, `DELETE FROM audit_logs WHERE id = $1`]) {
          await dalamScopeA(async (c) => void (await expect(c.query(sql, [id.opA])).rejects.toThrow(/append-only/))); // lapis 2: trigger
        }
        await dalamScopeA(async (c) => void (await expect(c.query(`TRUNCATE audit_logs`)).rejects.toThrow(/append-only/)));
      } finally {
        await pool.query(`ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY`);
      }
    });
    it('bukti RLS efektif: tanpa RLS Mgr Ops perusahaan A MELIHAT baris B (tes gagal bila RLS dimatikan); kategori tetap ditegakkan', async () => {
      await pool.query(`ALTER TABLE audit_logs DISABLE ROW LEVEL SECURITY`);
      try {
        const bocor = await lihat(s.mo);
        expect(bocor).toEqual(expect.arrayContaining(['opB', 'transB'])); // kebocoran lintas perusahaan bila RLS mati
        expect(bocor).not.toContain('teknisA'); // pembatasan kategori di SQL tetap berlaku (bukan RLS)
      } finally {
        await pool.query(`ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY`);
      }
      expect(await lihat(s.mo)).toEqual(['opA', 'transA']);
    });
  });
});
