import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool, PoolClient } from 'pg';
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
interface Dasar { company: string; lok: string; titik: string; person: string; placement: string }
const UUID_NOL = '00000000-0000-4000-8000-000000000000';
const wib = (s: string) => new Date(`${s.replace(' ', 'T')}:00+07:00`);
const tahun = () => 2200 + Math.floor(Math.random() * 7000); // periode unik antar-run (tanpa tumpang tindih)

// Semua data SINTETIS.
jalan('Payroll: periode, detail rekap, dan snapshot absensi (PostgreSQL asli)', () => {
  let app: INestApplication;
  let pool: Pool;
  let nomorIp = 1;
  let A: string;
  let B: string;
  let u1: string;
  let sessions: import('../src/auth/session.service').SessionService;
  const s: Record<string, Sesi> = {};

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
    pool = new Pool({ connectionString: DB_URL, max: 6 });
    A = (await pool.query(`INSERT INTO companies (name) VALUES ($1) RETURNING id`, [`PT SINTETIS A ${randomBytes(3).toString('hex')}`])).rows[0].id;
    B = (await pool.query(`INSERT INTO companies (name) VALUES ($1) RETURNING id`, [`PT SINTETIS B ${randomBytes(3).toString('hex')}`])).rows[0].id;
    for (const [nama, role, scope] of [
      ['payabs', 'STAFF_PAYROLL_ABSENSI_REKANAN', [A]], ['payint', 'STAFF_PAYROLL_INTERNAL', [A]], ['keu', 'STAFF_KEUANGAN', [A]], ['dir', 'DIREKTUR', [A]], ['mo', 'MANAGER_OPERASIONAL', [A]],
      ['hrd', 'HRD', [A]], ['adm', 'STAFF_ADMINISTRASI', [A]], ['it', 'IT_ADMIN', [A]], ['mkt', 'MARKETING', [A]], ['payabsB', 'STAFF_PAYROLL_ABSENSI_REKANAN', [B]], ['keuB', 'STAFF_KEUANGAN', [B]],
    ] as const) s[nama] = await buatStaff(role, [...scope]);
    u1 = s.mo.userId;
  });
  afterAll(async () => {
    await pool?.end();
    await app?.close();
  });

  const ipBaru = () => `10.90.${Math.floor(nomorIp / 250)}.${(nomorIp++ % 250) + 1}`;
  const http = (metode: 'get' | 'post' | 'put' | 'delete', path: string, x: Sesi) => request(app.getHttpServer())[metode](path).set('X-Forwarded-For', ipBaru()).set('Origin', ORIGIN).set('Cookie', x.cookie).set('X-CSRF-Token', x.csrf);
  const buatStaff = async (role: string, companyIds: string[]): Promise<Sesi> => {
    const u = (await pool.query(`INSERT INTO users (realm, email, status) VALUES ('staff', $1, 'AKTIF') RETURNING id`, [`s-${randomBytes(4).toString('hex')}@contoh.invalid`])).rows[0].id as string;
    await pool.query(`INSERT INTO user_roles (user_id, role_code, grant_source) VALUES ($1, $2, 'MANUAL')`, [u, role]);
    for (const c of companyIds) await pool.query(`INSERT INTO user_company_scopes (user_id, scope_company_id) VALUES ($1, $2)`, [u, c]);
    const x = await sessions.buat({ userId: u, realm: 'staff', state: 'PENUH' });
    return { cookie: `__Host-sid=${x.token}`, csrf: x.csrfToken, userId: u };
  };
  const tenant = async <T>(companyIds: string[], fn: (c: PoolClient) => Promise<T>): Promise<T> => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.company_ids', $1, true)`, [companyIds.join(',')]);
      const r = await fn(c);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  };
  const dasar = async (company: string): Promise<Dasar> => {
    const person = (await pool.query(`INSERT INTO persons (display_name) VALUES ('SINTETIS Pekerja') RETURNING id`)).rows[0].id as string;
    return tenant([company], async (c) => {
      const p = (await c.query(`INSERT INTO partners (company_id, name, created_by) VALUES ($1, $2, $3) RETURNING id`, [company, `Rek ${randomBytes(3).toString('hex')}`, u1])).rows[0].id;
      const lok = (await c.query(`INSERT INTO partner_locations (company_id, partner_id, name, latitude, longitude, created_by) VALUES ($1, $2, 'Lokasi Payroll', -6.9, 107.6, $3) RETURNING id`, [company, p, u1])).rows[0].id;
      const titik = (await c.query(`INSERT INTO attendance_points (company_id, location_id, created_by) VALUES ($1, $2, $3) RETURNING id`, [company, lok, u1])).rows[0].id;
      const placement = (await c.query(`INSERT INTO placements (company_id, person_id, location_id, start_date, end_date, created_by) VALUES ($1, $2, $3, '2000-01-01', '9999-12-31', $4) RETURNING id`, [company, person, lok, u1])).rows[0].id;
      return { company, lok, titik, person, placement };
    });
  };
  const pekerja = async (x: Dasar, nama: string): Promise<Dasar> => {
    const person = (await pool.query(`INSERT INTO persons (display_name) VALUES ($1) RETURNING id`, [nama])).rows[0].id as string;
    await pool.query(`INSERT INTO member_profiles (person_id, full_name) VALUES ($1, $2)`, [person, nama]);
    const placement = await tenant([x.company], async (c) => (await c.query(`INSERT INTO placements (company_id, person_id, location_id, start_date, end_date, created_by) VALUES ($1, $2, $3, '2000-01-01', '9999-12-31', $4) RETURNING id`, [x.company, person, x.lok, u1])).rows[0].id as string);
    return { ...x, person, placement };
  };
  const rekaman = (x: Dasar, o: { kind?: string; status?: string; tanggal: string; waktu: string; flags?: string[] }) =>
    tenant([x.company], async (c) => {
      const status = o.status ?? 'VALID';
      const id = (await c.query(
        `INSERT INTO attendance_records (company_id, person_id, placement_id, point_id, location_id, kind, status, reject_reason, shift_date, occurred_at, latitude, longitude, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, -6.9, 107.6, $11) RETURNING id`,
        [x.company, x.person, x.placement, x.titik, x.lok, o.kind ?? 'MASUK', status, status === 'DITOLAK' ? 'LUAR_RADIUS' : null, o.tanggal, wib(`${o.tanggal} ${o.waktu}`), `pay-${randomBytes(8).toString('hex')}`],
      )).rows[0].id as string;
      for (const f of o.flags ?? []) await c.query(`INSERT INTO attendance_flags (company_id, record_id, code, score) VALUES ($1, $2, $3, 0)`, [x.company, id, f]);
      return id;
    });
  const audit = async (aksi: string, objekId: string) => tenant([A, B], async (c) => (await c.query(`SELECT detail, actor_id FROM audit_logs WHERE action = $1 AND object_id = $2`, [aksi, objekId])).rows);
  const periodeBody = (th: number, kind = 'PARTNER', o: object = {}) => ({ kind, label: `Periode ${th}`, startDate: `${th}-03-01`, endDate: `${th}-03-31`, ...o });

  describe('periode: izin per jenis, validasi, tumpang tindih', () => {
    it('buat periode: PayAbs hanya PARTNER, PayInt hanya INTERNAL; peran lain 403; rekap versi 1 DRAFT + riwayat + audit', async () => {
      const th = tahun();
      for (const n of ['keu', 'dir', 'mo', 'hrd', 'adm', 'it', 'mkt']) await http('post', '/payroll/periods', s[n]).send(periodeBody(th)).expect(403);
      await http('post', '/payroll/periods', s.payint).send(periodeBody(th, 'PARTNER')).expect(403);
      await http('post', '/payroll/periods', s.payabs).send(periodeBody(th, 'INTERNAL')).expect(403);
      const r = (await http('post', '/payroll/periods', s.payabs).send(periodeBody(th)).expect(201)).body;
      expect(r).toMatchObject({ kind: 'PARTNER', versionNo: 1, recapNumber: null, status: 'DRAFT', createdBy: s.payabs.userId, startDate: `${th}-03-01`, endDate: `${th}-03-31`, lastEditedBy: null });
      const ri = (await http('post', '/payroll/periods', s.payint).send(periodeBody(th, 'INTERNAL')).expect(201)).body; // jenis lain boleh pada tanggal yang sama
      expect(ri.kind).toBe('INTERNAL');
      const h = await tenant([A], (c) => c.query(`SELECT from_status, to_status, actor_user_id FROM payroll_recap_status_histories WHERE recap_id = $1`, [r.id]));
      expect(h.rows).toEqual([{ from_status: null, to_status: 'DRAFT', actor_user_id: s.payabs.userId }]);
      expect((await audit('payroll.period.created', r.id))[0].detail).toEqual({ jenis: 'PARTNER', mulai: `${th}-03-01`, akhir: `${th}-03-31` });
    });

    it('validasi dan tumpang tindih (409); perusahaan di luar scope 404', async () => {
      const th = tahun();
      await http('post', '/payroll/periods', s.payabs).send(periodeBody(th)).expect(201);
      expect((await http('post', '/payroll/periods', s.payabs).send(periodeBody(th, 'PARTNER', { startDate: `${th}-03-31`, endDate: `${th}-04-10` })).expect(409)).body.kode).toBe('PERIODE_TUMPANG_TINDIH');
      await http('post', '/payroll/periods', s.payabs).send(periodeBody(th, 'PARTNER', { startDate: `${th}-04-01`, endDate: `${th}-04-30` })).expect(201); // bersebelahan boleh
      const salah = async (b: object, pola: RegExp) => expect(JSON.stringify((await http('post', '/payroll/periods', s.payabs).send({ ...periodeBody(th + 1), ...b }).expect(400)).body)).toMatch(pola);
      await salah({ endDate: `${th + 1}-02-28` }, /tidak boleh sebelum/);
      await salah({ startDate: `${th + 1}-01-01`, endDate: `${th + 1}-12-31` }, /maksimal 93 hari/);
      await salah({ label: '  ' }, /Label periode wajib diisi/);
      await salah({ kind: 'LAIN' }, /PARTNER atau INTERNAL/);
      await salah({ startDate: `${th + 1}-02-30` }, /bukan tanggal yang valid/);
      expect((await http('post', '/payroll/periods', s.payabs).send(periodeBody(th + 2, 'PARTNER', { companyId: B })).expect(404)).body.kode).toBe('PERUSAHAAN_TIDAK_DITEMUKAN');
    });

    it('daftar menyaring jenis menurut izin: PayAbs/Mgr Ops hanya PARTNER, PayInt hanya INTERNAL, Direktur/Keuangan keduanya; peran lain 403', async () => {
      const th = tahun();
      const p = (await http('post', '/payroll/periods', s.payabs).send(periodeBody(th)).expect(201)).body;
      const i = (await http('post', '/payroll/periods', s.payint).send(periodeBody(th, 'INTERNAL')).expect(201)).body;
      const lihat = async (n: string) => (await http('get', '/payroll/periods?limit=100', s[n]).expect(200)).body.items.map((x: { id: string }) => x.id);
      for (const n of ['payabs', 'mo']) {
        const ids = await lihat(n);
        expect(ids).toContain(p.periodId);
        expect(ids).not.toContain(i.periodId);
      }
      const ids = await lihat('payint');
      expect(ids).toContain(i.periodId);
      expect(ids).not.toContain(p.periodId);
      for (const n of ['dir', 'keu']) expect(await lihat(n)).toEqual(expect.arrayContaining([p.periodId, i.periodId]));
      for (const n of ['hrd', 'adm', 'it', 'mkt']) await http('get', '/payroll/periods', s[n]).expect(403);
      expect((await http('get', '/payroll/periods?kind=INTERNAL&limit=100', s.dir).expect(200)).body.items.every((x: { kind: string }) => x.kind === 'INTERNAL')).toBe(true);
      await http('get', '/payroll/periods?limit=101', s.dir).expect(400);
      await http('get', '/payroll/periods?kind=SALAH', s.dir).expect(400);
      // keyset tanpa duplikat
      const h1 = (await http('get', '/payroll/periods?limit=2', s.dir).expect(200)).body;
      const h2 = (await http('get', `/payroll/periods?limit=2&cursor=${encodeURIComponent(h1.nextCursor)}`, s.dir).expect(200)).body;
      expect(h2.items.map((x: { id: string }) => x.id)).not.toEqual(expect.arrayContaining([h1.items[0].id]));
      await http('get', '/payroll/periods?cursor=rusak', s.dir).expect(400);
    });

    it('detail periode dan rekap dibatasi per jenis (PayAbs tidak membuka INTERNAL; PayInt tidak membuka PARTNER)', async () => {
      const th = tahun();
      const p = (await http('post', '/payroll/periods', s.payabs).send(periodeBody(th)).expect(201)).body;
      const i = (await http('post', '/payroll/periods', s.payint).send(periodeBody(th, 'INTERNAL')).expect(201)).body;
      for (const n of ['payabs', 'dir', 'keu', 'mo']) {
        await http('get', `/payroll/periods/${p.periodId}`, s[n]).expect(200);
        await http('get', `/payroll/recaps/${p.id}`, s[n]).expect(200);
      }
      for (const n of ['payint', 'hrd', 'it']) await http('get', `/payroll/recaps/${p.id}`, s[n]).expect(n === 'payint' ? 403 : 403);
      await http('get', `/payroll/recaps/${i.id}`, s.payabs).expect(403);
      await http('get', `/payroll/periods/${i.periodId}`, s.mo).expect(403);
      await http('get', `/payroll/recaps/${i.id}`, s.payint).expect(200);
      const d = (await http('get', `/payroll/recaps/${p.id}`, s.dir).expect(200)).body;
      expect(d).toMatchObject({ lineCount: 0, lines: [], totals: { TUNJANGAN: '0.00', POTONGAN: '0.00', INSENTIF: '0.00' } });
      expect(JSON.stringify(d)).not.toMatch(/gaji|neto|net_|slip|pph|bpjs|total_/i); // tahap awal: tanpa hitung gaji final
      await http('get', `/payroll/recaps/${UUID_NOL}`, s.dir).expect(404);
      await http('get', '/payroll/recaps/bukan-uuid', s.dir).expect(400);
    });
  });

  describe('snapshot absensi (tarik)', () => {
    it('hari hadir/tidak hadir/izin/sakit, terlambat, pulang cepat, jam kerja, dan menunggu verifikasi cocok dengan rekap absensi; idempoten; komponen dipertahankan', async () => {
      const th = tahun();
      const x = await dasar(A);
      const [w1, w2, w3, w4] = [await pekerja(x, 'SINTETIS Satu'), await pekerja(x, 'SINTETIS Dua'), await pekerja(x, 'SINTETIS Tiga'), await pekerja(x, 'SINTETIS Empat')];
      const d = (n: number) => `${th}-03-${String(n).padStart(2, '0')}`;
      // W1: dua hari hadir; hari 1 terlambat 8j30m, hari 2 pulang cepat 7j20m (total 950 menit = 15,83 jam)
      await rekaman(w1, { tanggal: d(1), waktu: '07:20', flags: ['TERLAMBAT'] });
      await rekaman(w1, { tanggal: d(1), waktu: '15:50', kind: 'PULANG' });
      await rekaman(w1, { tanggal: d(2), waktu: '07:00' });
      await rekaman(w1, { tanggal: d(2), waktu: '14:20', kind: 'PULANG', flags: ['PULANG_CEPAT'] });
      // W2: satu rekaman menunggu verifikasi; satu ditolak (tidak dihitung hadir)
      await rekaman(w2, { tanggal: d(1), waktu: '07:00', status: 'PERLU_VERIFIKASI' });
      await rekaman(w2, { tanggal: d(2), waktu: '07:00', status: 'DITOLAK' });
      // W3: koreksi disetujui SAKIT tanpa rekaman; W4: koreksi disetujui TIDAK_HADIR menimpa rekaman valid
      const koreksi = (w: Dasar, tgl: string, efek: string, no: string) => tenant([A], (c) => c.query(`INSERT INTO attendance_adjustments (company_id, adjustment_no, person_id, shift_date, effect, reason, status, created_by, decided_by, decided_at) VALUES ($1, $2, $3, $4, $5, 'alasan', 'DISETUJUI', $6, $7, now())`, [A, no, w.person, tgl, efek, s.payabs.userId, s.mo.userId]));
      await koreksi(w3, d(1), 'SAKIT', `KOR/${th}/${randomBytes(3).toString('hex')}`);
      await rekaman(w4, { tanggal: d(1), waktu: '07:00' });
      await rekaman(w4, { tanggal: d(1), waktu: '15:00', kind: 'PULANG' }); // jam kerja hari yang dikoreksi tidak dihitung
      await koreksi(w4, d(1), 'TIDAK_HADIR', `KOR/${th}/${randomBytes(3).toString('hex')}`);

      const r = (await http('post', '/payroll/periods', s.payabs).send(periodeBody(th)).expect(201)).body;
      // izin menarik: hanya pembuat/penyunting jenis ini
      for (const n of ['payint', 'keu', 'dir', 'mo']) await http('post', `/payroll/recaps/${r.id}/pull`, s[n]).expect(403);
      const hasil = (await http('post', `/payroll/recaps/${r.id}/pull`, s.payabs).expect(200)).body;
      const oleh = (nama: string) => hasil.lines.find((l: { workerName: string }) => l.workerName === nama);
      expect(oleh('SINTETIS Satu')).toMatchObject({ source: 'ATTENDANCE', daysPresent: 2, daysAbsent: 0, lateCount: 1, earlyLeaveCount: 1, pendingCount: 0, hoursWorked: '15.83', overtimeHours: '0.00', daysLeave: 0 });
      expect(oleh('SINTETIS Dua')).toMatchObject({ daysPresent: 0, pendingCount: 1, hoursWorked: '0.00' });
      expect(oleh('SINTETIS Tiga')).toMatchObject({ daysSick: 1, daysPresent: 0 });
      expect(oleh('SINTETIS Empat')).toMatchObject({ daysAbsent: 1, daysPresent: 0, hoursWorked: '0.00' });
      expect(hasil.lineCount).toBe(4);
      expect(hasil.pendingCount).toBe(1);
      expect(hasil.lastEditedBy).toBe(s.payabs.userId);
      expect(hasil.pulledAt).not.toBeNull();

      // idempoten + komponen dan masukan manual dipertahankan
      const lineId = oleh('SINTETIS Satu').id;
      await tenant([A], async (c) => {
        await c.query(`INSERT INTO payroll_components (company_id, line_id, kind, name, amount) VALUES ($1, $2, 'TUNJANGAN', 'Makan', 150000.50)`, [A, lineId]);
        await c.query(`UPDATE payroll_recap_lines SET days_leave = 2, overtime_hours = 3.5 WHERE id = $1`, [lineId]);
      });
      const ulang = (await http('post', `/payroll/recaps/${r.id}/pull`, s.payabs).expect(200)).body;
      expect(ulang.lineCount).toBe(4);
      expect(ulang.lines.map((l: { id: string }) => l.id).sort()).toEqual(hasil.lines.map((l: { id: string }) => l.id).sort());
      expect(ulang.lines.find((l: { id: string }) => l.id === lineId)).toMatchObject({ daysLeave: 2, overtimeHours: '3.50', components: [{ kind: 'TUNJANGAN', name: 'Makan', amount: '150000.50' }], subtotals: { TUNJANGAN: '150000.50', POTONGAN: '0.00', INSENTIF: '0.00' } });
      expect(ulang.totals).toEqual({ TUNJANGAN: '150000.50', POTONGAN: '0.00', INSENTIF: '0.00' });
      expect((await audit('payroll.recap.pulled', r.id)).length).toBe(2);

      // absensi berubah (putusan tinjauan) -> tarik ulang memperbarui; orang yang datanya hilang dinolkan, bukan dihapus
      const pend = (await tenant([A], (c) => c.query(`SELECT id FROM attendance_records WHERE person_id = $1 AND status = 'PERLU_VERIFIKASI'`, [w2.person]))).rows[0].id;
      await tenant([A], async (c) => {
        await c.query(`INSERT INTO attendance_reviews (company_id, record_id, stage, decision, actor_id, reason) VALUES ($1, $2, 'PERIKSA', 'DIPERIKSA', $3, 'periksa')`, [A, pend, s.payabs.userId]);
        await c.query(`INSERT INTO attendance_reviews (company_id, record_id, stage, decision, actor_id, reason) VALUES ($1, $2, 'PUTUSAN', 'DISETUJUI', $3, 'setuju')`, [A, pend, s.mo.userId]);
        await c.query(`DELETE FROM attendance_adjustments WHERE person_id = $1`, [w3.person]);
      });
      const baru = (await http('post', `/payroll/recaps/${r.id}/pull`, s.payabs).expect(200)).body;
      expect(baru.lines.find((l: { workerName: string }) => l.workerName === 'SINTETIS Dua')).toMatchObject({ daysPresent: 1, pendingCount: 0 });
      expect(baru.lines.find((l: { workerName: string }) => l.workerName === 'SINTETIS Tiga')).toMatchObject({ daysSick: 0, daysPresent: 0 });
      expect(baru.pendingCount).toBe(0);
    });

    it('rekap internal tidak dapat ditarik (manual); rekap non-DRAFT terkunci; tanpa data = nol baris; periode lain tidak tercampur', async () => {
      const th = tahun();
      const i = (await http('post', '/payroll/periods', s.payint).send(periodeBody(th, 'INTERNAL')).expect(201)).body;
      expect((await http('post', `/payroll/recaps/${i.id}/pull`, s.payint).expect(409)).body.kode).toBe('REKAP_INTERNAL_MANUAL');
      const p = (await http('post', '/payroll/periods', s.payabs).send(periodeBody(th)).expect(201)).body;
      const x = await dasar(A);
      await rekaman(x, { tanggal: `${th}-05-01`, waktu: '07:00' }); // di luar periode Maret
      expect((await http('post', `/payroll/recaps/${p.id}/pull`, s.payabs).expect(200)).body.lineCount).toBe(0);
      await tenant([A], (c) => c.query(`UPDATE payroll_recaps SET status = 'DIVERIFIKASI', reviewed_by = $2, reviewed_at = now() WHERE id = $1`, [p.id, s.keu.userId]));
      expect((await http('post', `/payroll/recaps/${p.id}/pull`, s.payabs).expect(409)).body.kode).toBe('REKAP_TERKUNCI');
    });
  });

  describe('ISOLASI perusahaan', () => {
    it('staf B tidak melihat, menarik, atau membuka periode/rekap A (404); periode B terpisah; RLS menahan pembacaan langsung', async () => {
      const th = tahun();
      const p = (await http('post', '/payroll/periods', s.payabs).send(periodeBody(th)).expect(201)).body;
      await http('get', `/payroll/recaps/${p.id}`, s.keuB).expect(404);
      await http('get', `/payroll/periods/${p.periodId}`, s.keuB).expect(404);
      await http('post', `/payroll/recaps/${p.id}/pull`, s.payabsB).expect(404);
      for (const n of ['keuB', 'payabsB']) expect((await http('get', '/payroll/periods?limit=100', s[n]).expect(200)).body.items.map((x: { id: string }) => x.id)).not.toContain(p.periodId);
      const pB = (await http('post', '/payroll/periods', s.payabsB).send(periodeBody(th)).expect(201)).body; // tanggal sama, perusahaan beda: boleh
      expect(pB.companyId).toBe(B);
      expect((await tenant([A], (c) => c.query(`SELECT id FROM payroll_recaps WHERE id = $1 AND company_id = $2`, [pB.id, A]))).rowCount).toBe(0);
      expect((await tenant([B], (c) => c.query(`SELECT id FROM payroll_periods WHERE id = $1 AND company_id = $2`, [p.periodId, B]))).rowCount).toBe(0);
    });
  });
});
