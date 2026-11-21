import 'reflect-metadata';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool, PoolClient } from 'pg';
import request from 'supertest';
import { enkripsiBerkas } from '../src/common/crypto/pii';
import { buatKunciObjek } from '../src/common/storage/object-storage';
import { urlAplikasiTanpaBypass } from './helpers/role-app';

const DB_URL = process.env.TEST_DATABASE_URL;
const jalan = DB_URL ? describe : describe.skip;

const ORIGIN = 'https://hris.contoh.invalid';
process.env.APP_BASE_URL = ORIGIN;
process.env.AUTH_HMAC_KEY = randomBytes(32).toString('base64');
process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString('base64');
process.env.TRUST_PROXY = '1';
const STORAGE = mkdtempSync(join(tmpdir(), 'hris-absen-ops-'));
process.env.STORAGE_DIR = STORAGE;

interface Sesi { cookie: string; csrf: string; userId: string }
interface Dasar { company: string; lok: string; titik: string; person: string; placement: string }
const UUID_NOL = '00000000-0000-4000-8000-000000000000';
const wib = (s: string) => new Date(`${s.replace(' ', 'T')}:00+07:00`);
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('SELFIE-SINTETIS-OPS'), randomBytes(1500)]);

// Semua data SINTETIS.
jalan('Absensi staf: tinjauan, selfie, retensi, koreksi, dan rekap (PostgreSQL asli)', () => {
  let app: INestApplication;
  let pool: Pool;
  let nomorIp = 1;
  let A: string;
  let B: string;
  let sessions: import('../src/auth/session.service').SessionService;
  let storage: import('../src/common/storage/object-storage').ObjectStorage;
  let selfieSvc: import('../src/attendance/selfie.service').SelfieService;
  let recapSvc: import('../src/attendance/recap.service').RecapService;
  let kunciEnk: Buffer;
  let dA: Dasar;
  let dB: Dasar;
  let u1: string;
  const s: Record<string, Sesi> = {};

  beforeAll(async () => {
    execFileSync('node', ['scripts/migrate.js', 'up'], { env: { ...process.env, DATABASE_URL: DB_URL } });
    const { AppModule } = await import('../src/app.module');
    const { konfigurasiApp } = await import('../src/app.factory');
    const { SessionService } = await import('../src/auth/session.service');
    const { JAM_ABSENSI } = await import('../src/attendance/jam');
    const { OBJECT_STORAGE } = await import('../src/common/storage/object-storage');
    const { SelfieService } = await import('../src/attendance/selfie.service');
    const { RecapService } = await import('../src/attendance/recap.service');
    process.env.DATABASE_URL = await urlAplikasiTanpaBypass(DB_URL!);
    const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(JAM_ABSENSI).useValue(() => wib('2026-03-20 10:00')).compile();
    app = mod.createNestApplication();
    konfigurasiApp(app);
    await app.init();
    sessions = app.get(SessionService);
    storage = app.get(OBJECT_STORAGE);
    selfieSvc = app.get(SelfieService);
    recapSvc = app.get(RecapService);
    kunciEnk = Buffer.from(process.env.APP_ENCRYPTION_KEY!, 'base64');
    pool = new Pool({ connectionString: DB_URL, max: 6 });
    A = (await pool.query(`INSERT INTO companies (name) VALUES ($1) RETURNING id`, [`PT SINTETIS A ${randomBytes(3).toString('hex')}`])).rows[0].id;
    B = (await pool.query(`INSERT INTO companies (name) VALUES ($1) RETURNING id`, [`PT SINTETIS B ${randomBytes(3).toString('hex')}`])).rows[0].id;
    for (const [nama, roles, scope] of [
      ['mo', ['MANAGER_OPERASIONAL'], [A]], ['moB', ['MANAGER_OPERASIONAL'], [B]], ['payabs', ['STAFF_PAYROLL_ABSENSI_REKANAN'], [A]], ['payabsB', ['STAFF_PAYROLL_ABSENSI_REKANAN'], [B]],
      ['payint', ['STAFF_PAYROLL_INTERNAL'], [A]], ['dir', ['DIREKTUR'], [A]], ['adm', ['STAFF_ADMINISTRASI'], [A]], ['hrd', ['HRD'], [A]], ['it', ['IT_ADMIN'], [A]], ['mkt', ['MARKETING'], [A]], ['fin', ['STAFF_KEUANGAN'], [A]],
      ['ganda', ['MANAGER_OPERASIONAL', 'STAFF_PAYROLL_ABSENSI_REKANAN'], [A]], // melanggar pemisahan tugas bila memeriksa lalu memutuskan sendiri
    ] as const) s[nama] = await buatStaff([...roles], [...scope]);
    u1 = s.mo.userId;
    dA = await dasar(A);
    dB = await dasar(B);
  });
  afterAll(async () => {
    await pool?.end();
    await app?.close();
    fs.rmSync(STORAGE, { recursive: true, force: true });
  });

  const ipBaru = () => `10.80.${Math.floor(nomorIp / 250)}.${(nomorIp++ % 250) + 1}`;
  const http = (metode: 'get' | 'post' | 'patch', path: string, x: Sesi) => request(app.getHttpServer())[metode](path).set('X-Forwarded-For', ipBaru()).set('Origin', ORIGIN).set('Cookie', x.cookie).set('X-CSRF-Token', x.csrf);
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
  /** Lokasi, titik, pekerja, dan penempatan (DIRENCANAKAN cukup: rekaman dibuat langsung lewat DB). */
  const dasar = async (company: string, nama = 'SINTETIS Pekerja'): Promise<Dasar> => {
    const person = (await pool.query(`INSERT INTO persons (display_name) VALUES ($1) RETURNING id`, [nama])).rows[0].id as string;
    return tenant([company], async (c) => {
      const p = (await c.query(`INSERT INTO partners (company_id, name, created_by) VALUES ($1, $2, $3) RETURNING id`, [company, `Rek ${randomBytes(3).toString('hex')}`, u1])).rows[0].id;
      const lok = (await c.query(`INSERT INTO partner_locations (company_id, partner_id, name, latitude, longitude, created_by) VALUES ($1, $2, 'Lokasi Ops', -6.9, 107.6, $3) RETURNING id`, [company, p, u1])).rows[0].id;
      const titik = (await c.query(`INSERT INTO attendance_points (company_id, location_id, created_by) VALUES ($1, $2, $3) RETURNING id`, [company, lok, u1])).rows[0].id;
      const placement = (await c.query(`INSERT INTO placements (company_id, person_id, location_id, start_date, end_date, created_by) VALUES ($1, $2, $3, '2026-01-01', '2026-12-31', $4) RETURNING id`, [company, person, lok, u1])).rows[0].id;
      return { company, lok, titik, person, placement };
    });
  };
  /** Pekerja tambahan di lokasi yang sama. */
  const pekerja = async (x: Dasar, nama?: string): Promise<Dasar> => {
    const person = (await pool.query(`INSERT INTO persons (display_name) VALUES ('SINTETIS Pekerja') RETURNING id`)).rows[0].id as string;
    if (nama) await pool.query(`INSERT INTO member_profiles (person_id, full_name) VALUES ($1, $2)`, [person, nama]);
    const placement = await tenant([x.company], async (c) => (await c.query(`INSERT INTO placements (company_id, person_id, location_id, start_date, end_date, created_by) VALUES ($1, $2, $3, '2026-01-01', '2026-12-31', $4) RETURNING id`, [x.company, person, x.lok, u1])).rows[0].id as string);
    return { ...x, person, placement };
  };
  const rekaman = (x: Dasar, o: { kind?: string; status?: string; alasan?: string | null; tanggal?: string; waktu?: string; flags?: string[]; device?: string | null } = {}) =>
    tenant([x.company], async (c) => {
      const tanggal = o.tanggal ?? '2026-03-18';
      const status = o.status ?? 'PERLU_VERIFIKASI';
      const id = (await c.query(
        `INSERT INTO attendance_records (company_id, person_id, placement_id, point_id, location_id, device_id, kind, status, reject_reason, shift_date, occurred_at, latitude, longitude, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, -6.9, 107.6, $12) RETURNING id`,
        [x.company, x.person, x.placement, x.titik, x.lok, o.device ?? null, o.kind ?? 'MASUK', status, status === 'DITOLAK' ? o.alasan ?? 'LUAR_RADIUS' : null, tanggal, wib(o.waktu ?? `${tanggal} 07:00`), `ops-${randomBytes(8).toString('hex')}`],
      )).rows[0].id as string;
      for (const f of o.flags ?? []) await c.query(`INSERT INTO attendance_flags (company_id, record_id, code, score) VALUES ($1, $2, $3, 20)`, [x.company, id, f]);
      return id;
    });
  const perangkat = (x: Dasar, status = 'PERLU_VERIFIKASI') => tenant([x.company], async (c) => (await c.query(`INSERT INTO device_registrations (company_id, person_id, device_hash, status) VALUES ($1, $2, $3, $4) RETURNING id`, [x.company, x.person, randomBytes(32).toString('hex'), status])).rows[0].id as string);
  const selfie = async (x: Dasar, recordId: string, o: { purgeAfter?: string; hold?: boolean } = {}) => {
    const foto = jpeg();
    const kunci = buatKunciObjek(x.company);
    await storage.simpan(kunci, enkripsiBerkas(foto, kunciEnk, kunci));
    await tenant([x.company], (c) => c.query(`INSERT INTO attendance_selfies (company_id, record_id, storage_key, sha256, size_bytes, purge_after, legal_hold) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [x.company, recordId, kunci, createHash('sha256').update(foto).digest('hex'), foto.length, wib(o.purgeAfter ?? '2026-09-01 00:00'), o.hold ?? false]));
    return { foto, kunci };
  };
  const audit = async (aksi: string, objekId: string) => tenant([A, B], async (c) => (await c.query(`SELECT detail, actor_id FROM audit_logs WHERE action = $1 AND object_id = $2`, [aksi, objekId])).rows);
  const dbRec = async (id: string) => (await tenant([A, B], (c) => c.query(`SELECT status FROM attendance_records WHERE id = $1`, [id]))).rows[0];

  describe('tinjauan dua langkah', () => {
    it('izin daftar: Direktur (view), PayAbs/PayInt (review), Mgr Ops (approve); selain itu 403', async () => {
      for (const n of ['dir', 'payabs', 'payint', 'mo']) await http('get', '/attendance/review', s[n]).expect(200);
      for (const n of ['adm', 'hrd', 'it', 'mkt', 'fin']) await http('get', '/attendance/review', s[n]).expect(403);
    });

    it('alur: periksa -> putus; rekaman asli tidak berubah; perangkat disetujui bersama; urutan dan pemisahan tugas ditegakkan', async () => {
      const dev = await perangkat(dA);
      const id = await rekaman(dA, { flags: ['PERANGKAT_BARU'], device: dev });
      const antre = (await http('get', '/attendance/review?tahap=MENUNGGU_PERIKSA&limit=100', s.mo).expect(200)).body.items;
      expect(antre.find((x: { id: string }) => x.id === id)).toMatchObject({ tahap: 'MENUNGGU_PERIKSA', status: 'PERLU_VERIFIKASI', flags: ['PERANGKAT_BARU'], deviceStatus: 'PERLU_VERIFIKASI', workerName: 'Tanpa nama' });
      // putusan sebelum pemeriksaan ditolak; izin berlawanan ditolak
      expect((await http('post', `/attendance/review/${id}/decide`, s.mo).send({ decision: 'DISETUJUI', reason: 'tes' }).expect(409)).body.kode).toBe('BELUM_DIPERIKSA');
      await http('post', `/attendance/review/${id}/check`, s.mo).send({ reason: 'tes' }).expect(403);
      await http('post', `/attendance/review/${id}/check`, s.dir).send({ reason: 'tes' }).expect(403);
      await http('post', `/attendance/review/${id}/check`, s.payabs).send({ reason: 'ab' }).expect(400); // alasan minimal 3 karakter
      await http('post', `/attendance/review/${id}/check`, s.payabs).send({ reason: 'Foto dan lokasi wajar' }).expect(200);
      expect((await http('post', `/attendance/review/${id}/check`, s.payint).send({ reason: 'ulang' }).expect(409)).body.kode).toBe('SUDAH_DIPERIKSA');
      await http('post', `/attendance/review/${id}/decide`, s.payabs).send({ decision: 'DISETUJUI', reason: 'tes' }).expect(403); // PayAbs tidak boleh memutuskan
      await http('post', `/attendance/review/${id}/decide`, s.mo).send({ decision: 'MUNGKIN', reason: 'tes' }).expect(400);
      expect((await http('get', `/attendance/review/${id}`, s.mo).expect(200)).body).toMatchObject({ tahap: 'MENUNGGU_PUTUSAN', latitude: -6.9, reviews: [{ stage: 'PERIKSA', decision: 'DIPERIKSA', reason: 'Foto dan lokasi wajar' }], selfie: null });
      const ok = await http('post', `/attendance/review/${id}/decide`, s.mo).send({ decision: 'DISETUJUI', reason: 'Disetujui', device: 'SETUJUI' }).expect(200);
      expect(ok.body).toEqual({ tahap: 'SELESAI', decision: 'DISETUJUI' });
      expect((await http('post', `/attendance/review/${id}/decide`, s.mo).send({ decision: 'DITOLAK', reason: 'ulang' }).expect(409)).body.kode).toBe('SUDAH_DIPUTUSKAN');
      expect((await dbRec(id)).status).toBe('PERLU_VERIFIKASI'); // rekaman asli TIDAK diubah
      expect((await tenant([A], (c) => c.query(`SELECT status FROM device_registrations WHERE id = $1`, [dev]))).rows[0].status).toBe('DISETUJUI');
      expect((await tenant([A], (c) => c.query(`SELECT effective_status FROM attendance_effective WHERE id = $1`, [id]))).rows[0].effective_status).toBe('DISETUJUI');
      expect((await http('get', '/attendance/review?tahap=SELESAI&limit=100', s.mo).expect(200)).body.items.map((x: { id: string }) => x.id)).toContain(id);
      expect((await audit('attendance.review.decided', id))[0].detail).toEqual({ putusan: 'DISETUJUI', perangkat: 'SETUJUI' });
      expect(await audit('attendance.review.checked', id)).toHaveLength(1);
    });

    it('putusan DITOLAK menolak perangkat bila diminta; tindakan perangkat hanya bila perangkat menunggu', async () => {
      const dev = await perangkat(dA);
      const id = await rekaman(dA, { flags: ['PERANGKAT_BARU'], device: dev, tanggal: '2026-03-17' });
      await http('post', `/attendance/review/${id}/check`, s.payint).send({ reason: 'Mencurigakan' }).expect(200);
      await http('post', `/attendance/review/${id}/decide`, s.mo).send({ decision: 'DITOLAK', reason: 'Bukan perangkat milik pekerja', device: 'TOLAK' }).expect(200);
      expect((await tenant([A], (c) => c.query(`SELECT status FROM device_registrations WHERE id = $1`, [dev]))).rows[0].status).toBe('DITOLAK');
      const devOk = await perangkat(dA, 'DISETUJUI');
      const id2 = await rekaman(dA, { flags: ['AKURASI_BURUK'], device: devOk, tanggal: '2026-03-16' });
      await http('post', `/attendance/review/${id2}/check`, s.payabs).send({ reason: 'periksa' }).expect(200);
      expect((await http('post', `/attendance/review/${id2}/decide`, s.mo).send({ decision: 'DISETUJUI', reason: 'oke', device: 'SETUJUI' }).expect(409)).body.kode).toBe('PERANGKAT_TIDAK_MENUNGGU');
      await http('post', `/attendance/review/${id2}/decide`, s.mo).send({ decision: 'DISETUJUI', reason: 'oke' }).expect(200);
    });

    it('pemisahan tugas: pemeriksa tidak dapat memutuskan rekaman yang sama (aplikasi), tetapi dapat memutuskan rekaman lain', async () => {
      const id = await rekaman(dA, { tanggal: '2026-03-15', flags: ['AKURASI_BURUK'] });
      await http('post', `/attendance/review/${id}/check`, s.ganda).send({ reason: 'Saya periksa' }).expect(200);
      expect((await http('post', `/attendance/review/${id}/decide`, s.ganda).send({ decision: 'DISETUJUI', reason: 'Saya putuskan sendiri' }).expect(403)).body.kode).toBe('PEMISAHAN_TUGAS');
      await http('post', `/attendance/review/${id}/decide`, s.mo).send({ decision: 'DISETUJUI', reason: 'Orang lain' }).expect(200);
      const lain = await rekaman(dA, { tanggal: '2026-03-14', flags: ['AKURASI_BURUK'] });
      await http('post', `/attendance/review/${lain}/check`, s.payabs).send({ reason: 'periksa' }).expect(200);
      await http('post', `/attendance/review/${lain}/decide`, s.ganda).send({ decision: 'DITOLAK', reason: 'Beda orang, boleh' }).expect(200);
    });

    it('hanya rekaman PERLU_VERIFIKASI yang dapat ditinjau; rekaman tidak ada 404', async () => {
      const valid = await rekaman(dA, { status: 'VALID', tanggal: '2026-03-13' });
      expect((await http('post', `/attendance/review/${valid}/check`, s.payabs).send({ reason: 'periksa' }).expect(409)).body.kode).toBe('TIDAK_PERLU_TINJAUAN');
      await http('post', `/attendance/review/${UUID_NOL}/check`, s.payabs).send({ reason: 'periksa' }).expect(404);
      await http('get', `/attendance/review/${UUID_NOL}`, s.mo).expect(404);
      await http('get', '/attendance/review/bukan-uuid', s.mo).expect(400);
      await http('get', '/attendance/review?tahap=SALAH', s.mo).expect(400);
      await http('get', '/attendance/review?limit=101', s.mo).expect(400);
    });

    it('daftar: keyset tanpa duplikat dan filter lokasi', async () => {
      const x = await dasar(A);
      const ids = [await rekaman(x, { waktu: '2026-03-18 07:00' }), await rekaman(x, { tanggal: '2026-03-19', waktu: '2026-03-19 07:00' }), await rekaman(x, { tanggal: '2026-03-20', waktu: '2026-03-20 07:00' })];
      const h1 = (await http('get', `/attendance/review?locationId=${x.lok}&limit=2`, s.mo).expect(200)).body;
      expect(h1.items).toHaveLength(2);
      const h2 = (await http('get', `/attendance/review?locationId=${x.lok}&limit=2&cursor=${encodeURIComponent(h1.nextCursor)}`, s.mo).expect(200)).body;
      expect(h2.items).toHaveLength(1);
      expect([...h1.items, ...h2.items].map((i: { id: string }) => i.id).sort()).toEqual([...ids].sort());
      expect(h2.nextCursor).toBeNull();
      await http('get', '/attendance/review?cursor=rusak', s.mo).expect(400);
    });

    it('ISOLASI: staf B tidak melihat, memeriksa, atau memutuskan rekaman A (404)', async () => {
      const id = await rekaman(dA, { tanggal: '2026-03-12' });
      await http('get', `/attendance/review/${id}`, s.moB).expect(404);
      await http('post', `/attendance/review/${id}/check`, s.payabsB).send({ reason: 'periksa' }).expect(404);
      await http('post', `/attendance/review/${id}/decide`, s.moB).send({ decision: 'DISETUJUI', reason: 'tes' }).expect(404);
      expect((await http('get', '/attendance/review?limit=100', s.moB).expect(200)).body.items.map((x: { id: string }) => x.id)).not.toContain(id);
      expect((await tenant([A], (c) => c.query(`SELECT count(*)::int AS n FROM attendance_reviews WHERE record_id = $1`, [id]))).rows[0].n).toBe(0);
    });
  });

  describe('selfie: akses, audit, legal hold, dan retensi', () => {
    it('hanya selfie.view (Mgr Ops, PayAbs, PayInt) yang dapat melihat; byte asli utuh; SETIAP akses diaudit; tanpa cache', async () => {
      const id = await rekaman(dA, { tanggal: '2026-03-11' });
      const { foto } = await selfie(dA, id);
      for (const n of ['mo', 'payabs', 'payint']) {
        const r = await http('get', `/attendance/records/${id}/selfie`, s[n]).buffer(true).parse((res, cb) => { const d: Buffer[] = []; res.on('data', (x: Buffer) => d.push(x)); res.on('end', () => cb(null, Buffer.concat(d))); }).expect(200);
        expect((r.body as Buffer).equals(foto)).toBe(true);
        expect(r.headers['content-type']).toBe('image/jpeg');
        expect(r.headers['cache-control']).toMatch(/no-store/);
        expect(r.headers['x-content-type-options']).toBe('nosniff');
      }
      for (const n of ['dir', 'adm', 'hrd', 'it', 'mkt', 'fin']) await http('get', `/attendance/records/${id}/selfie`, s[n]).expect(403);
      const log = await audit('attendance.selfie.viewed', id);
      expect(log.map((x) => x.actor_id).sort()).toEqual([s.mo.userId, s.payabs.userId, s.payint.userId].sort()); // satu entri per akses, dengan aktor
      expect(JSON.stringify(log)).not.toMatch(/SELFIE-SINTETIS|storage|key/i);
      await http('get', `/attendance/records/${UUID_NOL}/selfie`, s.mo).expect(404);
      const tanpa = await rekaman(dA, { tanggal: '2026-03-10' });
      expect((await http('get', `/attendance/records/${tanpa}/selfie`, s.mo).expect(404)).body.kode).toBe('SELFIE_TIDAK_DITEMUKAN');
    });

    it('detail tinjauan tidak membawa isi foto; hanya status selfie', async () => {
      const id = await rekaman(dA, { tanggal: '2026-03-09' });
      await selfie(dA, id);
      const d = (await http('get', `/attendance/review/${id}`, s.mo).expect(200)).body;
      expect(d.selfie).toMatchObject({ available: true, purged: false, legalHold: false });
      expect(JSON.stringify(d)).not.toMatch(/storage|base64|SELFIE-SINTETIS/);
    });

    it('ISOLASI: staf B tidak dapat melihat selfie A (404) dan tidak ada entri audit akses', async () => {
      const id = await rekaman(dA, { tanggal: '2026-03-08' });
      await selfie(dA, id);
      await http('get', `/attendance/records/${id}/selfie`, s.moB).expect(404);
      await http('get', `/attendance/records/${id}/selfie`, s.payabsB).expect(404);
      await http('post', `/attendance/records/${id}/selfie/hold`, s.moB).send({ hold: true, reason: 'tes' }).expect(404);
      expect(await audit('attendance.selfie.viewed', id)).toHaveLength(0);
    });

    it('retensi: selfie lewat batas dihapus (objek terhapus, baris rekaman tetap, akses -> 410); belum lewat dan legal hold dikecualikan; idempoten; lintas perusahaan', async () => {
      const lama = await rekaman(dA, { tanggal: '2026-01-05' });
      const sLama = await selfie(dA, lama, { purgeAfter: '2026-04-01 00:00' });
      const baru = await rekaman(dA, { tanggal: '2026-01-06' });
      const sBaru = await selfie(dA, baru, { purgeAfter: '2026-04-03 00:00' });
      const ditahan = await rekaman(dA, { tanggal: '2026-01-07' });
      const sTahan = await selfie(dA, ditahan, { purgeAfter: '2026-04-01 00:00', hold: true });
      const lamaB = await rekaman(dB, { tanggal: '2026-01-05' });
      const sLamaB = await selfie(dB, lamaB, { purgeAfter: '2026-04-01 12:00' });

      const r1 = await selfieSvc.purge(wib('2026-04-02 00:00'));
      expect(r1.dihapus).toBeGreaterThanOrEqual(2);
      await expect(storage.baca(sLama.kunci)).rejects.toThrow(); // objek terhapus
      await expect(storage.baca(sLamaB.kunci)).rejects.toThrow();
      expect((await storage.baca(sBaru.kunci)).length).toBeGreaterThan(0); // belum lewat batas
      expect((await storage.baca(sTahan.kunci)).length).toBeGreaterThan(0); // legal hold
      const baris = (id: string) => tenant([A, B], async (c) => (await c.query(`SELECT purged_at FROM attendance_selfies WHERE record_id = $1`, [id])).rows[0]);
      expect((await baris(lama)).purged_at).not.toBeNull();
      expect((await baris(baru)).purged_at).toBeNull();
      expect((await baris(ditahan)).purged_at).toBeNull();
      expect((await dbRec(lama)).status).toBe('PERLU_VERIFIKASI'); // rekaman tetap
      expect((await http('get', `/attendance/records/${lama}/selfie`, s.mo).expect(410)).body.kode).toBe('SELFIE_SUDAH_DIHAPUS');
      expect((await selfieSvc.purge(wib('2026-04-02 00:00'))).dihapus).toBe(0); // idempoten
      const aud = await tenant([A], (c) => c.query(`SELECT detail FROM audit_logs WHERE action = 'attendance.selfie.purged' AND company_id = $1`, [A]));
      expect(aud.rowCount).toBeGreaterThanOrEqual(1);

      // legal hold dicabut -> terhapus pada putaran berikutnya; hold pada selfie terhapus ditolak
      await http('post', `/attendance/records/${ditahan}/selfie/hold`, s.mo).send({ hold: false, reason: 'Perkara selesai' }).expect(200);
      expect((await selfieSvc.purge(wib('2026-04-02 00:00'))).dihapus).toBeGreaterThanOrEqual(1);
      expect((await baris(ditahan)).purged_at).not.toBeNull();
      expect((await http('post', `/attendance/records/${ditahan}/selfie/hold`, s.mo).send({ hold: true, reason: 'terlambat' }).expect(409)).body.kode).toBe('SELFIE_SUDAH_DIHAPUS');
    });

    it('purge tahan galat: satu objek tidak dapat dihapus (kunci rusak) tidak menghalangi objek lain', async () => {
      const rusak = await rekaman(dA, { tanggal: '2026-01-09' });
      await tenant([A], (c) => c.query(`INSERT INTO attendance_selfies (company_id, record_id, storage_key, sha256, size_bytes, purge_after) VALUES ($1, $2, 'kunci-rusak', $3, 10, $4)`, [A, rusak, randomBytes(32).toString('hex'), wib('2026-01-01 00:00')]));
      const baik = await rekaman(dA, { tanggal: '2026-01-10' });
      const sb = await selfie(dA, baik, { purgeAfter: '2026-01-02 00:00' });
      try {
        const r = await selfieSvc.purge(wib('2026-02-01 00:00'));
        expect(r.gagal).toBeGreaterThanOrEqual(1);
        await expect(storage.baca(sb.kunci)).rejects.toThrow();
        expect((await tenant([A], (c) => c.query(`SELECT purged_at FROM attendance_selfies WHERE record_id = $1`, [rusak]))).rows[0].purged_at).toBeNull(); // tidak ditandai terhapus palsu
      } finally {
        await tenant([A], (c) => c.query(`DELETE FROM attendance_selfies WHERE record_id = $1`, [rusak]));
      }
    });

    it('legal hold: izin Mgr Ops saja, alasan wajib, diaudit; selfie ditahan lolos purge walau jauh lewat batas', async () => {
      const id = await rekaman(dA, { tanggal: '2026-01-08' });
      const x = await selfie(dA, id, { purgeAfter: '2026-02-01 00:00' });
      for (const n of ['payabs', 'payint', 'dir', 'adm', 'hrd']) await http('post', `/attendance/records/${id}/selfie/hold`, s[n]).send({ hold: true, reason: 'tes' }).expect(403);
      await http('post', `/attendance/records/${id}/selfie/hold`, s.mo).send({ hold: true }).expect(400);
      await http('post', `/attendance/records/${id}/selfie/hold`, s.mo).send({ hold: true, reason: 'Sengketa ketenagakerjaan' }).expect(200);
      await selfieSvc.purge(wib('2027-01-01 00:00'));
      expect((await storage.baca(x.kunci)).length).toBeGreaterThan(0);
      expect(await audit('attendance.selfie.hold_set', id)).toHaveLength(1);
      await http('post', `/attendance/records/${UUID_NOL}/selfie/hold`, s.mo).send({ hold: true, reason: 'tes' }).expect(404);
    });
  });

  describe('koreksi bernomor', () => {
    it('izin, nomor, validasi, dan alur putusan dengan pemisahan tugas', async () => {
      const w = await pekerja(dA);
      const kirim = (x: Sesi, b: object) => http('post', '/attendance/adjustments', x).send(b);
      const dasarBody = { personId: w.person, shiftDate: '2026-03-18', effect: 'HADIR', reason: 'Lupa absen, terbukti dari laporan supervisor' };
      for (const n of ['mo', 'dir', 'adm', 'hrd', 'it', 'mkt', 'fin']) await kirim(s[n], dasarBody).expect(403);
      const k = (await kirim(s.payabs, dasarBody).expect(201)).body;
      expect(k).toMatchObject({ status: 'DIAJUKAN', effect: 'HADIR', shiftDate: '2026-03-18', personId: w.person, decidedBy: null });
      expect(k.adjustmentNo).toMatch(/^KOR\/2026\/\d{5}$/);
      expect((await kirim(s.payint, dasarBody).expect(409)).body.kode).toBe('KOREKSI_SUDAH_DIAJUKAN');
      // baca: view/create/update/approve; lainnya 403
      for (const n of ['dir', 'mo', 'payabs', 'payint']) await http('get', `/attendance/adjustments/${k.id}`, s[n]).expect(200);
      for (const n of ['adm', 'hrd', 'it', 'mkt', 'fin']) await http('get', '/attendance/adjustments', s[n]).expect(403);
      // ubah (update): PayAbs; PayInt tidak punya update; setelah putusan tidak dapat diubah
      await http('patch', `/attendance/adjustments/${k.id}`, s.payabs).send({ effect: 'SAKIT' }).expect(200);
      await http('patch', `/attendance/adjustments/${k.id}`, s.payint).send({ effect: 'IZIN' }).expect(403);
      await http('patch', `/attendance/adjustments/${k.id}`, s.payabs).send({}).expect(400);
      // putusan: hanya Mgr Ops; pembuat tidak boleh menyetujui sendiri
      await http('post', `/attendance/adjustments/${k.id}/decide`, s.payabs).send({ decision: 'DISETUJUI', note: 'sendiri' }).expect(403);
      await http('post', `/attendance/adjustments/${k.id}/decide`, s.mo).send({ decision: 'DISETUJUI' }).expect(400);
      const sendiri = (await kirim(s.ganda, { ...dasarBody, personId: (await pekerja(dA)).person }).expect(201)).body;
      expect((await http('post', `/attendance/adjustments/${sendiri.id}/decide`, s.ganda).send({ decision: 'DISETUJUI', note: 'Saya setujui sendiri' }).expect(403)).body.kode).toBe('PEMISAHAN_TUGAS');
      const ok = (await http('post', `/attendance/adjustments/${k.id}/decide`, s.mo).send({ decision: 'DISETUJUI', note: 'Sesuai bukti' }).expect(200)).body;
      expect(ok).toMatchObject({ status: 'DISETUJUI', effect: 'SAKIT', decidedBy: s.mo.userId, decisionNote: 'Sesuai bukti' });
      expect((await http('post', `/attendance/adjustments/${k.id}/decide`, s.mo).send({ decision: 'DITOLAK', note: 'ulang' }).expect(409)).body.kode).toBe('TRANSISI_TIDAK_VALID');
      expect((await http('patch', `/attendance/adjustments/${k.id}`, s.payabs).send({ effect: 'HADIR' }).expect(409)).body.kode).toBe('TRANSISI_TIDAK_VALID');
      expect((await audit('attendance.adjustment.decided', k.id))[0].detail).toMatchObject({ putusan: 'DISETUJUI', nomor: k.adjustmentNo });
      // nomor berurutan unik
      const k2 = (await kirim(s.payabs, { ...dasarBody, shiftDate: '2026-03-17' }).expect(201)).body;
      expect(Number(k2.adjustmentNo.split('/')[2])).toBeGreaterThan(Number(k.adjustmentNo.split('/')[2]));
      const daftar = (await http('get', `/attendance/adjustments?personId=${w.person}&limit=100`, s.dir).expect(200)).body.items;
      expect(daftar.map((x: { id: string }) => x.id).sort()).toEqual([k.id, k2.id].sort());
      expect((await http('get', '/attendance/adjustments?status=DISETUJUI&limit=100', s.mo).expect(200)).body.items.every((x: { status: string }) => x.status === 'DISETUJUI')).toBe(true);
    });

    it('validasi: tanggal masa depan, pekerja tidak dikenal, rekaman tidak sesuai, nomor tidak berulang', async () => {
      const w = await pekerja(dA);
      const kirim = (b: object) => http('post', '/attendance/adjustments', s.payabs).send({ personId: w.person, shiftDate: '2026-03-18', effect: 'HADIR', reason: 'alasan sah', ...b });
      expect((await kirim({ shiftDate: '2026-03-21' }).expect(400)).body.kode).toBe('TANGGAL_DI_MASA_DEPAN'); // jam disuntikkan: 2026-03-20
      await kirim({ shiftDate: '2026-03-20' }).expect(201); // hari ini boleh
      await kirim({ personId: randomUUID(), shiftDate: '2026-03-10' }).expect(404);
      await kirim({ personId: dB.person, shiftDate: '2026-03-10' }).expect(404); // pekerja perusahaan lain
      const rec = await rekaman(w, { tanggal: '2026-03-05' });
      expect((await kirim({ shiftDate: '2026-03-06', recordId: rec }).expect(409)).body.kode).toBe('REKAMAN_TIDAK_SESUAI');
      await kirim({ shiftDate: '2026-03-05', recordId: rec }).expect(201);
      expect(JSON.stringify((await kirim({ reason: '  ' }).expect(400)).body)).toMatch(/Alasan koreksi wajib diisi/);
      expect(JSON.stringify((await kirim({ effect: 'LIBUR' }).expect(400)).body)).toMatch(/Efek koreksi tidak valid/);
      await kirim({ shiftDate: '2026-02-30' }).expect(400);
    });

    it('ISOLASI: staf B tidak melihat, mengubah, atau memutuskan koreksi A; pekerja A tidak dapat dikoreksi staf B', async () => {
      const w = await pekerja(dA);
      const k = (await http('post', '/attendance/adjustments', s.payabs).send({ personId: w.person, shiftDate: '2026-03-04', effect: 'HADIR', reason: 'alasan sah' }).expect(201)).body;
      await http('get', `/attendance/adjustments/${k.id}`, s.moB).expect(404);
      await http('patch', `/attendance/adjustments/${k.id}`, s.payabsB).send({ effect: 'SAKIT' }).expect(404);
      await http('post', `/attendance/adjustments/${k.id}/decide`, s.moB).send({ decision: 'DISETUJUI', note: 'tes' }).expect(404);
      await http('post', '/attendance/adjustments', s.payabsB).send({ personId: w.person, shiftDate: '2026-03-03', effect: 'HADIR', reason: 'alasan sah' }).expect(404);
      expect((await http('get', '/attendance/adjustments?limit=100', s.payabsB).expect(200)).body.items.map((x: { id: string }) => x.id)).not.toContain(k.id);
      expect((await tenant([A], (c) => c.query(`SELECT status FROM attendance_adjustments WHERE id = $1`, [k.id]))).rows[0].status).toBe('DIAJUKAN');
    });
  });

  describe('rekap dan ekspor CSV', () => {
    it('rekap dari rekaman efektif: putusan tinjauan dan koreksi menggantikan status asli; filter; keyset; izin; isolasi', async () => {
      const x = await dasar(A);
      const [p1, p2, p3, p4, p5] = [await pekerja(x, 'SINTETIS Satu'), await pekerja(x, 'SINTETIS Dua'), await pekerja(x, 'SINTETIS Tiga'), await pekerja(x, 'SINTETIS Empat'), await pekerja(x, 'SINTETIS Lima')];
      const T = '2026-02-10';
      await rekaman(p1, { tanggal: T, status: 'VALID', waktu: `${T} 07:02`, flags: ['TERLAMBAT'] });
      await rekaman(p1, { tanggal: T, status: 'VALID', kind: 'PULANG', waktu: `${T} 15:05` });
      const r2 = await rekaman(p2, { tanggal: T, flags: ['AKURASI_BURUK'] }); // menunggu verifikasi
      await rekaman(p3, { tanggal: T, status: 'DITOLAK', alasan: 'LUAR_RADIUS' });
      await rekaman(p5, { tanggal: T, status: 'VALID', waktu: `${T} 07:00` });
      const koreksi = async (w: Dasar, efek: string) => {
        const k = (await http('post', '/attendance/adjustments', s.payabs).send({ personId: w.person, shiftDate: T, effect: efek, reason: 'alasan sah' }).expect(201)).body;
        await http('post', `/attendance/adjustments/${k.id}/decide`, s.mo).send({ decision: 'DISETUJUI', note: 'sah' }).expect(200);
        return k.adjustmentNo as string;
      };
      const noSakit = await koreksi(p4, 'SAKIT'); // tanpa rekaman sama sekali
      const noTidak = await koreksi(p5, 'TIDAK_HADIR'); // mengalahkan rekaman VALID
      const ambil = async (q = '') => (await http('get', `/attendance/recap?from=${T}&to=${T}&locationId=${x.lok}&limit=100${q}`, s.dir).expect(200)).body.items as Record<string, unknown>[];
      const per = (items: Record<string, unknown>[], nama: string) => items.find((i) => i.workerName === nama);

      let items = await ambil();
      expect(per(items, 'SINTETIS Satu')).toMatchObject({ status: 'HADIR', masuk: '07:02', pulang: '15:05', flags: ['TERLAMBAT'], corrected: false, shiftDate: T });
      expect(per(items, 'SINTETIS Dua')).toMatchObject({ status: 'MENUNGGU_VERIFIKASI', masuk: null, pendingVerification: 1 });
      expect(per(items, 'SINTETIS Tiga')).toMatchObject({ status: 'TIDAK_HADIR', corrected: false });
      expect(per(items, 'SINTETIS Empat')).toMatchObject({ status: 'SAKIT', corrected: true, adjustmentNo: noSakit });
      expect(per(items, 'SINTETIS Lima')).toMatchObject({ status: 'TIDAK_HADIR', corrected: true, adjustmentNo: noTidak });
      expect(items).toHaveLength(5);

      // putusan tinjauan DISETUJUI mengubah tampilan efektif menjadi HADIR, tanpa mengubah rekaman asli
      await http('post', `/attendance/review/${r2}/check`, s.payabs).send({ reason: 'periksa' }).expect(200);
      await http('post', `/attendance/review/${r2}/decide`, s.mo).send({ decision: 'DISETUJUI', reason: 'sah' }).expect(200);
      items = await ambil();
      expect(per(items, 'SINTETIS Dua')).toMatchObject({ status: 'HADIR', pendingVerification: 0 });
      expect(items).toHaveLength(5);

      // filter pekerja, lokasi lain, rentang kosong
      expect(await ambil(`&personId=${p1.person}`)).toHaveLength(1);
      expect((await http('get', `/attendance/recap?from=${T}&to=${T}&locationId=${dA.lok}`, s.dir).expect(200)).body.items).toHaveLength(0);
      expect((await http('get', `/attendance/recap?from=2026-02-11&to=2026-02-12&locationId=${x.lok}`, s.dir).expect(200)).body.items).toHaveLength(0);

      // keyset
      const h1 = (await http('get', `/attendance/recap?from=${T}&to=${T}&locationId=${x.lok}&limit=2`, s.dir).expect(200)).body;
      const h2 = (await http('get', `/attendance/recap?from=${T}&to=${T}&locationId=${x.lok}&limit=2&cursor=${encodeURIComponent(h1.nextCursor)}`, s.dir).expect(200)).body;
      const h3 = (await http('get', `/attendance/recap?from=${T}&to=${T}&locationId=${x.lok}&limit=2&cursor=${encodeURIComponent(h2.nextCursor)}`, s.dir).expect(200)).body;
      expect([...h1.items, ...h2.items, ...h3.items].map((i: { personId: string }) => i.personId).sort()).toEqual([p1, p2, p3, p4, p5].map((p) => p.person).sort());
      expect(h3.nextCursor).toBeNull();

      // izin
      for (const n of ['dir', 'mo', 'hrd', 'adm', 'payabs', 'fin', 'payint']) await http('get', `/attendance/recap?from=${T}&to=${T}`, s[n]).expect(200);
      for (const n of ['it', 'mkt']) await http('get', `/attendance/recap?from=${T}&to=${T}`, s[n]).expect(403);
      // validasi rentang
      expect(JSON.stringify((await http('get', '/attendance/recap?from=2026-03-02&to=2026-03-01', s.dir).expect(400)).body)).toMatch(/tidak boleh sebelum/);
      expect(JSON.stringify((await http('get', '/attendance/recap?from=2026-01-01&to=2026-12-31', s.dir).expect(400)).body)).toMatch(/maksimal 93 hari/);
      await http('get', '/attendance/recap?from=2026-03-01', s.dir).expect(400);
      // isolasi: staf B tidak melihat pekerja A
      expect((await http('get', `/attendance/recap?from=${T}&to=${T}`, s.moB).expect(200)).body.items.map((i: { personId: string }) => i.personId)).not.toEqual(expect.arrayContaining([p1.person]));
      expect((await http('get', `/attendance/recap?from=${T}&to=${T}&personId=${p1.person}`, s.moB).expect(200)).body.items).toHaveLength(0);
    });

    it('koreksi yang masih DIAJUKAN atau DITOLAK tidak mengubah rekap', async () => {
      const x = await dasar(A);
      const [pa, pb] = [await pekerja(x, 'SINTETIS Pending'), await pekerja(x, 'SINTETIS Ditolak')];
      const T = '2026-02-12';
      for (const w of [pa, pb]) await rekaman(w, { tanggal: T, status: 'VALID', waktu: `${T} 07:00` });
      for (const w of [pa, pb]) {
        const k = (await http('post', '/attendance/adjustments', s.payabs).send({ personId: w.person, shiftDate: T, effect: 'TIDAK_HADIR', reason: 'alasan sah' }).expect(201)).body;
        if (w === pb) await http('post', `/attendance/adjustments/${k.id}/decide`, s.mo).send({ decision: 'DITOLAK', note: 'tidak sah' }).expect(200);
      }
      const items = (await http('get', `/attendance/recap?from=${T}&to=${T}&locationId=${x.lok}`, s.dir).expect(200)).body.items as { workerName: string; status: string; corrected: boolean }[];
      expect(items.map((i) => [i.workerName, i.status, i.corrected]).sort()).toEqual([['SINTETIS Ditolak', 'HADIR', false], ['SINTETIS Pending', 'HADIR', false]]);
    });

    it('ekspor CSV: izin (Mgr Ops dan PayAbs), isi, perlindungan formula injection, batas baris, audit, tanpa cache', async () => {
      const x = await dasar(A);
      const jahat = await pekerja(x, `=HYPERLINK("http://jahat.invalid","klik")`);
      const plus = await pekerja(x, '+cmd|\' /C calc\'!A0');
      const normal = await pekerja(x, 'SINTETIS Normal, Koma');
      const T = '2026-02-11';
      for (const w of [jahat, plus, normal]) await rekaman(w, { tanggal: T, status: 'VALID' });
      const url = `/attendance/recap/export.csv?from=${T}&to=${T}&locationId=${x.lok}`;
      for (const n of ['dir', 'hrd', 'adm', 'fin', 'payint', 'it', 'mkt']) await http('get', url, s[n]).expect(403);
      const r = await http('get', url, s.mo).buffer(true).parse((res, cb) => { const d: Buffer[] = []; res.on('data', (c: Buffer) => d.push(c)); res.on('end', () => cb(null, Buffer.concat(d))); }).expect(200);
      expect(r.headers['content-type']).toMatch(/text\/csv/);
      expect(r.headers['content-disposition']).toMatch(/attachment/);
      expect(r.headers['cache-control']).toMatch(/no-store/);
      const csv = (r.body as Buffer).toString('utf8');
      expect(csv.charCodeAt(0)).toBe(0xfeff);
      const baris = csv.slice(1).trimEnd().split('\r\n');
      expect(baris[0]).toBe('Tanggal Shift,Nama,Lokasi,Masuk (WIB),Pulang (WIB),Status,Penanda,Menunggu Verifikasi,Dikoreksi,Nomor Koreksi');
      expect(baris).toHaveLength(4);
      expect(csv).toContain(`"'=HYPERLINK(""http://jahat.invalid"",""klik"")"`); // rumus dinetralkan
      expect(csv).toContain(`'+cmd|`);
      expect(csv).toContain('"SINTETIS Normal, Koma"');
      expect(baris.every((b) => !/^[=+\-@]/.test(b.split(',')[1] ?? ''))).toBe(true);
      await http('get', url, s.payabs).expect(200);
      const aud = await tenant([A], (c) => c.query(`SELECT detail, actor_id FROM audit_logs WHERE action = 'attendance.recap.exported' AND company_id = $1 AND actor_id = $2`, [A, s.mo.userId]));
      expect(aud.rows[0].detail).toMatchObject({ dari: T, sampai: T, jumlahBaris: 3, format: 'csv' });
      // batas baris
      recapSvc.batasEkspor = 2;
      try {
        expect((await http('get', url, s.mo).expect(422)).body.kode).toBe('REKAP_TERLALU_BESAR');
      } finally {
        recapSvc.batasEkspor = 10000;
      }
      await http('get', `/attendance/recap/export.csv?from=${T}`, s.mo).expect(400);
      await http('get', `/attendance/recap/export.csv?from=2026-01-01&to=2026-12-31`, s.mo).expect(400);
      // isolasi: staf B mengekspor data kosong
      const kosong = (await http('get', `/attendance/recap/export.csv?from=${T}&to=${T}`, s.moB).expect(200)).text;
      expect(kosong).not.toContain('SINTETIS Normal');
    });
  });
});
