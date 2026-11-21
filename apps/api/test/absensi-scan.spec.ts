import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool, PoolClient } from 'pg';
import request from 'supertest';
import { blindIndexNik, dekripsiBerkas, enkripsiNik } from '../src/common/crypto/pii';
import { urlAplikasiTanpaBypass } from './helpers/role-app';

const DB_URL = process.env.TEST_DATABASE_URL;
const jalan = DB_URL ? describe : describe.skip;

const ORIGIN = 'https://hris.contoh.invalid';
process.env.APP_BASE_URL = ORIGIN;
process.env.AUTH_HMAC_KEY = randomBytes(32).toString('base64');
process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString('base64');
process.env.TRUST_PROXY = '1';
const STORAGE = mkdtempSync(join(tmpdir(), 'hris-absen-'));
process.env.STORAGE_DIR = STORAGE;

interface Sesi { cookie: string; csrf: string; userId: string; personId: string }
interface Lokasi { id: string; company: string; titik: string; kode: string; lat: number; lng: number }

// Titik uji ~ Bandung; semua data SINTETIS. Selfie uji = byte JPEG sintetis (bukan foto orang).
const LAT = -6.9;
const LNG = 107.6;
/** ~ meter ke derajat lintang. */
const geser = (meter: number) => LAT + meter / 111195;
const jpeg = (n = 2000) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('SELFIE-SINTETIS-RAHASIA-UJI'), randomBytes(n)]);
const wib = (s: string) => new Date(`${s.replace(' ', 'T')}:00+07:00`);

