import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
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
const UUID_NOL = '00000000-0000-4000-8000-000000000000';

// Semua data di bawah SINTETIS.
jalan('Absensi: titik/QR, shift, jadwal, dan libur (PostgreSQL asli)', () => {
  let app: INestApplication;
  let pool: Pool;
  let nomorIp = 1;
  let A: string;
  let B: string;
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
    pool = new Pool({ connectionString: DB_URL, max: 4 });
    A = (await pool.query(`INSERT INTO companies (name) VALUES ($1) RETURNING id`, [`PT SINTETIS A ${randomBytes(3).toString('hex')}`])).rows[0].id;
    B = (await pool.query(`INSERT INTO companies (name) VALUES ($1) RETURNING id`, [`PT SINTETIS B ${randomBytes(3).toString('hex')}`])).rows[0].id;
    for (const [nama, role, scope] of [['mo', 'MANAGER_OPERASIONAL', [A]], ['moB', 'MANAGER_OPERASIONAL', [B]], ['adm', 'STAFF_ADMINISTRASI', [A]], ['dir', 'DIREKTUR', [A]], ['it', 'IT_ADMIN', [A]], ['payabs', 'STAFF_PAYROLL_ABSENSI_REKANAN', [A]], ['hrd', 'HRD', [A]], ['mkt', 'MARKETING', [A]]] as const) s[nama] = await buatStaff(role, [...scope]);
  });
  afterAll(async () => {
    await pool?.end();
    await app?.close();
  });

  const ipBaru = () => `10.60.${Math.floor(nomorIp / 250)}.${(nomorIp++ % 250) + 1}`;
  const http = (metode: 'get' | 'post' | 'patch' | 'delete', path: string, x: Sesi) =>
    request(app.getHttpServer())[metode](path).set('X-Forwarded-For', ipBaru()).set('Origin', ORIGIN).set('Cookie', x.cookie).set('X-CSRF-Token', x.csrf);
  const buatStaff = async (role: string, companyIds: string[]): Promise<Sesi> => {
    const u = (await pool.query(`INSERT INTO users (realm, email, status) VALUES ('staff', $1, 'AKTIF') RETURNING id`, [`s-${randomBytes(4).toString('hex')}@contoh.invalid`])).rows[0].id as string;
    await pool.query(`INSERT INTO user_roles (user_id, role_code, grant_source) VALUES ($1, $2, 'MANUAL')`, [u, role]);
    for (const c of companyIds) await pool.query(`INSERT INTO user_company_scopes (user_id, scope_company_id) VALUES ($1, $2)`, [u, c]);
    const x = await sessions.buat({ userId: u, realm: 'staff', state: 'PENUH' });
    return { cookie: `__Host-sid=${x.token}`, csrf: x.csrfToken, userId: u };
  };
  const tenant = async <T>(companyIds: string[], fn: (c: import('pg').PoolClient) => Promise<T>): Promise<T> => {
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
  /** Lokasi rekanan sintetis; koordinat opsional. */
  const lokasiBaru = (company: string, koordinat = true) =>
    tenant([company], async (c) => {
      const p = (await c.query(`INSERT INTO partners (company_id, name, created_by) VALUES ($1, $2, $3) RETURNING id`, [company, `Rek ${randomBytes(3).toString('hex')}`, s.mo.userId])).rows[0].id;
      return (await c.query(`INSERT INTO partner_locations (company_id, partner_id, name, latitude, longitude, geofence_radius_m, created_by) VALUES ($1, $2, 'Lokasi Uji', $3, $4, 100, $5) RETURNING id`, [company, p, koordinat ? -6.9 : null, koordinat ? 107.6 : null, s.mo.userId])).rows[0].id as string;
    });
  const penempatanBaru = (company: string, lokasi: string) =>
    tenant([company], async (c) => {
      const person = (await pool.query(`INSERT INTO persons (display_name) VALUES ('SINTETIS Pekerja') RETURNING id`)).rows[0].id;
      return (await c.query(`INSERT INTO placements (company_id, person_id, location_id, start_date, end_date, created_by) VALUES ($1, $2, $3, '2026-01-01', '2026-12-31', $4) RETURNING id`, [company, person, lokasi, s.mo.userId])).rows[0].id as string;
    });
  const audit = async (aksi: string, objekId: string) => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.company_ids', $1, true)`, [[A, B].join(',')]);
      const r = await c.query(`SELECT detail FROM audit_logs WHERE action = $1 AND object_id = $2`, [aksi, objekId]);
      await c.query('COMMIT');
      return r.rows;
    } finally {
      c.release();
    }
  };

  describe('titik absensi dan QR', () => {
    it('matriks izin: lihat (Direktur, Mgr Ops, IT, PayAbs), buat/ubah (Mgr Ops, Adm), nonaktifkan (Mgr Ops); lainnya 403', async () => {
      const lok = await lokasiBaru(A);
      const buat = (x: Sesi, l: string) => http('post', '/attendance/points', x).send({ locationId: l });
      for (const n of ['hrd', 'mkt', 'dir', 'it', 'payabs']) await buat(s[n], lok).expect(403);
      const titik = (await buat(s.mo, lok).expect(201)).body;
      expect(titik).toMatchObject({ locationId: lok, status: 'AKTIF', hasCoordinates: true, geofenceRadiusM: 100 });
      for (const n of ['mo', 'dir', 'it', 'payabs']) await http('get', `/attendance/points/${titik.id}`, s[n]).expect(200);
      for (const n of ['adm', 'hrd', 'mkt']) await http('get', `/attendance/points/${titik.id}`, s[n]).expect(403);
      for (const n of ['hrd', 'mkt', 'dir', 'it', 'payabs']) await http('post', `/attendance/points/${titik.id}/rotate-code`, s[n]).expect(403);
      for (const n of ['hrd', 'mkt', 'dir', 'it', 'payabs', 'adm']) await http('post', `/attendance/points/${titik.id}/deactivate`, s[n]).expect(403);
      for (const n of ['mo', 'dir', 'it', 'payabs', 'hrd', 'mkt']) await http('get', `/attendance/points/${titik.id}/qr.pdf`, s[n]).expect(403); // hanya Adm yang memegang export
      await http('get', `/attendance/points/${titik.id}/qr.pdf`, s.adm).expect(200);
      const lok2 = await lokasiBaru(A);
      await buat(s.adm, lok2).expect(201);
    });

    it('validasi: lokasi tanpa koordinat, lokasi tidak ada, titik ganda, body tidak valid', async () => {
      const tanpaKoordinat = await lokasiBaru(A, false);
      expect((await http('post', '/attendance/points', s.mo).send({ locationId: tanpaKoordinat }).expect(409)).body.kode).toBe('KOORDINAT_LOKASI_KOSONG');
      await http('post', '/attendance/points', s.mo).send({ locationId: UUID_NOL }).expect(404);
      const r = await http('post', '/attendance/points', s.mo).send({ locationId: 'bukan-uuid' }).expect(400);
      expect(JSON.stringify(r.body)).toMatch(/ID lokasi tidak valid/);
      const lok = await lokasiBaru(A);
      await http('post', '/attendance/points', s.mo).send({ locationId: lok }).expect(201);
      expect((await http('post', '/attendance/points', s.mo).send({ locationId: lok }).expect(409)).body.kode).toBe('TITIK_SUDAH_ADA');
    });

    it('QR PDF valid, memuat gambar QR, diaudit; ganti kode membatalkan kode lama; nonaktif tidak dapat dicetak', async () => {
      const lok = await lokasiBaru(A);
      const t = (await http('post', '/attendance/points', s.mo).send({ locationId: lok }).expect(201)).body;
      const pdf = await http('get', `/attendance/points/${t.id}/qr.pdf`, s.adm).buffer(true).parse((res, cb) => { const d: Buffer[] = []; res.on('data', (x: Buffer) => d.push(x)); res.on('end', () => cb(null, Buffer.concat(d))); }).expect(200);
      expect(pdf.headers['content-type']).toMatch(/application\/pdf/);
      expect(pdf.headers['cache-control']).toMatch(/no-store/);
      const isi = pdf.body as Buffer;
      expect(isi.subarray(0, 5).toString()).toBe('%PDF-');
      expect(isi.toString('latin1')).toMatch(/\/Subtype\s*\/Image/);
      expect(await audit('attendance.point.qr_printed', t.id)).toHaveLength(1);
      const { urlTitik } = await import('../src/attendance/points.service');
      expect(urlTitik(ORIGIN, t.publicCode)).toBe(`${ORIGIN}/absen?t=${t.publicCode}`);

      const baru = (await http('post', `/attendance/points/${t.id}/rotate-code`, s.mo).expect(200)).body;
      expect(baru.publicCode).not.toBe(t.publicCode);
      expect((await tenant([A], (c) => c.query(`SELECT 1 FROM attendance_points WHERE public_code = $1`, [t.publicCode]))).rowCount).toBe(0);
      expect(await audit('attendance.point.code_rotated', t.id)).toHaveLength(1);

      await http('post', `/attendance/points/${t.id}/deactivate`, s.mo).expect(200);
      expect((await http('post', `/attendance/points/${t.id}/deactivate`, s.mo).expect(409)).body.kode).toBe('TRANSISI_TIDAK_VALID');
      expect((await http('get', `/attendance/points/${t.id}/qr.pdf`, s.adm).expect(409)).body.kode).toBe('TITIK_NONAKTIF');
      expect((await http('post', `/attendance/points/${t.id}/rotate-code`, s.mo).expect(409)).body.kode).toBe('TITIK_NONAKTIF');
      await http('post', '/attendance/points', s.mo).send({ locationId: lok }).expect(201); // lokasi dapat diberi titik baru
      for (const e of [...(await audit('attendance.point.created', t.id)), ...(await audit('attendance.point.qr_printed', t.id))]) expect(JSON.stringify(e)).not.toMatch(/publicCode|public_code|latitude/);
    });

    it('daftar: keyset, batas halaman, filter; hanya perusahaan dalam scope', async () => {
      const awal = (await http('get', '/attendance/points?limit=2', s.mo).expect(200)).body;
      expect(awal.items.length).toBeLessThanOrEqual(2);
      if (awal.nextCursor) {
        const lanjut = (await http('get', `/attendance/points?limit=2&cursor=${encodeURIComponent(awal.nextCursor)}`, s.mo).expect(200)).body;
        expect(lanjut.items.map((x: { id: string }) => x.id)).not.toEqual(expect.arrayContaining([awal.items[0].id]));
      }
      await http('get', '/attendance/points?limit=101', s.mo).expect(400);
      await http('get', '/attendance/points?status=SALAH', s.mo).expect(400);
      expect((await http('get', '/attendance/points?status=NONAKTIF', s.mo).expect(200)).body.items.every((x: { status: string }) => x.status === 'NONAKTIF')).toBe(true);
    });

    it('ISOLASI: staf A tidak melihat/ubah/cetak titik perusahaan B dan tidak dapat memasang titik di lokasi B (404)', async () => {
      const lokB = await lokasiBaru(B);
      const tB = (await http('post', '/attendance/points', s.moB).send({ locationId: lokB }).expect(201)).body;
      await http('get', `/attendance/points/${tB.id}`, s.mo).expect(404);
      await http('get', `/attendance/points/${tB.id}/qr.pdf`, s.adm).expect(404);
      await http('post', `/attendance/points/${tB.id}/rotate-code`, s.mo).expect(404);
      await http('post', `/attendance/points/${tB.id}/deactivate`, s.mo).expect(404);
      await http('post', '/attendance/points', s.mo).send({ locationId: lokB }).expect(404);
      const daftar = (await http('get', '/attendance/points?limit=100', s.mo).expect(200)).body.items;
      expect(daftar.map((x: { id: string }) => x.id)).not.toContain(tB.id);
      expect((await tenant([B], (c) => c.query(`SELECT status FROM attendance_points WHERE id = $1`, [tB.id]))).rows[0].status).toBe('AKTIF'); // tidak berubah
    });
  });

  describe('shift', () => {
    it('buat shift lintas tengah malam dihitung server; nama unik; matriks izin placement.*', async () => {
      const nama = `Malam ${randomBytes(3).toString('hex')}`;
      const sh = (await http('post', '/attendance/shifts', s.hrd).send({ name: nama, startTime: '22:00', endTime: '06:00' }).expect(201)).body;
      expect(sh).toMatchObject({ name: nama, kind: 'FIXED', startTime: '22:00', endTime: '06:00', crossesMidnight: true, lateToleranceMin: 15, earlyToleranceMin: 30, status: 'AKTIF' });
      const pagi = (await http('post', '/attendance/shifts', s.mo).send({ name: `Pagi ${randomBytes(3).toString('hex')}`, startTime: '07:00', endTime: '15:00', lateToleranceMin: 10 }).expect(201)).body;
      expect(pagi.crossesMidnight).toBe(false);
      expect((await http('post', '/attendance/shifts', s.hrd).send({ name: nama, startTime: '22:00', endTime: '06:00' }).expect(409)).body.kode).toBe('SHIFT_NAMA_SUDAH_ADA');
      for (const n of ['payabs', 'mkt', 'adm', 'dir', 'it']) await http('post', '/attendance/shifts', s[n]).send({ name: 'X', startTime: '07:00', endTime: '15:00' }).expect(403);
      for (const n of ['payabs', 'hrd', 'mo']) await http('patch', `/attendance/shifts/${pagi.id}`, s[n]).send({ lateToleranceMin: 20 }).expect(200); // PayAbs: "U(shift)"
      for (const n of ['mkt', 'adm', 'dir', 'it']) await http('patch', `/attendance/shifts/${pagi.id}`, s[n]).send({ lateToleranceMin: 20 }).expect(403);
      for (const n of ['payabs', 'hrd', 'mo', 'mkt', 'adm', 'dir']) await http('get', '/attendance/shifts', s[n]).expect(200);
      await http('get', '/attendance/shifts', s.it).expect(403);
      expect((await audit('attendance.shift.created', sh.id)).length).toBe(1);
    });

    it('validasi masukan berbahasa Indonesia', async () => {
      const kirim = (b: object) => http('post', '/attendance/shifts', s.mo).send(b);
      expect(JSON.stringify((await kirim({ name: 'X', startTime: '25:00', endTime: '06:00' }).expect(400)).body)).toMatch(/Jam mulai: format harus HH:MM/);
      expect(JSON.stringify((await kirim({ name: 'X', startTime: '07:00', endTime: '07:00' }).expect(400)).body)).toMatch(/tidak boleh sama/);
      expect(JSON.stringify((await kirim({ name: 'X', startTime: '07:00', endTime: '15:00', lateToleranceMin: 241 }).expect(400)).body)).toMatch(/maksimal 240/);
      expect(JSON.stringify((await kirim({ name: '  ', startTime: '07:00', endTime: '15:00' }).expect(400)).body)).toMatch(/Nama shift wajib diisi/);
      await kirim({ name: 'X', kind: 'LAIN', startTime: '07:00', endTime: '15:00' }).expect(400);
      await http('patch', `/attendance/shifts/${UUID_NOL}`, s.mo).send({ status: 'NONAKTIF' }).expect(404);
      await http('patch', `/attendance/shifts/${UUID_NOL}`, s.mo).send({}).expect(400);
    });

    it('ISOLASI: shift perusahaan B tidak terlihat atau terubah oleh staf A', async () => {
      const shB = (await http('post', '/attendance/shifts', s.moB).send({ name: `B ${randomBytes(3).toString('hex')}`, startTime: '07:00', endTime: '15:00' }).expect(201)).body;
      await http('patch', `/attendance/shifts/${shB.id}`, s.mo).send({ status: 'NONAKTIF' }).expect(404);
      expect((await http('get', '/attendance/shifts?limit=100', s.mo).expect(200)).body.items.map((x: { id: string }) => x.id)).not.toContain(shB.id);
      expect((await http('post', '/attendance/shifts', s.mo).send({ companyId: B, name: 'Z', startTime: '07:00', endTime: '15:00' }).expect(404)).body.kode).toBe('PERUSAHAAN_TIDAK_DITEMUKAN');
    });
  });

  describe('jadwal kerja', () => {
    it('buat, tolak tabrakan, tolak shift/penempatan lintas perusahaan, hapus; izin; validasi', async () => {
      const lok = await lokasiBaru(A);
      const pl = await penempatanBaru(A, lok);
      const sh = (await http('post', '/attendance/shifts', s.mo).send({ name: `J ${randomBytes(3).toString('hex')}`, startTime: '07:00', endTime: '15:00' }).expect(201)).body;
      const shB = (await http('post', '/attendance/shifts', s.moB).send({ name: `JB ${randomBytes(3).toString('hex')}`, startTime: '07:00', endTime: '15:00' }).expect(201)).body;
      const kirim = (x: Sesi, b: object) => http('post', '/attendance/schedules', x).send(b);
      const dasar = { placementId: pl, shiftId: sh.id, workDays: [1, 2, 3, 4, 5], validFrom: '2026-03-01', validTo: '2026-06-30' };
      for (const n of ['mkt', 'adm', 'dir', 'it']) await kirim(s[n], dasar).expect(403);
      const j = (await kirim(s.payabs, dasar).expect(201)).body;
      expect(j).toMatchObject({ placementId: pl, workDays: [1, 2, 3, 4, 5], validFrom: '2026-03-01', validTo: '2026-06-30' });
      expect((await kirim(s.hrd, { ...dasar, workDays: [5, 6], validFrom: '2026-06-01' }).expect(409)).body.kode).toBe('JADWAL_BERTABRAKAN');
      await kirim(s.hrd, { ...dasar, workDays: [6, 7], validFrom: '2026-06-01' }).expect(201); // hari berbeda: boleh
      await kirim(s.hrd, { ...dasar, workDays: [1], validFrom: '2026-07-01', validTo: undefined }).expect(201); // periode berbeda: boleh
      await kirim(s.hrd, { ...dasar, shiftId: shB.id, workDays: [7], validFrom: '2027-01-01', validTo: undefined }).expect(404); // shift perusahaan lain
      await kirim(s.hrd, { ...dasar, placementId: UUID_NOL }).expect(404);
      expect(JSON.stringify((await kirim(s.hrd, { ...dasar, workDays: [0, 8] }).expect(400)).body)).toBeDefined();
      expect(JSON.stringify((await kirim(s.hrd, { ...dasar, workDays: [1, 1] }).expect(400)).body)).toMatch(/tidak boleh ganda/);
      expect(JSON.stringify((await kirim(s.hrd, { ...dasar, validTo: '2026-02-01' }).expect(400)).body)).toMatch(/tidak boleh sebelum/);
      const daftar = (await http('get', `/attendance/schedules?placementId=${pl}`, s.mkt).expect(200)).body.items;
      expect(daftar).toHaveLength(3);
      await http('delete', `/attendance/schedules/${j.id}`, s.mkt).expect(403);
      await http('delete', `/attendance/schedules/${j.id}`, s.hrd).expect(204);
      await http('delete', `/attendance/schedules/${j.id}`, s.hrd).expect(404);
      expect((await audit('attendance.schedule.deleted', j.id)).length).toBe(1);
    });

    it('penempatan yang sudah selesai tidak dapat dijadwalkan; ISOLASI: penempatan B tidak terjangkau staf A', async () => {
      const sh = (await http('post', '/attendance/shifts', s.mo).send({ name: `K ${randomBytes(3).toString('hex')}`, startTime: '07:00', endTime: '15:00' }).expect(201)).body;
      const plSelesai = await penempatanBaru(A, await lokasiBaru(A));
      await tenant([A], (c) => c.query(`UPDATE placements SET status = 'DIBATALKAN' WHERE id = $1`, [plSelesai]));
      const dasar = { shiftId: sh.id, workDays: [1], validFrom: '2026-03-01' };
      expect((await http('post', '/attendance/schedules', s.hrd).send({ ...dasar, placementId: plSelesai }).expect(409)).body.kode).toBe('PENEMPATAN_TIDAK_BERJALAN');
      const plB = await penempatanBaru(B, await lokasiBaru(B));
      await http('post', '/attendance/schedules', s.hrd).send({ ...dasar, placementId: plB }).expect(404);
      expect((await http('get', `/attendance/schedules?placementId=${plB}`, s.hrd).expect(200)).body.items).toHaveLength(0);
    });
  });

  describe('hari libur', () => {
    it('buat nasional/perusahaan/lokasi; tolak duplikat dan kombinasi tidak sah; hapus; izin', async () => {
      const lok = await lokasiBaru(A);
      const tahun = 2090 + Math.floor(Math.random() * 9);
      const kirim = (x: Sesi, b: object) => http('post', '/attendance/holidays', x).send(b);
      for (const n of ['mkt', 'adm', 'dir', 'it']) await kirim(s[n], { date: `${tahun}-08-17`, scope: 'NASIONAL', name: 'X' }).expect(403);
      const nas = (await kirim(s.payabs, { date: `${tahun}-08-17`, scope: 'NASIONAL', name: 'Hari Uji Nasional' }).expect(201)).body;
      expect(nas).toMatchObject({ date: `${tahun}-08-17`, scope: 'NASIONAL', locationId: null });
      expect((await kirim(s.hrd, { date: `${tahun}-08-17`, scope: 'NASIONAL', name: 'Ganda' }).expect(409)).body.kode).toBe('LIBUR_SUDAH_ADA');
      await kirim(s.hrd, { date: `${tahun}-08-17`, scope: 'PERUSAHAAN', name: 'Libur perusahaan' }).expect(201);
      await kirim(s.hrd, { date: `${tahun}-08-17`, scope: 'LOKASI', locationId: lok, name: 'Libur lokasi' }).expect(201);
      expect(JSON.stringify((await kirim(s.hrd, { date: `${tahun}-08-18`, scope: 'LOKASI', name: 'X' }).expect(400)).body)).toMatch(/Lokasi wajib untuk cakupan LOKASI/);
      await kirim(s.hrd, { date: `${tahun}-08-18`, scope: 'NASIONAL', locationId: lok, name: 'X' }).expect(400);
      await kirim(s.hrd, { date: `${tahun}-02-30`, scope: 'NASIONAL', name: 'X' }).expect(400);
      await kirim(s.hrd, { date: `${tahun}-08-18`, scope: 'LOKASI', locationId: await lokasiBaru(B), name: 'X' }).expect(404); // lokasi perusahaan lain
      const daftar = (await http('get', `/attendance/holidays?year=${tahun}`, s.mkt).expect(200)).body.items;
      expect(daftar).toHaveLength(3);
      await http('delete', `/attendance/holidays/${nas.id}`, s.mkt).expect(403);
      await http('delete', `/attendance/holidays/${nas.id}`, s.hrd).expect(204);
      await http('delete', `/attendance/holidays/${nas.id}`, s.hrd).expect(404);
    });

    it('ISOLASI: libur perusahaan B tidak terlihat/terhapus oleh staf A', async () => {
      const tahun = 2080 + Math.floor(Math.random() * 9);
      const hB = (await http('post', '/attendance/holidays', s.moB).send({ date: `${tahun}-01-01`, scope: 'PERUSAHAAN', name: 'Libur B' }).expect(201)).body;
      expect((await http('get', `/attendance/holidays?year=${tahun}`, s.mo).expect(200)).body.items).toHaveLength(0);
      await http('delete', `/attendance/holidays/${hB.id}`, s.hrd).expect(404);
      expect((await tenant([B], (c) => c.query(`SELECT 1 FROM holidays WHERE id = $1`, [hB.id]))).rowCount).toBe(1);
    });
  });
});
