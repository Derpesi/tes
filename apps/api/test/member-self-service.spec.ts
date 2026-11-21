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
const nikBaru = () => `99${String(Math.floor(Math.random() * 1e14)).padStart(14, '0')}`;
const PDF = Buffer.from('%PDF-1.4\nKTP-SINTETIS-ISI-RAHASIA-UJI\n%%EOF\n');
const LENGKAP = (nik: string) => ({
  fullName: 'SINTETIS Pelamar Uji', nik, birthPlace: 'Bandung', birthDate: '1995-05-17', gender: 'L', address: 'Jl. Contoh No. 1', city: 'Bandung', province: 'Jawa Barat',
  phone: '081234567890', education: 'SMA/SMK', emergencyContactName: 'SINTETIS Kerabat', emergencyContactPhone: '081234500000',
});

jalan('self-service member: biodata, dokumen terenkripsi, dan pengajuan verifikasi (PostgreSQL asli)', () => {
  let app: INestApplication;
  let pool: Pool;
  let nomorIp = 1;
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
    pool = new Pool({ connectionString: DB_URL, max: 3 });
  });
  afterAll(async () => {
    await pool?.end();
    await app?.close();
    fs.rmSync(STORAGE, { recursive: true, force: true });
  });

  const ipBaru = () => `10.50.${Math.floor(nomorIp / 250)}.${(nomorIp++ % 250) + 1}`;
  const http = (metode: 'get' | 'post' | 'put' | 'delete', path: string, s?: Pick<Sesi, 'cookie' | 'csrf'>, o: { origin?: string | null; tanpaCsrf?: boolean } = {}) => {
    let r = request(app.getHttpServer())[metode](path).set('X-Forwarded-For', ipBaru());
    if (o.origin !== null) r = r.set('Origin', o.origin ?? ORIGIN);
    if (s) r = r.set('Cookie', s.cookie);
    if (s && !o.tanpaCsrf) r = r.set('X-CSRF-Token', s.csrf);
    return r;
  };
  const buatMember = async (): Promise<Sesi> => {
    const p = (await pool.query(`INSERT INTO persons (display_name) VALUES ('SINTETIS Member') RETURNING id`)).rows[0].id as string;
    const u = (await pool.query(`INSERT INTO users (person_id, realm, email, status) VALUES ($1, 'member', $2, 'AKTIF') RETURNING id`, [p, `m-${randomBytes(4).toString('hex')}@contoh.invalid`])).rows[0].id as string;
    const s = await sessions.buat({ userId: u, realm: 'member', state: 'PENUH' });
    return { cookie: `__Host-sid=${s.token}`, csrf: s.csrfToken, userId: u, personId: p };
  };
  const ktp = (s: Sesi, isi: Buffer = PDF, nama = 'ktp.pdf', kind = 'KTP') => http('post', '/member/documents', s).field('kind', kind).attach('berkas', isi, nama);
  const profilDb = async (personId: string) => (await pool.query(`SELECT * FROM member_profiles WHERE person_id = $1`, [personId])).rows[0];
  const bacaAudit = async (aksi: string) => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.audit_global', 'on', true)`);
      const r = await c.query(`SELECT detail::text AS d FROM audit_logs WHERE action = $1`, [aksi]);
      await c.query('ROLLBACK');
      return r.rows.map((x) => x.d as string);
    } finally {
      c.release();
    }
  };

  describe('profil dan biodata', () => {
    it('profil dibuat malas (TERDAFTAR), simpan bertahap -> PROFIL_BELUM_LENGKAP; NIK tersamar, terenkripsi, dan beridentitas buta', async () => {
      const m = await buatMember();
      const awal = (await http('get', '/member/profile', m).expect(200)).body;
      expect(awal.status).toBe('TERDAFTAR');
      expect(awal.nik).toBeNull();
      const nik = nikBaru();
      const r = (await http('put', '/member/profile', m).send({ fullName: 'SINTETIS Pelamar', nik, city: 'Bandung' }).expect(200)).body;
      expect(r.status).toBe('PROFIL_BELUM_LENGKAP');
      expect(r.nik).toBe(`************${nik.slice(-4)}`);
      expect(JSON.stringify(r)).not.toContain(nik);
      const p = await profilDb(m.personId);
      expect(p.nik_enc.includes(Buffer.from(nik))).toBe(false); // tidak tersimpan terang
      expect(p.nik_hmac).toHaveLength(32);
      expect((await http('get', '/member/profile', m).expect(200)).body.nik).toBe(`************${nik.slice(-4)}`);
      const riwayat = (await http('get', '/member/profile/history', m).expect(200)).body.items as { to: string }[];
      expect(riwayat.map((x) => x.to)).toContain('PROFIL_BELUM_LENGKAP');
    });

    it('validasi berpesan Indonesia tanpa mengulang nilai; bidang asing (mis. personId/status) ditolak', async () => {
      const m = await buatMember();
      const buruk = await http('put', '/member/profile', m).send({ nik: '12345', phone: 'abc', gender: 'X', birthDate: '2999-01-01', education: 'TK' }).expect(400);
      expect(JSON.stringify(buruk.body)).toMatch(/NIK harus 16 digit/);
      expect(JSON.stringify(buruk.body)).toMatch(/telepon tidak valid/i);
      expect(JSON.stringify(buruk.body)).not.toContain('12345');
      await http('put', '/member/profile', m).send({}).expect(400);
      await http('put', '/member/profile', m).send({ city: 'X', status: 'TERVERIFIKASI' }).expect(400);
      await http('put', '/member/profile', m).send({ city: 'X', personId: randomBytes(16).toString('hex') }).expect(400);
      expect((await profilDb(m.personId))?.status ?? 'TERDAFTAR').not.toBe('TERVERIFIKASI');
    });

    it('NIK unik antarmember (409) dengan pesan generik yang tidak membocorkan pemilik', async () => {
      const a = await buatMember();
      const b = await buatMember();
      const nik = nikBaru();
      await http('put', '/member/profile', a).send({ nik }).expect(200);
      const dup = await http('put', '/member/profile', b).send({ nik }).expect(409);
      expect(dup.body.kode).toBe('NIK_TIDAK_DAPAT_DIGUNAKAN');
      expect(JSON.stringify(dup.body)).not.toContain(nik);
      expect(JSON.stringify(dup.body)).not.toMatch(/dimiliki|sudah terdaftar atas/i);
      expect((await http('get', '/member/profile', b).expect(200)).body.nik).toBeNull();
    });

    it('pengajuan: biodata/KTP belum lengkap ditolak (daftar kekurangan); lengkap -> MENUNGGU_VERIFIKASI; ajukan ulang 409', async () => {
      const m = await buatMember();
      await http('put', '/member/profile', m).send({ fullName: 'SINTETIS Pelamar' }).expect(200);
      const kurang = await http('post', '/member/profile/submit', m).expect(400);
      expect(kurang.body.kode).toBe('PROFIL_BELUM_LENGKAP');
      expect(kurang.body.pesan).toMatch(/NIK.*Dokumen KTP/);
      await http('put', '/member/profile', m).send(LENGKAP(nikBaru())).expect(200);
      expect((await http('post', '/member/profile/submit', m).expect(400)).body.pesan).toMatch(/Dokumen KTP/); // biodata lengkap, KTP belum
      await ktp(m).expect(201);
      expect((await http('post', '/member/profile/submit', m).expect(200)).body.status).toBe('MENUNGGU_VERIFIKASI');
      expect((await http('post', '/member/profile/submit', m).expect(409)).body.kode).toBe('TRANSISI_TIDAK_VALID');
      expect((await profilDb(m.personId)).submitted_at).not.toBeNull();
      expect((await bacaAudit('member.profile.submitted')).length).toBeGreaterThan(0);
    });

    it('mengubah data saat menunggu verifikasi mengembalikan status ke PROFIL_BELUM_LENGKAP; setelah terverifikasi profil terkunci', async () => {
      const m = await buatMember();
      await http('put', '/member/profile', m).send(LENGKAP(nikBaru())).expect(200);
      await ktp(m).expect(201);
      await http('post', '/member/profile/submit', m).expect(200);
      expect((await http('put', '/member/profile', m).send({ city: 'Cimahi' }).expect(200)).body.status).toBe('PROFIL_BELUM_LENGKAP');
      await http('post', '/member/profile/submit', m).expect(200);
      // verifikasi oleh HRD disimulasikan di DB (alurnya diuji di 5C)
      const staff = (await pool.query(`INSERT INTO users (realm, email, status) VALUES ('staff', $1, 'AKTIF') RETURNING id`, [`s-${randomBytes(4).toString('hex')}@contoh.invalid`])).rows[0].id;
      await pool.query(`UPDATE member_profiles SET status = 'TERVERIFIKASI', verified_by = $2, verified_at = now() WHERE person_id = $1`, [m.personId, staff]);
      expect((await http('put', '/member/profile', m).send({ city: 'Bogor' }).expect(409)).body.kode).toBe('PROFIL_TERKUNCI');
      await ktp(m, PDF, 'lain.pdf', 'IJAZAH').expect(409);
    });

    it('audit perubahan hanya memuat nama bidang, bukan nilai (NIK/nama)', async () => {
      const m = await buatMember();
      const nik = nikBaru();
      await http('put', '/member/profile', m).send({ nik, fullName: 'SINTETIS Nama Rahasia Uji' }).expect(200);
      const aud = (await bacaAudit('member.profile.updated')).filter((d) => d.includes('"nik"'));
      expect(aud.length).toBeGreaterThan(0);
      expect(aud.some((d) => d.includes(nik) || d.includes('Nama Rahasia Uji'))).toBe(false);
    });
  });

  describe('dokumen identitas', () => {
    it('unggah KTP: isi tersimpan TERENKRIPSI (bukan plaintext), unduh pemilik mengembalikan isi asli, tanpa kunci objek di respons', async () => {
      const m = await buatMember();
      const up = await ktp(m).expect(201);
      expect(JSON.stringify(up.body)).not.toMatch(/object_key|objectKey|\/tmp|hris-member/);
      const key = (await pool.query(`SELECT object_key FROM member_documents WHERE id = $1`, [up.body.id])).rows[0].object_key as string;
      expect(key.startsWith(`${m.personId}/`)).toBe(true);
      const mentah = fs.readFileSync(join(STORAGE, key));
      expect(mentah.includes(Buffer.from('KTP-SINTETIS-ISI-RAHASIA-UJI'))).toBe(false);
      expect(mentah.subarray(0, 4).toString()).not.toBe('%PDF');
      const dl = await http('get', `/member/documents/${up.body.id}/download`, m).buffer(true).parse((r, cb) => { const b: Buffer[] = []; r.on('data', (d) => b.push(d)); r.on('end', () => cb(null, Buffer.concat(b))); }).expect(200);
      expect(Buffer.compare(dl.body as Buffer, PDF)).toBe(0);
      expect(dl.headers['content-disposition']).toMatch(/^attachment/);
      expect(dl.headers['x-content-type-options']).toBe('nosniff');
      expect(dl.headers['cache-control']).toMatch(/no-store/);
    });

    it('satu KTP aktif: unggah kedua 409; hapus lalu unggah ulang berhasil; unduhan setelah hapus 404', async () => {
      const m = await buatMember();
      const a = (await ktp(m).expect(201)).body;
      expect((await ktp(m).expect(409)).body.kode).toBe('DOKUMEN_SUDAH_ADA');
      await http('delete', `/member/documents/${a.id}`, m).expect(204);
      await http('get', `/member/documents/${a.id}/download`, m).expect(404);
      await ktp(m).expect(201);
      expect(((await http('get', '/member/documents', m).expect(200)).body.items as unknown[]).length).toBe(1);
    });

    it.each([
      ['berkas executable bernama .pdf', Buffer.from('MZ\x90\x00\x03' + 'x'.repeat(40)), 'ktp.pdf', 415],
      ['PNG bernama .pdf (ekstensi tidak sesuai)', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]), 'ktp.pdf', 400],
      ['berkas kosong', Buffer.alloc(0), 'ktp.pdf', 400],
      ['lebih dari 10 MB', Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024)]), 'ktp.pdf', 413],
    ])('menolak %s', async (_n, isi, nama, status) => {
      const m = await buatMember();
      await ktp(m, isi, nama).expect(status);
      expect(((await http('get', '/member/documents', m).expect(200)).body.items as unknown[]).length).toBe(0);
    });

    it('menolak tanpa berkas, jenis tidak sah; nama berkas traversal disanitasi', async () => {
      const m = await buatMember();
      await http('post', '/member/documents', m).field('kind', 'KTP').expect(400);
      await ktp(m, PDF, 'ktp.pdf', 'SELFIE').expect(400);
      const ok = await ktp(m, PDF, '../../etc/passwd.pdf').expect(201);
      expect(ok.body.originalFilename).not.toMatch(/\.\.|\//);
    });
  });

  describe('isolasi antarmember dan antarrealm', () => {
    it('member A tidak dapat mengunduh/menghapus dokumen B (404); profil selalu milik sesi sendiri', async () => {
      const a = await buatMember();
      const b = await buatMember();
      const dok = (await ktp(b).expect(201)).body;
      await http('get', `/member/documents/${dok.id}/download`, a).expect(404);
      await http('delete', `/member/documents/${dok.id}`, a).expect(404);
      expect(((await http('get', '/member/documents', a).expect(200)).body.items as unknown[]).length).toBe(0);
      await http('put', '/member/profile', b).send({ city: 'Bandung' }).expect(200);
      expect((await http('get', '/member/profile', a).expect(200)).body.city).toBeNull();
      await http('get', `/member/documents/${dok.id}/download`, b).expect(200); // milik B tetap utuh
    });

    it('tanpa sesi 401; staff tidak dapat memakai rute member (403); CSRF dan Origin ditegakkan', async () => {
      await http('get', '/member/profile').expect(401);
      const staffId = (await pool.query(`INSERT INTO users (realm, email, status) VALUES ('staff', $1, 'AKTIF') RETURNING id`, [`s-${randomBytes(4).toString('hex')}@contoh.invalid`])).rows[0].id as string;
      const ss = await sessions.buat({ userId: staffId, realm: 'staff', state: 'PENUH' });
      const staff = { cookie: `__Host-sid=${ss.token}`, csrf: ss.csrfToken };
      await http('get', '/member/profile', staff).expect(403);
      await http('put', '/member/profile', staff).send({ city: 'X' }).expect(403);
      const m = await buatMember();
      await http('put', '/member/profile', m, { tanpaCsrf: true }).send({ city: 'X' }).expect(403);
      await http('put', '/member/profile', m, { origin: 'https://jahat.invalid' }).send({ city: 'X' }).expect(403);
      await http('post', '/member/documents', m, { tanpaCsrf: true }).field('kind', 'KTP').attach('berkas', PDF, 'a.pdf').expect(403);
    });
  });
});