jalan('Absensi member: scan QR + GPS + selfie (PostgreSQL asli)', () => {
  let app: INestApplication;
  let pool: Pool;
  let nomorIp = 1;
  let A: string;
  let B: string;
  let sessions: import('../src/auth/session.service').SessionService;
  let u1: string;
  let u2: string;
  let u3: string;
  let waktu = wib('2026-03-11 07:00');
  let lokA: Lokasi;
  let lokB: Lokasi;
  let storage: import('../src/common/storage/object-storage').ObjectStorage;
  let kunciEnk: Buffer;

  beforeAll(async () => {
    execFileSync('node', ['scripts/migrate.js', 'up'], { env: { ...process.env, DATABASE_URL: DB_URL } });
    const { AppModule } = await import('../src/app.module');
    const { konfigurasiApp } = await import('../src/app.factory');
    const { SessionService } = await import('../src/auth/session.service');
    const { JAM_ABSENSI } = await import('../src/attendance/jam');
    const { OBJECT_STORAGE } = await import('../src/common/storage/object-storage');
    process.env.DATABASE_URL = await urlAplikasiTanpaBypass(DB_URL!);
    const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(JAM_ABSENSI).useValue(() => waktu).compile();
    app = mod.createNestApplication();
    konfigurasiApp(app);
    await app.init();
    sessions = app.get(SessionService);
    storage = app.get(OBJECT_STORAGE);
    kunciEnk = Buffer.from(process.env.APP_ENCRYPTION_KEY!, 'base64');
    pool = new Pool({ connectionString: DB_URL, max: 6 });
    A = (await pool.query(`INSERT INTO companies (name) VALUES ($1) RETURNING id`, [`PT SINTETIS A ${randomBytes(3).toString('hex')}`])).rows[0].id;
    B = (await pool.query(`INSERT INTO companies (name) VALUES ($1) RETURNING id`, [`PT SINTETIS B ${randomBytes(3).toString('hex')}`])).rows[0].id;
    const staff = async () => {
      const p = (await pool.query(`INSERT INTO persons (display_name) VALUES ('SINTETIS Staff') RETURNING id`)).rows[0].id;
      return (await pool.query(`INSERT INTO users (person_id, realm, email, status) VALUES ($1, 'staff', $2, 'AKTIF') RETURNING id`, [p, `st-${randomBytes(4).toString('hex')}@contoh.invalid`])).rows[0].id as string;
    };
    [u1, u2, u3] = [await staff(), await staff(), await staff()];
    lokA = await buatLokasi(A);
    lokB = await buatLokasi(B);
  });
  afterAll(async () => {
    await pool?.end();
    await app?.close();
    fs.rmSync(STORAGE, { recursive: true, force: true });
  });

  const ipBaru = () => `10.70.${Math.floor(nomorIp / 250)}.${(nomorIp++ % 250) + 1}`;
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
  const buatLokasi = (company: string): Promise<Lokasi> =>
    tenant([company], async (c) => {
      const p = (await c.query(`INSERT INTO partners (company_id, name, created_by) VALUES ($1, $2, $3) RETURNING id`, [company, `Rek ${randomBytes(3).toString('hex')}`, u1])).rows[0].id;
      const id = (await c.query(`INSERT INTO partner_locations (company_id, partner_id, name, latitude, longitude, geofence_radius_m, created_by) VALUES ($1, $2, 'Lokasi Uji', $3, $4, 100, $5) RETURNING id`, [company, p, LAT, LNG, u1])).rows[0].id;
      const t = (await c.query(`INSERT INTO attendance_points (company_id, location_id, created_by) VALUES ($1, $2, $3) RETURNING id, public_code`, [company, id, u1])).rows[0];
      return { id, company, titik: t.id, kode: t.public_code, lat: LAT, lng: LNG };
    });

  /** Karyawan sintetis: member KARYAWAN_AKTIF + kontrak AKTIF + penempatan AKTIF di lokasi; jadwal opsional. */
  const karyawan = async (lok: Lokasi, o: { jadwal?: 'pagi' | 'malam' | null; statusMember?: string; libur?: string } = {}): Promise<Sesi & { placement: string }> => {
    const personId = (await pool.query(`INSERT INTO persons (display_name) VALUES ('SINTETIS Pekerja') RETURNING id`)).rows[0].id as string;
    const userId = (await pool.query(`INSERT INTO users (person_id, realm, email, status) VALUES ($1, 'member', $2, 'AKTIF') RETURNING id`, [personId, `m-${randomBytes(4).toString('hex')}@contoh.invalid`])).rows[0].id as string;
    const pid = (await pool.query(`INSERT INTO member_profiles (person_id) VALUES ($1) RETURNING id`, [personId])).rows[0].id as string;
    const nik = `98${String(Math.floor(Math.random() * 1e14)).padStart(14, '0')}`; // sintetis
    await pool.query(
      `UPDATE member_profiles SET nik_enc = $4, nik_hmac = $5, status = $2, full_name = 'SINTETIS Pekerja', birth_place = 'K', birth_date = '1990-01-01', gender = 'L', address = 'A', city = 'Bandung', province = 'P', phone = '08123456', education = 'SMA/SMK', emergency_contact_name = 'E', emergency_contact_phone = '08123457', verified_by = $3, verified_at = now() WHERE id = $1`,
      [pid, o.statusMember ?? 'KARYAWAN_AKTIF', u2, enkripsiNik(nik, kunciEnk, pid), blindIndexNik(Buffer.from(process.env.AUTH_HMAC_KEY!, 'base64'), nik)],
    );
    const placement = await tenant([lok.company], async (c) => {
      const v = (await c.query(`INSERT INTO job_vacancies (company_id, title, description, created_by) VALUES ($1, 'L', 'D', $2) RETURNING id`, [lok.company, u1])).rows[0].id;
      const lamaran = (await c.query(`INSERT INTO job_applications (company_id, vacancy_id, person_id, status) VALUES ($1, $2, $3, 'MENUNGGU_PKWT') RETURNING id`, [lok.company, v, personId])).rows[0].id;
      const tpl = (await c.query(`INSERT INTO contract_templates (company_id, name, version, body, created_by) VALUES ($1, $2, 1, 'CONTOH UJI', $3) RETURNING id`, [lok.company, `T ${randomBytes(3).toString('hex')}`, u1])).rows[0].id;
      await c.query(`UPDATE contract_templates SET status = 'TERVERIFIKASI', verified_by = $2, verified_at = now(), verification_note = 'uji' WHERE id = $1`, [tpl, u2]);
      const k = (await c.query(`INSERT INTO employment_contracts (company_id, application_id, person_id, template_id, contract_number, position, start_date, end_date, created_by) VALUES ($1, $2, $3, $4, $5, 'Satpam', '2026-01-01', '2026-12-31', $6) RETURNING id`, [lok.company, lamaran, personId, tpl, `PKWT/${randomBytes(4).toString('hex')}`, u1])).rows[0].id;
      await c.query(`UPDATE employment_contracts SET status = 'PERSETUJUAN', reviewed_by = $2, reviewed_at = now() WHERE id = $1`, [k, u2]);
      await c.query(`UPDATE employment_contracts SET status = 'PENANDATANGANAN', approved_by = $2, approved_at = now() WHERE id = $1`, [k, u3]);
      await c.query(`INSERT INTO contract_documents (company_id, contract_id, version_no, object_key, original_filename, mime_type, size_bytes, sha256, status, uploaded_by, verified_by, verified_at) VALUES ($1, $2, 1, $3, 's.pdf', 'application/pdf', 10, $4, 'TERVERIFIKASI', $5, $6, now())`, [lok.company, k, `${lok.company}/${randomUUID()}`, randomBytes(32), u1, u2]);
      await c.query(`UPDATE employment_contracts SET status = 'DITANDATANGANI' WHERE id = $1`, [k]);
      await c.query(`UPDATE employment_contracts SET status = 'AKTIF', activated_at = now() WHERE id = $1`, [k]);
      const pl = (await c.query(`INSERT INTO placements (company_id, person_id, contract_id, location_id, start_date, status, approved_by, approved_at, created_by) VALUES ($1, $2, $3, $4, '2026-01-01', 'AKTIF', $5, now(), $6) RETURNING id`, [lok.company, personId, k, lok.id, u3, u1])).rows[0].id as string;
      if (o.jadwal) {
        const sh = (await c.query(`INSERT INTO shift_patterns (company_id, name, start_time, end_time, crosses_midnight, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`, [lok.company, `S ${randomBytes(3).toString('hex')}`, o.jadwal === 'pagi' ? '07:00' : '22:00', o.jadwal === 'pagi' ? '15:00' : '06:00', o.jadwal === 'malam', u1])).rows[0].id;
        await c.query(`INSERT INTO work_schedules (company_id, placement_id, shift_id, work_days, valid_from, created_by) VALUES ($1, $2, $3, '{1,2,3,4,5,6,7}', '2026-01-01', $4)`, [lok.company, pl, sh, u1]);
      }
      if (o.libur) await c.query(`INSERT INTO holidays (company_id, holiday_date, scope, name, created_by) VALUES ($1, $2, 'PERUSAHAAN', 'Libur Uji', $3) ON CONFLICT DO NOTHING`, [lok.company, o.libur, u1]);
      return pl;
    });
    const x = await sessions.buat({ userId, realm: 'member', state: 'PENUH' });
    return { cookie: `__Host-sid=${x.token}`, csrf: x.csrfToken, userId, personId, placement };
  };

  const http = (metode: 'get' | 'post', path: string, s?: Pick<Sesi, 'cookie' | 'csrf'>, ip = ipBaru()) => {
    let r = request(app.getHttpServer())[metode](path).set('X-Forwarded-For', ip).set('Origin', ORIGIN);
    if (s) r = r.set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf);
    return r;
  };
  interface OpsiAbsen { lok?: Lokasi; kind?: string; lat?: number; lng?: number; acc?: number | null; selfie?: Buffer | null; device?: string; kunci?: string; clientTime?: string | null; code?: string; ip?: string }
  const absen = (s: Sesi, o: OpsiAbsen = {}) => {
    const lok = o.lok ?? lokA;
    let r = http('post', '/member/attendance', s, o.ip)
      .field('code', o.code ?? lok.kode).field('kind', o.kind ?? 'MASUK').field('latitude', String(o.lat ?? lok.lat)).field('longitude', String(o.lng ?? lok.lng))
      .field('deviceId', o.device ?? `perangkat-${s.userId}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60).padEnd(16, 'x')).field('idempotencyKey', o.kunci ?? `kunci-${randomBytes(8).toString('hex')}`);
    if (o.acc !== null) r = r.field('accuracy', String(o.acc ?? 15));
    if (o.clientTime) r = r.field('clientTime', o.clientTime);
    if (o.selfie !== null) r = r.attach('selfie', o.selfie ?? jpeg(), { filename: 'selfie.jpg', contentType: 'image/jpeg' });
    return r;
  };
  const baris = async (personId: string) => (await tenant([A, B], (c) => c.query(`SELECT * FROM attendance_records WHERE person_id = $1 ORDER BY occurred_at, created_at`, [personId]))).rows;
  const auditRows = async (aksi: string, objekId: string) => tenant([A, B], async (c) => (await c.query(`SELECT detail, actor_id FROM audit_logs WHERE action = $1 AND object_id = $2`, [aksi, objekId])).rows);

  describe('jalur normal dan waktu server', () => {
    it('masuk VALID: waktu = waktu SERVER (bukan jam klien), selfie terenkripsi, audit tanpa koordinat/selfie', async () => {
      const m = await karyawan(lokA, { jadwal: 'pagi' });
      waktu = wib('2026-03-11 07:02');
      const foto = jpeg(3000);
      const r = await absen(m, { selfie: foto, clientTime: '2026-03-11T06:59:30+07:00' }).expect(201);
      expect(r.body).toMatchObject({ kind: 'MASUK', status: 'VALID', shiftDate: '2026-03-11', flags: [], rejectReason: null });
      expect(r.body.message).toMatch(/Absen masuk tercatat pukul 07:02 WIB/);
      expect(new Date(r.body.occurredAt).getTime()).toBe(waktu.getTime());
      const [rec] = await baris(m.personId);
      expect(rec.status).toBe('VALID');
      expect(Number(rec.distance_m)).toBeLessThan(1);
      const s = (await tenant([A], (c) => c.query(`SELECT storage_key, sha256, size_bytes, purge_after FROM attendance_selfies WHERE record_id = $1`, [rec.id]))).rows[0];
      expect(s.size_bytes).toBe(foto.length);
      const mentah = await storage.baca(s.storage_key);
      expect(mentah.includes(Buffer.from('SELFIE-SINTETIS-RAHASIA-UJI'))).toBe(false); // terenkripsi di penyimpanan
      expect(dekripsiBerkas(mentah, kunciEnk, s.storage_key).equals(foto)).toBe(true);
      expect(new Date(s.purge_after).getTime()).toBe(waktu.getTime() + 90 * 86400000); // retensi bawaan 90 hari
      const a = await auditRows('attendance.recorded', rec.id);
      expect(a).toHaveLength(1);
      expect(JSON.stringify(a[0].detail)).not.toMatch(/lat|lng|longitude|selfie|107\.|-6\.9/i);
      expect(r.headers['cache-control']).toMatch(/no-store/);
    });

    it('klien menyimpang >5 menit: PERLU_VERIFIKASI dengan waktu tetap dari server', async () => {
      const m = await karyawan(lokA, { jadwal: 'pagi' });
      waktu = wib('2026-03-11 07:05');
      const r = await absen(m, { clientTime: '2026-03-11T03:00:00+07:00' }).expect(201);
      expect(r.body).toMatchObject({ status: 'PERLU_VERIFIKASI', flags: ['WAKTU_KLIEN_MENYIMPANG'] });
      expect(new Date(r.body.occurredAt).getTime()).toBe(waktu.getTime());
    });

    it('terlambat melewati toleransi tetap VALID dengan penanda; pulang cepat ditandai', async () => {
      const m = await karyawan(lokA, { jadwal: 'pagi' });
      waktu = wib('2026-03-11 07:40');
      const masuk = await absen(m).expect(201);
      expect(masuk.body).toMatchObject({ status: 'VALID', flags: ['TERLAMBAT'] });
      expect(masuk.body.message).toMatch(/terlambat/);
      // member membaca penanda rekamannya sendiri pada riwayat dan ringkasan hari ini (kebijakan RLS baca-milik)
      expect((await http('get', '/member/attendance', m).expect(200)).body.items[0].flags).toEqual(['TERLAMBAT']);
      expect((await http('get', '/member/attendance/today', m).expect(200)).body.records[0].flags).toEqual(['TERLAMBAT']);
      waktu = wib('2026-03-11 14:00');
      const pulang = await absen(m, { kind: 'PULANG' }).expect(201);
      expect(pulang.body).toMatchObject({ status: 'VALID', flags: ['PULANG_CEPAT'] });
    });

    it('masuk dan pulang normal; masuk ganda pada shift yang sama DITOLAK (DUPLIKAT) dan tercatat', async () => {
      const m = await karyawan(lokA, { jadwal: 'pagi' });
      waktu = wib('2026-03-11 07:00');
      await absen(m).expect(201);
      const dup = await absen(m).expect(201);
      expect(dup.body).toMatchObject({ status: 'DITOLAK', rejectReason: 'DUPLIKAT' });
      expect(dup.body.message).toMatch(/sudah tercatat/);
      waktu = wib('2026-03-11 15:00');
      expect((await absen(m, { kind: 'PULANG' }).expect(201)).body.status).toBe('VALID');
      expect((await absen(m, { kind: 'PULANG' }).expect(201)).body).toMatchObject({ status: 'DITOLAK', rejectReason: 'DUPLIKAT' });
      const semua = await baris(m.personId);
      expect(semua.map((x) => x.status)).toEqual(['VALID', 'DITOLAK', 'VALID', 'DITOLAK']);
      waktu = wib('2026-03-12 07:00');
      expect((await absen(m).expect(201)).body).toMatchObject({ status: 'VALID', shiftDate: '2026-03-12' }); // hari berikutnya boleh
    });
  });

  describe('penolakan (tercatat, bukan galat)', () => {
    it('luar radius DITOLAK dengan jarak; batas radius tepat diterima; tidak ada selfie tersimpan untuk yang ditolak', async () => {
      const m = await karyawan(lokA, { jadwal: 'pagi' });
      waktu = wib('2026-03-11 07:00');
      const jauh = await absen(m, { lat: geser(150) }).expect(201);
      expect(jauh.body).toMatchObject({ status: 'DITOLAK', rejectReason: 'LUAR_RADIUS' });
      expect(jauh.body.distanceM).toBeGreaterThan(140);
      expect(jauh.body.message).toMatch(/di luar radius/);
      expect((await tenant([A], (c) => c.query(`SELECT count(*)::int AS n FROM attendance_selfies s JOIN attendance_records r ON r.id = s.record_id WHERE r.person_id = $1`, [m.personId]))).rows[0].n).toBe(0);
      expect((await absen(m, { lat: geser(90) }).expect(201)).body.status).toBe('VALID'); // dalam radius 100 m
    });

    it('selfie: wajib, harus JPEG, maksimal 300 KB (lebih dari 400 KB ditolak 413)', async () => {
      const m = await karyawan(lokA, { jadwal: 'pagi' });
      waktu = wib('2026-03-11 07:00');
      expect((await absen(m, { selfie: null }).expect(201)).body).toMatchObject({ status: 'DITOLAK', rejectReason: 'SELFIE_WAJIB' });
      expect((await absen(m, { selfie: Buffer.from('bukan gambar sama sekali') }).expect(201)).body).toMatchObject({ rejectReason: 'SELFIE_TIDAK_VALID' });
      expect((await absen(m, { selfie: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), randomBytes(500)]) }).expect(201)).body).toMatchObject({ rejectReason: 'SELFIE_TIDAK_VALID' }); // PNG bukan JPEG
      expect((await absen(m, { selfie: jpeg(301 * 1024) }).expect(201)).body).toMatchObject({ rejectReason: 'SELFIE_TERLALU_BESAR' });
      await absen(m, { selfie: jpeg(401 * 1024) }).expect(413);
      expect((await absen(m, { selfie: jpeg(300 * 1024 - 100) }).expect(201)).body.status).toBe('VALID'); // tepat di bawah batas
    });

    it('GPS: akurasi buruk => PERLU_VERIFIKASI; akurasi tidak dikirim tetap diproses', async () => {
      const m = await karyawan(lokA, { jadwal: 'pagi' });
      waktu = wib('2026-03-11 07:00');
      expect((await absen(m, { acc: 500 }).expect(201)).body).toMatchObject({ status: 'PERLU_VERIFIKASI', flags: ['AKURASI_BURUK'] });
      const m2 = await karyawan(lokA, { jadwal: 'pagi' });
      expect((await absen(m2, { acc: null }).expect(201)).body.status).toBe('VALID');
    });
  });

  describe('perangkat', () => {
    it('perangkat pertama disetujui otomatis; perangkat tambahan => PERLU_VERIFIKASI + PERANGKAT_BARU; perangkat ditolak => DITOLAK', async () => {
      const m = await karyawan(lokA, { jadwal: 'pagi' });
      waktu = wib('2026-03-11 07:00');
      expect((await absen(m, { device: 'perangkat-pertama-aaaaaa' }).expect(201)).body.status).toBe('VALID');
      expect((await tenant([A], (c) => c.query(`SELECT status FROM device_registrations WHERE person_id = $1`, [m.personId]))).rows.map((x) => x.status)).toEqual(['DISETUJUI']);
      waktu = wib('2026-03-11 15:00');
      const baru = await absen(m, { kind: 'PULANG', device: 'perangkat-kedua-bbbbbbbb' }).expect(201);
      expect(baru.body).toMatchObject({ status: 'PERLU_VERIFIKASI', flags: ['PERANGKAT_BARU'] });
      const d = (await tenant([A], (c) => c.query(`SELECT id, status FROM device_registrations WHERE person_id = $1 ORDER BY first_seen_at`, [m.personId]))).rows;
      expect(d.map((x) => x.status)).toEqual(['DISETUJUI', 'PERLU_VERIFIKASI']);
      await tenant([A], (c) => c.query(`UPDATE device_registrations SET status = 'DITOLAK' WHERE id = $1`, [d[1].id]));
      waktu = wib('2026-03-12 07:00');
      expect((await absen(m, { device: 'perangkat-kedua-bbbbbbbb' }).expect(201)).body).toMatchObject({ status: 'DITOLAK', rejectReason: 'PERANGKAT_DITOLAK' });
      expect((await absen(m, { device: 'perangkat-pertama-aaaaaa' }).expect(201)).body.status).toBe('VALID'); // perangkat terpercaya tetap bisa
    });

    it('perangkat yang sama dipakai >3 akun => BANYAK_AKUN_SATU_PERANGKAT; id perangkat disimpan sebagai HMAC, bukan mentah', async () => {
      const bersama = `bersama-${randomBytes(6).toString('hex')}`;
      waktu = wib('2026-03-11 07:00');
      const hasil: string[][] = [];
      for (let i = 0; i < 4; i++) hasil.push((await absen(await karyawan(lokA, { jadwal: 'pagi' }), { device: bersama }).expect(201)).body.flags);
      expect(hasil.slice(0, 3)).toEqual([[], [], []]);
      expect(hasil[3]).toEqual(['BANYAK_AKUN_SATU_PERANGKAT']);
      const h = (await pool.query(`SELECT count(*)::int AS n FROM device_registrations WHERE device_hash = $1`, [bersama])).rows[0].n;
      expect(h).toBe(0);
    });
  });

  describe('shift lintas tengah malam, libur, dan jadwal', () => {
    it('shift malam: masuk 21:50 (D) dan pulang 06:00 (D+1) sama-sama bertanggal-shift D, tanpa PULANG_TANPA_MASUK', async () => {
      const m = await karyawan(lokA, { jadwal: 'malam' });
      waktu = wib('2026-03-10 21:50');
      expect((await absen(m).expect(201)).body).toMatchObject({ status: 'VALID', shiftDate: '2026-03-10', flags: [] });
      waktu = wib('2026-03-11 06:00');
      const p = await absen(m, { kind: 'PULANG' }).expect(201);
      expect(p.body).toMatchObject({ status: 'VALID', shiftDate: '2026-03-10', flags: [] });
      waktu = wib('2026-03-11 21:55');
      expect((await absen(m).expect(201)).body).toMatchObject({ status: 'VALID', shiftDate: '2026-03-11' }); // malam berikutnya
      const semua = await baris(m.personId);
      expect(semua.map((x) => x.shift_date.toISOString?.().slice(0, 10) ?? String(x.shift_date))).toEqual(expect.any(Array));
    });

    it('shift malam yang dimulai setelah tengah malam (masuk terlambat 00:20) tetap milik tanggal mulai', async () => {
      const m = await karyawan(lokA, { jadwal: 'malam' });
      waktu = wib('2026-03-11 00:20');
      expect((await absen(m).expect(201)).body).toMatchObject({ status: 'VALID', shiftDate: '2026-03-10', flags: ['TERLAMBAT'] });
    });

    it('hari libur, tanpa jadwal, dan pulang tanpa masuk => PERLU_VERIFIKASI dengan penanda', async () => {
      const libur = await karyawan(lokA, { jadwal: 'pagi', libur: '2026-04-01' });
      waktu = wib('2026-04-01 07:00');
      expect((await absen(libur).expect(201)).body).toMatchObject({ status: 'PERLU_VERIFIKASI', flags: ['HARI_LIBUR'] });
      const tanpa = await karyawan(lokA, { jadwal: null });
      waktu = wib('2026-03-11 07:00');
      expect((await absen(tanpa).expect(201)).body).toMatchObject({ status: 'PERLU_VERIFIKASI', shiftDate: '2026-03-11', flags: ['TANPA_JADWAL'] });
      const pt = await karyawan(lokA, { jadwal: 'pagi' });
      waktu = wib('2026-03-11 15:00');
      expect((await absen(pt, { kind: 'PULANG' }).expect(201)).body).toMatchObject({ status: 'PERLU_VERIFIKASI', flags: ['PULANG_TANPA_MASUK'] });
    });

    it('toleransi per lokasi menggantikan toleransi shift', async () => {
      const lok = await buatLokasi(A);
      await tenant([A], (c) => c.query(`UPDATE partner_locations SET attendance_late_tolerance_min = 60 WHERE id = $1`, [lok.id]));
      const m = await karyawan(lok, { jadwal: 'pagi' });
      waktu = wib('2026-03-11 07:45');
      expect((await absen(m, { lok }).expect(201)).body).toMatchObject({ status: 'VALID', flags: [] });
    });
  });

  describe('galat (tidak dicatat sebagai rekaman)', () => {
    const tanpaRekaman = async (m: Sesi) => expect(await baris(m.personId)).toHaveLength(0);

    it('bukan karyawan aktif => 403; kontrak berakhir/penempatan selesai => 403', async () => {
      const calon = await karyawan(lokA, { jadwal: 'pagi', statusMember: 'BELUM_DITEMPATKAN' });
      waktu = wib('2026-03-11 07:00');
      expect((await absen(calon).expect(403)).body.kode).toBe('BUKAN_KARYAWAN_AKTIF');
      await tanpaRekaman(calon);
      const selesai = await karyawan(lokA, { jadwal: 'pagi' });
      await tenant([A], (c) => c.query(`UPDATE placements SET status = 'SELESAI' WHERE id = $1`, [selesai.placement]));
      expect((await absen(selesai).expect(403)).body.kode).toBe('TIDAK_DITEMPATKAN_DI_LOKASI_INI');
      const habis = await karyawan(lokA, { jadwal: 'pagi' });
      await tenant([A], (c) => c.query(`UPDATE placements SET end_date = '2026-03-01' WHERE id = $1`, [habis.placement]));
      expect((await absen(habis).expect(403)).body.kode).toBe('TIDAK_DITEMPATKAN_DI_LOKASI_INI');
      await tanpaRekaman(habis);
    });

    it('titik tidak dikenal 404; titik nonaktif 409; kode lama setelah rotasi 404; ditempatkan di lokasi lain 403', async () => {
      const m = await karyawan(lokA, { jadwal: 'pagi' });
      waktu = wib('2026-03-11 07:00');
      expect((await absen(m, { code: randomUUID() }).expect(404)).body.kode).toBe('TITIK_TIDAK_DITEMUKAN');
      const lain = await buatLokasi(A);
      expect((await absen(m, { lok: lain }).expect(403)).body.kode).toBe('TIDAK_DITEMPATKAN_DI_LOKASI_INI'); // titik sah, tetapi bukan lokasi penempatannya
      await tenant([A], (c) => c.query(`UPDATE attendance_points SET status = 'NONAKTIF' WHERE id = $1`, [lain.titik]));
      expect((await absen(m, { lok: lain }).expect(409)).body.kode).toBe('TITIK_NONAKTIF');
      const kodeLama = lokA.kode;
      await tenant([A], (c) => c.query(`UPDATE attendance_points SET public_code = gen_random_uuid() WHERE id = $1`, [lokA.titik]));
      expect((await absen(m, { code: kodeLama }).expect(404)).body.kode).toBe('TITIK_TIDAK_DITEMUKAN');
      lokA.kode = (await tenant([A], (c) => c.query(`SELECT public_code FROM attendance_points WHERE id = $1`, [lokA.titik]))).rows[0].public_code; // pulihkan untuk uji lain
      await tanpaRekaman(m);
    });

    it('autentikasi: tanpa sesi 401; sesi staf tidak boleh memakai rute member 403; CSRF wajib', async () => {
      await http('post', '/member/attendance').expect(401);
      const staf = await sessions.buat({ userId: u1, realm: 'staff', state: 'PENUH' });
      await http('post', '/member/attendance', { cookie: `__Host-sid=${staf.token}`, csrf: staf.csrfToken }).expect(403);
      const m = await karyawan(lokA, { jadwal: 'pagi' });
      await absen(m).set('X-CSRF-Token', 'salah').expect(403);
      await tanpaRekaman(m);
    });

    it('masukan tidak valid => 400 berbahasa Indonesia', async () => {
      const m = await karyawan(lokA, { jadwal: 'pagi' });
      const r = await absen(m, { lat: 95 }).expect(400);
      expect(JSON.stringify(r.body)).toMatch(/Lintang harus antara -90 dan 90/);
      expect(JSON.stringify((await absen(m, { code: 'bukan-uuid' }).expect(400)).body)).toMatch(/Kode titik tidak valid/);
      expect(JSON.stringify((await absen(m, { kind: 'KELUAR' }).expect(400)).body)).toMatch(/MASUK atau PULANG/);
      expect(JSON.stringify((await absen(m, { device: 'pendek' }).expect(400)).body)).toMatch(/ID perangkat tidak valid/);
      expect(JSON.stringify((await absen(m, { kunci: 'x' }).expect(400)).body)).toMatch(/Kunci idempotensi tidak valid/);
      expect(JSON.stringify((await absen(m, { clientTime: 'kemarin' }).expect(400)).body)).toMatch(/ISO 8601/);
      await tanpaRekaman(m);
    });
  });

  describe('idempotensi dan serentak', () => {
    it('pengulangan kunci yang sama => 200 dengan hasil awal, tanpa rekaman ganda (meski isi diubah)', async () => {
      const m = await karyawan(lokA, { jadwal: 'pagi' });
      waktu = wib('2026-03-11 07:00');
      const kunci = `idem-${randomBytes(8).toString('hex')}`;
      const pertama = await absen(m, { kunci }).expect(201);
      waktu = wib('2026-03-11 09:00');
      const ulang = await absen(m, { kunci, lat: geser(5000), selfie: null }).expect(200);
      expect(ulang.body).toEqual(pertama.body);
      expect(await baris(m.personId)).toHaveLength(1);
      expect(await auditRows('attendance.recorded', pertama.body.id)).toHaveLength(1);
    });

    it('serentak dengan kunci sama => satu rekaman; serentak dengan kunci berbeda pada shift sama => satu VALID dan satu DUPLIKAT', async () => {
      const m = await karyawan(lokA, { jadwal: 'pagi' });
      waktu = wib('2026-03-11 07:00');
      const kunci = `balap-${randomBytes(8).toString('hex')}`;
      const [a, b] = await Promise.all([absen(m, { kunci }), absen(m, { kunci })]);
      expect([a.status, b.status].sort()).toEqual([200, 201]);
      expect(a.body.id).toBe(b.body.id);
      expect(await baris(m.personId)).toHaveLength(1);
      const m2 = await karyawan(lokA, { jadwal: 'pagi' });
      const hasil = await Promise.all([absen(m2), absen(m2), absen(m2)]);
      expect(hasil.every((x) => x.status === 201)).toBe(true);
      expect(hasil.map((x) => x.body.status).sort()).toEqual(['DITOLAK', 'DITOLAK', 'VALID']);
      expect((await baris(m2.personId)).filter((x) => x.status !== 'DITOLAK')).toHaveLength(1);
    });
  });

  describe('retensi selfie dan riwayat', () => {
    it('retensi mengikuti document_settings.selfieRetentionDays perusahaan (dibatasi 7-3650)', async () => {
      const lok = await buatLokasi(A);
      await pool.query(`UPDATE companies SET document_settings = '{"selfieRetentionDays": 30}'::jsonb WHERE id = $1`, [A]);
      try {
        const m = await karyawan(lok, { jadwal: 'pagi' });
        waktu = wib('2026-03-11 07:00');
        const r = await absen(m, { lok }).expect(201);
        const s = (await tenant([A], (c) => c.query(`SELECT purge_after FROM attendance_selfies WHERE record_id = $1`, [r.body.id]))).rows[0];
        expect(new Date(s.purge_after).getTime()).toBe(waktu.getTime() + 30 * 86400000);
        await pool.query(`UPDATE companies SET document_settings = '{"selfieRetentionDays": 1}'::jsonb WHERE id = $1`, [A]);
        const m2 = await karyawan(lok, { jadwal: 'pagi' });
        const r2 = await absen(m2, { lok }).expect(201);
        expect(new Date((await tenant([A], (c) => c.query(`SELECT purge_after FROM attendance_selfies WHERE record_id = $1`, [r2.body.id]))).rows[0].purge_after).getTime()).toBe(waktu.getTime() + 7 * 86400000);
      } finally {
        await pool.query(`UPDATE companies SET document_settings = '{}'::jsonb WHERE id = $1`, [A]);
      }
    });

    it('riwayat dan hari-ini: hanya milik sendiri, keyset, batas halaman', async () => {
      const m = await karyawan(lokA, { jadwal: 'pagi' });
      const lain = await karyawan(lokA, { jadwal: 'pagi' });
      for (const [w, kind] of [['2026-03-11 07:00', 'MASUK'], ['2026-03-11 15:00', 'PULANG'], ['2026-03-12 07:00', 'MASUK']] as const) {
        waktu = wib(w);
        await absen(m, { kind }).expect(201);
      }
      await absen(lain).expect(201);
      const h1 = (await http('get', '/member/attendance?limit=2', m).expect(200)).body;
      expect(h1.items).toHaveLength(2);
      expect(h1.items[0]).toMatchObject({ kind: 'MASUK', shiftDate: '2026-03-12', locationName: 'Lokasi Uji' });
      const h2 = (await http('get', `/member/attendance?limit=2&cursor=${encodeURIComponent(h1.nextCursor)}`, m).expect(200)).body;
      expect(h2.items).toHaveLength(1);
      expect(h2.nextCursor).toBeNull();
      await http('get', '/member/attendance?limit=101', m).expect(400);
      const hari = (await http('get', '/member/attendance/today', m).expect(200)).body;
      expect(hari.today).toBe('2026-03-12');
      expect(hari.placements).toHaveLength(1);
      expect(hari.records.map((x: { id: string }) => x.id)).not.toContain((await baris(lain.personId))[0].id);
      await http('get', '/member/attendance').expect(401);
    });
  });

  describe('ISOLASI perusahaan', () => {
    it('karyawan A memindai titik B => 403 (tanpa rekaman); karyawan B absen sendiri; riwayat tidak bocor; rekaman B tak terbaca scope A', async () => {
      const a = await karyawan(lokA, { jadwal: 'pagi' });
      const b = await karyawan(lokB, { jadwal: 'pagi' });
      waktu = wib('2026-03-11 07:00');
      expect((await absen(a, { lok: lokB }).expect(403)).body.kode).toBe('TIDAK_DITEMPATKAN_DI_LOKASI_INI');
      expect(await baris(a.personId)).toHaveLength(0);
      const rb = await absen(b, { lok: lokB }).expect(201);
      expect(rb.body.status).toBe('VALID');
      expect((await http('get', '/member/attendance', a).expect(200)).body.items).toHaveLength(0);
      const lihat = await tenant([A], (c) => c.query(`SELECT id FROM attendance_records WHERE person_id = $1 AND company_id = $2`, [b.personId, A])); // filter eksplisit: benar juga bila pool uji superuser
      expect(lihat.rowCount).toBe(0); // RLS: scope A tidak melihat rekaman B
      expect((await tenant([A], (c) => c.query(`SELECT 1 FROM attendance_selfies s WHERE s.record_id = $1 AND s.company_id = $2`, [rb.body.id, A]))).rowCount).toBe(0);
    });
  });

  describe('pembatasan laju', () => {
    it('lebih dari 20 permintaan/menit dari satu IP => 429', async () => {
      const ip = `10.99.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
      const m = await karyawan(lokA, { jadwal: 'pagi' });
      const kode: number[] = [];
      for (let i = 0; i < 22; i++) kode.push((await absen(m, { ip, code: 'bukan-uuid' })).status);
      expect(kode.slice(0, 20).every((x) => x === 400)).toBe(true);
      expect(kode.slice(20)).toEqual([429, 429]);
    });
  });
});
