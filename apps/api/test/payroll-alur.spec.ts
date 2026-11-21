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
jalan('Payroll: komponen, alur status, pemisahan tugas, dan koreksi (PostgreSQL asli)', () => {
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
      ['payabs', ['STAFF_PAYROLL_ABSENSI_REKANAN'], [A]], ['payabs2', ['STAFF_PAYROLL_ABSENSI_REKANAN'], [A]], ['payint', ['STAFF_PAYROLL_INTERNAL'], [A]],
      ['keu1', ['STAFF_KEUANGAN'], [A]], ['keu2', ['STAFF_KEUANGAN'], [A]], ['dir1', ['DIREKTUR'], [A]], ['dir2', ['DIREKTUR'], [A]], ['mo', ['MANAGER_OPERASIONAL'], [A]],
      ['hrd', ['HRD'], [A]], ['adm', ['STAFF_ADMINISTRASI'], [A]], ['it', ['IT_ADMIN'], [A]], ['mkt', ['MARKETING'], [A]],
      ['payabsB', ['STAFF_PAYROLL_ABSENSI_REKANAN'], [B]], ['keuB', ['STAFF_KEUANGAN'], [B]], ['dirB', ['DIREKTUR'], [B]],
      ['ganda1', ['STAFF_PAYROLL_ABSENSI_REKANAN', 'STAFF_KEUANGAN'], [A]], // pembuat sekaligus berwenang memeriksa
      ['ganda2', ['STAFF_PAYROLL_ABSENSI_REKANAN', 'DIREKTUR'], [A]], // pembuat sekaligus berwenang menyetujui
    ] as const) s[nama] = await buatStaff([...role], [...scope]);
    u1 = s.mo.userId;
  });
  afterAll(async () => {
    await pool?.end();
    await app?.close();
  });

  const ipBaru = () => `10.90.${Math.floor(nomorIp / 250)}.${(nomorIp++ % 250) + 1}`;
  const http = (metode: 'get' | 'post' | 'put' | 'delete', path: string, x: Sesi) => request(app.getHttpServer())[metode](path).set('X-Forwarded-For', ipBaru()).set('Origin', ORIGIN).set('Cookie', x.cookie).set('X-CSRF-Token', x.csrf);
  const buatStaff = async (roles: string[], companyIds: string[]): Promise<Sesi> => {
    const u = (await pool.query(`INSERT INTO users (realm, email, status) VALUES ('staff', $1, 'AKTIF') RETURNING id`, [`s-${randomBytes(4).toString('hex')}@contoh.invalid`])).rows[0].id as string;
    for (const role of roles) await pool.query(`INSERT INTO user_roles (user_id, role_code, grant_source) VALUES ($1, $2, 'MANUAL')`, [u, role]);
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


  /** Periode PARTNER dengan satu pekerja hadir (snapshot siap) dibuat oleh `pembuat`. */
  const siapRekap = async (pembuat = 'payabs', o: { internal?: boolean } = {}) => {
    const th = tahun();
    if (o.internal) {
      const r = (await http('post', '/payroll/periods', s.payint).send(periodeBody(th, 'INTERNAL')).expect(201)).body;
      return { th, id: r.id as string, periodId: r.periodId as string, lineId: '' };
    }
    const x = await dasar(A);
    const w = await pekerja(x, 'SINTETIS Pekerja Satu');
    await rekaman(w, { tanggal: `${th}-03-02`, waktu: '07:00' });
    await rekaman(w, { tanggal: `${th}-03-02`, waktu: '15:00', kind: 'PULANG' });
    const r = (await http('post', '/payroll/periods', s[pembuat]).send(periodeBody(th)).expect(201)).body;
    const d = (await http('post', `/payroll/recaps/${r.id}/pull`, s[pembuat]).expect(200)).body;
    return { th, id: r.id as string, periodId: r.periodId as string, lineId: d.lines[0].id as string, x, w };
  };
  const komponen = (id: string, lineId: string, x: Sesi, b: object) => http('post', `/payroll/recaps/${id}/lines/${lineId}/components`, x).send(b);
  const status = async (id: string) => (await tenant([A, B], (c) => c.query(`SELECT status FROM payroll_recaps WHERE id = $1`, [id]))).rows[0].status as string;
  const aksi = (id: string, jalur: string, x: Sesi, b: object = {}) => http('post', `/payroll/recaps/${id}/${jalur}`, x).send(b);

  describe('alur penuh dan kekekalan', () => {
    it('buat -> tarik -> isi komponen -> verifikasi (Keuangan) -> setujui (Direktur) -> finalisasi (Keuangan lain); isi terkunci; hash tersimpan; riwayat dan audit tanpa nominal', async () => {
      const { id, lineId } = await siapRekap();
      await komponen(id, lineId, s.payabs, { kind: 'TUNJANGAN', name: 'Uang makan', amount: '150000.50' }).expect(201);
      await komponen(id, lineId, s.payabs, { kind: 'TUNJANGAN', name: 'Transport', amount: '0.10' }).expect(201);
      await komponen(id, lineId, s.payabs, { kind: 'TUNJANGAN', name: 'Shift', amount: '0.20' }).expect(201);
      const k2 = (await komponen(id, lineId, s.payabs, { kind: 'POTONGAN', name: 'Seragam', amount: '20000' }).expect(201)).body;
      expect(k2.totals).toEqual({ TUNJANGAN: '150000.80', POTONGAN: '20000.00', INSENTIF: '0.00' });
      await http('put', `/payroll/recaps/${id}/lines/${lineId}`, s.payabs).send({ daysLeave: 1, overtimeHours: '3.5', note: 'Cuti 1 hari' }).expect(200);
      const d = (await http('get', `/payroll/recaps/${id}`, s.payabs).expect(200)).body;
      expect(d.lines[0]).toMatchObject({ daysLeave: 1, overtimeHours: '3.50', note: 'Cuti 1 hari', daysPresent: 1, hoursWorked: '8.00', subtotals: { TUNJANGAN: '150000.80', POTONGAN: '20000.00', INSENTIF: '0.00' } });
      expect(d.status).toBe('DRAFT');

      const v = (await aksi(id, 'verify', s.keu1).expect(200)).body;
      expect(v).toMatchObject({ status: 'DIVERIFIKASI', reviewedBy: s.keu1.userId });
      const ap = (await aksi(id, 'approve', s.dir1).expect(200)).body;
      expect(ap).toMatchObject({ status: 'DISETUJUI', approvedBy: s.dir1.userId });
      expect(ap.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
      const fin = (await aksi(id, 'finalize', s.keu2).expect(200)).body;
      expect(fin).toMatchObject({ status: 'DIFINALISASI', finalizedBy: s.keu2.userId, createdBy: s.payabs.userId, snapshotHash: ap.snapshotHash });

      // isi terkunci setelah diverifikasi/disetujui/difinalisasi (aplikasi) dan oleh database
      expect((await komponen(id, lineId, s.payabs, { kind: 'INSENTIF', name: 'X', amount: '1' }).expect(409)).body.kode).toBe('REKAP_TERKUNCI');
      await http('put', `/payroll/recaps/${id}/lines/${lineId}`, s.payabs).send({ daysLeave: 2 }).expect(409);
      await http('post', `/payroll/recaps/${id}/pull`, s.payabs).expect(409);
      await tenant([A], async (c) => {
        await c.query('SAVEPOINT x');
        await expect(c.query(`UPDATE payroll_components SET amount = 1 WHERE line_id = $1`, [lineId])).rejects.toThrow(/tidak boleh diubah/);
      });

      const h = await tenant([A], (c) => c.query(`SELECT from_status, to_status, actor_user_id FROM payroll_recap_status_histories WHERE recap_id = $1 ORDER BY created_at, id`, [id]));
      expect(h.rows.map((x) => `${x.from_status ?? '-'}>${x.to_status}`)).toEqual(['->DRAFT', 'DRAFT>DIVERIFIKASI', 'DIVERIFIKASI>DISETUJUI', 'DISETUJUI>DIFINALISASI']);
      expect(h.rows.map((x) => x.actor_user_id)).toEqual([s.payabs.userId, s.keu1.userId, s.dir1.userId, s.keu2.userId]);
      for (const a of ['payroll.component.added', 'payroll.recap.verified', 'payroll.recap.approved', 'payroll.recap.finalized']) {
        const baris = await audit(a, id);
        expect(baris.length).toBeGreaterThanOrEqual(1);
        expect(JSON.stringify(baris)).not.toMatch(/150000|0\.10|20000|amount|Uang makan/); // tanpa nominal/nama komponen
      }
      expect(JSON.stringify(fin)).not.toMatch(/gaji|neto|pph|bpjs|slip/i);
    });

    it('integritas: perubahan diam-diam pada isi (melewati trigger) terdeteksi saat finalisasi dan tidak dapat difinalisasi', async () => {
      const { id, lineId } = await siapRekap();
      await komponen(id, lineId, s.payabs, { kind: 'INSENTIF', name: 'Bonus', amount: '500.00' }).expect(201);
      await aksi(id, 'verify', s.keu1).expect(200);
      await aksi(id, 'approve', s.dir1).expect(200);
      await tenant([A], async (c) => {
        await c.query(`ALTER TABLE payroll_components DISABLE TRIGGER payroll_components_hanya_draft`);
        try {
          await c.query(`UPDATE payroll_components SET amount = 999 WHERE line_id = $1`, [lineId]);
        } finally {
          await c.query(`ALTER TABLE payroll_components ENABLE TRIGGER payroll_components_hanya_draft`);
        }
      });
      expect((await aksi(id, 'finalize', s.keu2).expect(409)).body.kode).toBe('INTEGRITAS_REKAP_GAGAL');
      expect(await status(id)).toBe('DISETUJUI');
    });
  });

  describe('pemisahan tugas (aplikasi; database dijaga CHECK)', () => {
    it('pemeriksa bukan pembuat dan bukan penyunting terakhir', async () => {
      const { id, lineId } = await siapRekap('ganda1');
      expect((await aksi(id, 'verify', s.ganda1).expect(403)).body.kode).toBe('PEMISAHAN_TUGAS'); // pembuat yang juga berwenang memeriksa
      await komponen(id, lineId, s.ganda1, { kind: 'INSENTIF', name: 'B', amount: '1' }).expect(201);
      // penyunting terakhir = ganda1 (pembuat); orang lain menyunting terakhir lalu mencoba memeriksa
      const editor = await buatStaff(['STAFF_PAYROLL_ABSENSI_REKANAN', 'STAFF_KEUANGAN'], [A]);
      await komponen(id, lineId, editor, { kind: 'INSENTIF', name: 'C', amount: '2' }).expect(201);
      expect((await aksi(id, 'verify', editor).expect(403)).body.kode).toBe('PEMISAHAN_TUGAS');
      await aksi(id, 'verify', s.keu1).expect(200);
    });

    it('penyetuju bukan pembuat dan bukan pemeriksa; finalisator berbeda dari ketiganya', async () => {
      const { id } = await siapRekap('ganda2');
      await aksi(id, 'verify', s.keu1).expect(200);
      expect((await aksi(id, 'approve', s.ganda2).expect(403)).body.kode).toBe('PEMISAHAN_TUGAS'); // pembuat
      expect((await aksi(id, 'approve', s.keu1).expect(403)).body.kode).toBe('PEMISAHAN_TUGAS'); // pemeriksa
      await aksi(id, 'approve', s.dir1).expect(200);
      for (const n of ['ganda2', 'keu1', 'dir1']) expect((await aksi(id, 'finalize', s[n]).expect(403)).body.kode).toBe('PEMISAHAN_TUGAS');
      expect(await status(id)).toBe('DISETUJUI');
      await aksi(id, 'finalize', s.dir2).expect(200); // Direktur lain boleh
    });

    it('serentak: dua penyetuju bersamaan => satu berhasil, satu 409; dua pemeriksa bersamaan => satu berhasil', async () => {
      const a1 = await siapRekap();
      const [v1, v2] = await Promise.all([aksi(a1.id, 'verify', s.keu1), aksi(a1.id, 'verify', s.keu2)]);
      expect([v1.status, v2.status].sort()).toEqual([200, 409]);
      const pemeriksa = v1.status === 200 ? s.keu1 : s.keu2;
      const [p1, p2] = await Promise.all([aksi(a1.id, 'approve', s.dir1), aksi(a1.id, 'approve', s.dir2)]);
      expect([p1.status, p2.status].sort()).toEqual([200, 409]);
      expect(await status(a1.id)).toBe('DISETUJUI');
      void pemeriksa;
      const h = await tenant([A], (c) => c.query(`SELECT to_status FROM payroll_recap_status_histories WHERE recap_id = $1 AND to_status = 'DISETUJUI'`, [a1.id]));
      expect(h.rowCount).toBe(1);
    });
  });

  describe('urutan status dan prasyarat', () => {
    it('transisi di luar alur ditolak; kembalikan membuka kembali DRAFT dan mengosongkan pemeriksa', async () => {
      const { id, lineId } = await siapRekap();
      expect((await aksi(id, 'approve', s.dir1).expect(409)).body.kode).toBe('TRANSISI_TIDAK_VALID'); // DRAFT -> DISETUJUI
      expect((await aksi(id, 'finalize', s.keu1).expect(409)).body.kode).toBe('TRANSISI_TIDAK_VALID');
      expect((await aksi(id, 'return', s.keu1, { reason: 'perbaiki' }).expect(409)).body.kode).toBe('TRANSISI_TIDAK_VALID');
      await aksi(id, 'verify', s.keu1).expect(200);
      expect((await aksi(id, 'verify', s.keu2).expect(409)).body.kode).toBe('TRANSISI_TIDAK_VALID');
      await aksi(id, 'return', s.keu2, { reason: 'ab' }).expect(400); // alasan minimal 3 karakter
      const d = (await aksi(id, 'return', s.keu2, { reason: 'Nominal makan keliru' }).expect(200)).body;
      expect(d).toMatchObject({ status: 'DRAFT', reviewedBy: null, reviewedAt: null });
      await komponen(id, lineId, s.payabs, { kind: 'INSENTIF', name: 'Bonus', amount: '10' }).expect(201); // dapat disunting lagi
      await aksi(id, 'verify', s.keu2).expect(200); // pemeriksa baru (bukan pembuat/penyunting)
      const h = await tenant([A], (c) => c.query(`SELECT to_status, reason FROM payroll_recap_status_histories WHERE recap_id = $1 ORDER BY created_at, id`, [id]));
      expect(h.rows.map((x) => x.to_status)).toEqual(['DRAFT', 'DIVERIFIKASI', 'DRAFT', 'DIVERIFIKASI']);
      expect(h.rows[2].reason).toBe('Nominal makan keliru');
    });

    it('verifikasi: rekap kosong, absensi belum ditarik, dan rekaman absensi menunggu verifikasi ditolak (pengecekan langsung)', async () => {
      const th = tahun();
      const kosong = (await http('post', '/payroll/periods', s.payabs).send(periodeBody(th)).expect(201)).body;
      expect((await aksi(kosong.id, 'verify', s.keu1).expect(409)).body.kode).toBe('REKAP_KOSONG');
      const th2 = tahun();
      const x = await dasar(A);
      const w = await pekerja(x, 'SINTETIS Tunggu');
      const pend = await rekaman(w, { tanggal: `${th2}-03-05`, waktu: '07:00', status: 'PERLU_VERIFIKASI' });
      const r = (await http('post', '/payroll/periods', s.payabs).send(periodeBody(th2)).expect(201)).body;
      await tenant([A], (c) => c.query(`INSERT INTO payroll_recap_lines (company_id, recap_id, person_id, worker_name, source) VALUES ($1, $2, $3, 'X', 'ATTENDANCE')`, [A, r.id, w.person]));
      expect((await aksi(r.id, 'verify', s.keu1).expect(409)).body.kode).toBe('ABSENSI_BELUM_DITARIK');
      await http('post', `/payroll/recaps/${r.id}/pull`, s.payabs).expect(200);
      const t = (await aksi(r.id, 'verify', s.keu1).expect(409)).body;
      expect(t.kode).toBe('ABSENSI_BELUM_DIVERIFIKASI');
      expect(t.pesan).toMatch(/1 rekaman absensi menunggu verifikasi/);
      await tenant([A], async (c) => {
        await c.query(`INSERT INTO attendance_reviews (company_id, record_id, stage, decision, actor_id, reason) VALUES ($1, $2, 'PERIKSA', 'DIPERIKSA', $3, 'periksa')`, [A, pend, s.payabs.userId]);
        await c.query(`INSERT INTO attendance_reviews (company_id, record_id, stage, decision, actor_id, reason) VALUES ($1, $2, 'PUTUSAN', 'DISETUJUI', $3, 'setuju')`, [A, pend, s.mo.userId]);
      });
      await http('post', `/payroll/recaps/${r.id}/pull`, s.payabs).expect(200); // tarik ulang: hadir 1
      await aksi(r.id, 'verify', s.keu1).expect(200);
    });
  });

  describe('komponen dan masukan', () => {
    it('nominal hanya teks desimal valid; angka JS, 3 desimal, negatif, notasi ilmiah ditolak; subtotal eksak; ubah/hapus; baris absensi terkunci', async () => {
      const { id, lineId } = await siapRekap();
      const salah = async (amount: unknown, pola: RegExp) => expect(JSON.stringify((await komponen(id, lineId, s.payabs, { kind: 'TUNJANGAN', name: 'N', amount }).expect(400)).body)).toMatch(pola);
      for (const v of [100, 0.1, '1.234', '-5', '1e3', '', ' 5', '1,5', '1000000000000', null]) await salah(v, /Nominal harus berupa angka desimal/);
      for (const b of [{ kind: 'GAJI', name: 'N', amount: '1' }, { kind: 'TUNJANGAN', name: '', amount: '1' }, { kind: 'TUNJANGAN', name: 'x'.repeat(81), amount: '1' }]) await komponen(id, lineId, s.payabs, b).expect(400);
      const a = (await komponen(id, lineId, s.payabs, { kind: 'INSENTIF', name: 'Maks', amount: '999999999999.99' }).expect(201)).body;
      expect(a.totals.INSENTIF).toBe('999999999999.99');
      const kid = a.lines[0].components[0].id;
      const u = (await http('put', `/payroll/recaps/${id}/lines/${lineId}/components/${kid}`, s.payabs).send({ amount: '12.5', name: 'Bonus' }).expect(200)).body;
      expect(u.lines[0].components[0]).toMatchObject({ name: 'Bonus', amount: '12.50', kind: 'INSENTIF' });
      await http('put', `/payroll/recaps/${id}/lines/${lineId}/components/${kid}`, s.payabs).send({}).expect(400);
      await http('put', `/payroll/recaps/${id}/lines/${lineId}/components/${UUID_NOL}`, s.payabs).send({ amount: '1' }).expect(404);
      expect((await http('delete', `/payroll/recaps/${id}/lines/${lineId}/components/${kid}`, s.payabs).expect(200)).body.lines[0].components).toHaveLength(0);
      await http('delete', `/payroll/recaps/${id}/lines/${lineId}/components/${kid}`, s.payabs).expect(404);
      await http('post', `/payroll/recaps/${id}/lines/${UUID_NOL}/components`, s.payabs).send({ kind: 'INSENTIF', name: 'N', amount: '1' }).expect(404);
      // baris absensi: angka absensi tidak dapat diubah manual, masukan manual boleh
      expect((await http('put', `/payroll/recaps/${id}/lines/${lineId}`, s.payabs).send({ daysPresent: 30 }).expect(409)).body.kode).toBe('BARIS_ABSENSI_TERKUNCI');
      await http('put', `/payroll/recaps/${id}/lines/${lineId}`, s.payabs).send({ daysLeave: 94 }).expect(400);
      await http('put', `/payroll/recaps/${id}/lines/${lineId}`, s.payabs).send({ overtimeHours: 3.5 }).expect(400); // jam lembur harus teks
      await http('put', `/payroll/recaps/${id}/lines/${lineId}`, s.payabs).send({ gajiPokok: '1' }).expect(400); // bidang tak dikenal (tanpa gaji)
      expect((await http('delete', `/payroll/recaps/${id}/lines/${lineId}`, s.payabs).expect(409)).body.kode).toBe('BARIS_ABSENSI_TERKUNCI');
    });

    it('rekap INTERNAL: baris manual (PayInt), hapus, duplikat; PayAbs tidak menyentuh INTERNAL; baris manual tidak untuk PARTNER; alur penuh internal', async () => {
      const { id } = await siapRekap('payint', { internal: true });
      const orang = (await pool.query(`INSERT INTO persons (display_name) VALUES ('SINTETIS Staf Internal') RETURNING id`)).rows[0].id as string;
      await http('post', `/payroll/recaps/${id}/lines`, s.payabs).send({ personId: orang, workerName: 'SINTETIS Staf Internal' }).expect(403);
      const t = (await http('post', `/payroll/recaps/${id}/lines`, s.payint).send({ personId: orang, workerName: 'SINTETIS Staf Internal' }).expect(201)).body;
      expect((await http('post', `/payroll/recaps/${id}/lines`, s.payint).send({ personId: orang, workerName: 'Dobel' }).expect(409)).body.kode).toBe('BARIS_SUDAH_ADA');
      await http('post', `/payroll/recaps/${id}/lines`, s.payint).send({ personId: UUID_NOL, workerName: 'Tak ada' }).expect(404);
      const lineId = t.lines[0].id;
      const u = (await http('put', `/payroll/recaps/${id}/lines/${lineId}`, s.payint).send({ daysPresent: 20, daysAbsent: 1, daysPermit: 0, daysSick: 1, lateCount: 2, hoursWorked: '160', daysLeave: 0 }).expect(200)).body;
      expect(u.lines[0]).toMatchObject({ source: 'MANUAL', daysPresent: 20, hoursWorked: '160.00', lateCount: 2 });
      await komponen(id, lineId, s.payint, { kind: 'TUNJANGAN', name: 'Tunjangan jabatan', amount: '2500000' }).expect(201);
      await komponen(id, lineId, s.payabs, { kind: 'TUNJANGAN', name: 'X', amount: '1' }).expect(403);
      await http('post', `/payroll/recaps/${id}/pull`, s.payint).expect(409);
      const o2 = (await pool.query(`INSERT INTO persons (display_name) VALUES ('SINTETIS Hapus') RETURNING id`)).rows[0].id as string;
      const l2 = (await http('post', `/payroll/recaps/${id}/lines`, s.payint).send({ personId: o2, workerName: 'SINTETIS Hapus' }).expect(201)).body.lines.find((l: { workerName: string }) => l.workerName === 'SINTETIS Hapus').id;
      await komponen(id, l2, s.payint, { kind: 'POTONGAN', name: 'Kasbon', amount: '1' }).expect(201);
      expect((await http('delete', `/payroll/recaps/${id}/lines/${l2}`, s.payint).expect(200)).body.lineCount).toBe(1);
      // alur internal: Keuangan memeriksa (internal.review), Direktur menyetujui; PayAbs tidak boleh memeriksa
      await aksi(id, 'verify', s.payabs).expect(403);
      await aksi(id, 'verify', s.keu1).expect(200);
      await aksi(id, 'approve', s.dir1).expect(200);
      await aksi(id, 'finalize', s.keu2).expect(200);
      // baris manual tidak untuk PARTNER
      const p = await siapRekap();
      expect((await http('post', `/payroll/recaps/${p.id}/lines`, s.payabs).send({ personId: orang, workerName: 'X' }).expect(409)).body.kode).toBe('BARIS_MANUAL_HANYA_INTERNAL');
      await http('post', `/payroll/recaps/${p.id}/lines`, s.payint).send({ personId: orang, workerName: 'X' }).expect(403); // PayInt tidak punya izin PARTNER
    });
  });

  describe('koreksi resmi bernomor versi', () => {
    it('versi baru bernomor (salinan), versi lama tetap utuh sampai versi baru disetujui lalu DIGANTIKAN; satu koreksi terbuka; hanya dari versi terbaru yang disetujui', async () => {
      const { id, lineId, periodId } = await siapRekap();
      await komponen(id, lineId, s.payabs, { kind: 'TUNJANGAN', name: 'Makan', amount: '100.00' }).expect(201);
      expect((await aksi(id, 'correct', s.payabs, { reason: 'Terlalu dini' }).expect(409)).body.kode).toBe('KOREKSI_TIDAK_VALID'); // masih DRAFT
      await aksi(id, 'verify', s.keu1).expect(200);
      await aksi(id, 'approve', s.dir1).expect(200);
      const v1 = (await http('get', `/payroll/recaps/${id}`, s.dir1).expect(200)).body;

      await aksi(id, 'correct', s.keu1, { reason: 'Keuangan tidak boleh membuat' }).expect(403);
      await aksi(id, 'correct', s.payabs, { reason: 'ab' }).expect(400);
      const v2 = (await aksi(id, 'correct', s.payabs2, { reason: 'Uang makan keliru 100 seharusnya 125' }).expect(201)).body;
      expect(v2).toMatchObject({ versionNo: 2, status: 'DRAFT', createdBy: s.payabs2.userId, correctionReason: 'Uang makan keliru 100 seharusnya 125', reviewedBy: null, approvedBy: null, snapshotHash: null, lastEditedBy: null });
      expect(v2.recapNumber).toMatch(/^KRP\/\d{4}\/\d{5}$/);
      expect(v2.lines[0].id).not.toBe(v1.lines[0].id); // salinan, bukan baris yang sama
      expect(v2.lines[0].components).toMatchObject([{ kind: 'TUNJANGAN', name: 'Makan', amount: '100.00' }]);
      expect((await aksi(id, 'correct', s.payabs, { reason: 'Dobel koreksi' }).expect(409)).body.kode).toBe('VERSI_BUKAN_TERBARU'); // v2 DRAFT sudah terbuka; v1 bukan versi terbaru

      // perubahan pada v2 tidak menyentuh v1 (tetap DISETUJUI dengan hash sama)
      const k = v2.lines[0].components[0].id;
      await http('put', `/payroll/recaps/${v2.id}/lines/${v2.lines[0].id}/components/${k}`, s.payabs2).send({ amount: '125' }).expect(200);
      const v1b = (await http('get', `/payroll/recaps/${id}`, s.dir1).expect(200)).body;
      expect(v1b).toMatchObject({ status: 'DISETUJUI', snapshotHash: v1.snapshotHash });
      expect(v1b.lines[0].components[0].amount).toBe('100.00');

      // v2 menempuh alur penuh; setelah disetujui v1 menjadi DIGANTIKAN (riwayat tercatat)
      await aksi(v2.id, 'verify', s.keu1).expect(200); // pemeriksa boleh sama dengan v1 (baris baru, aturan per versi)
      const ok = (await aksi(v2.id, 'approve', s.dir1).expect(200)).body;
      expect(ok.snapshotHash).not.toBe(v1.snapshotHash);
      expect(await status(id)).toBe('DIGANTIKAN');
      const hv1 = await tenant([A], (c) => c.query(`SELECT to_status, reason FROM payroll_recap_status_histories WHERE recap_id = $1 ORDER BY created_at, id DESC`, [id]));
      expect(hv1.rows.some((r) => r.to_status === 'DIGANTIKAN' && /Digantikan oleh versi 2/.test(r.reason))).toBe(true);
      expect((await aksi(id, 'correct', s.payabs, { reason: 'dari versi lama' }).expect(409)).body.kode).toBe('KOREKSI_TIDAK_VALID');
      const per = (await http('get', `/payroll/periods/${periodId}`, s.dir1).expect(200)).body;
      expect(per.versions.map((x: { versionNo: number; status: string }) => `${x.versionNo}:${x.status}`)).toEqual(['2:DISETUJUI', '1:DIGANTIKAN']);
      // koreksi kedua dari versi 2 (difinalisasi) bernomor berurutan
      await aksi(v2.id, 'finalize', s.keu2).expect(200);
      const v3 = (await aksi(v2.id, 'correct', s.payabs, { reason: 'Koreksi kedua setelah finalisasi' }).expect(201)).body;
      expect(v3.versionNo).toBe(3);
      expect(Number(v3.recapNumber.split('/')[2])).toBeGreaterThan(Number(v2.recapNumber.split('/')[2]));
      expect((await audit('payroll.recap.corrected', v2.id)).length).toBe(1);
    });
  });

  describe('izin dan isolasi', () => {
    it('matriks izin alur: verifikasi (Keuangan), setujui (Direktur/Keuangan), finalisasi (Direktur/Keuangan), sunting (PayAbs); peran lain 403', async () => {
      const { id, lineId } = await siapRekap();
      for (const n of ['mo', 'hrd', 'adm', 'it', 'mkt', 'dir1', 'payabs']) await aksi(id, 'verify', s[n]).expect(403);
      for (const n of ['keu1', 'dir1', 'mo', 'hrd', 'adm', 'it', 'mkt']) await komponen(id, lineId, s[n], { kind: 'INSENTIF', name: 'X', amount: '1' }).expect(403);
      for (const n of ['mo', 'payabs', 'payint', 'hrd', 'it', 'mkt']) await aksi(id, 'approve', s[n]).expect(403);
      for (const n of ['mo', 'payabs', 'payint', 'hrd', 'it', 'mkt', 'adm']) await aksi(id, 'finalize', s[n]).expect(403);
      await aksi(id, 'verify', s.keu1).expect(200);
      await aksi(id, 'approve', s.keu2).expect(200); // Keuangan juga memegang approve (matriks "Persetujuan rekap: A,F")
      await aksi(id, 'finalize', s.dir1).expect(200);
    });

    it('ISOLASI: staf B tidak dapat menyunting, memeriksa, menyetujui, memfinalisasi, atau mengoreksi rekap A (404)', async () => {
      const { id, lineId } = await siapRekap();
      await komponen(id, lineId, s.payabsB, { kind: 'INSENTIF', name: 'X', amount: '1' }).expect(404);
      await http('put', `/payroll/recaps/${id}/lines/${lineId}`, s.payabsB).send({ daysLeave: 1 }).expect(404);
      await aksi(id, 'verify', s.keuB).expect(404);
      await aksi(id, 'approve', s.dirB).expect(404);
      await aksi(id, 'finalize', s.dirB).expect(404);
      await aksi(id, 'correct', s.payabsB, { reason: 'bukan milik saya' }).expect(404);
      expect(await status(id)).toBe('DRAFT');
      expect((await tenant([A], (c) => c.query(`SELECT count(*)::int AS n FROM payroll_components WHERE line_id = $1`, [lineId]))).rows[0].n).toBe(0);
    });
  });
});
