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
const ROLES = ['DIREKTUR', 'MANAGER_OPERASIONAL', 'IT_ADMIN', 'HRD', 'MARKETING', 'STAFF_ADMINISTRASI', 'STAFF_PAYROLL_ABSENSI_REKANAN', 'STAFF_KEUANGAN', 'STAFF_PAYROLL_INTERNAL'];

// Semua NIK/nama di bawah ini SINTETIS (bukan data pekerja nyata).
const nikBaru = () => `99${String(Math.floor(Math.random() * 1e14)).padStart(14, '0')}`;
const PDF = Buffer.from('%PDF-1.4\nKTP-SINTETIS-ISI-RAHASIA-UJI\n%%EOF\n');
const LENGKAP = (nik: string) => ({
  fullName: 'SINTETIS Pelamar Uji', nik, birthPlace: 'Bandung', birthDate: '1995-05-17', gender: 'L', address: 'Jl. Contoh No. 1', city: 'Bandung', province: 'Jawa Barat',
  phone: '081234567890', education: 'SMA/SMK', emergencyContactName: 'SINTETIS Kerabat', emergencyContactPhone: '081234500000',
});

jalan('verifikasi HRD dan database member untuk staff (PostgreSQL asli)', () => {
  let app: INestApplication;
  let pool: Pool;
  let nomorIp = 1;
  let sessions: import('../src/auth/session.service').SessionService;

  beforeAll(async () => {
    execFileSync('node', ['scripts/migrate.js', 'up'], { env: { ...process.env, DATABASE_URL: DB_URL } });
    const { AppModule } = await import('../src/app.module');
    const { konfigurasiApp } = await import('../src/app.factory');
    const { SessionService } = await import('../src/auth/session.service');
    process.env.DATABASE_URL = DB_URL;
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
  const buatStaff = async (role: string): Promise<Sesi> => {
    const u = (await pool.query(`INSERT INTO users (realm, email, status) VALUES ('staff', $1, 'AKTIF') RETURNING id`, [`s-${randomBytes(4).toString('hex')}@contoh.invalid`])).rows[0].id as string;
    await pool.query(`INSERT INTO user_roles (user_id, role_code, grant_source) VALUES ($1, $2, 'MANUAL')`, [u, role]);
    const s = await sessions.buat({ userId: u, realm: 'staff', state: 'PENUH' });
    return { cookie: `__Host-sid=${s.token}`, csrf: s.csrfToken, userId: u, personId: '' };
  };
  const profilDb = async (personId: string) => (await pool.query(`SELECT * FROM member_profiles WHERE person_id = $1`, [personId])).rows[0];
  /** Audit untuk objek tertentu (tabel audit persisten antarrun; jangan puas dengan baris milik run lain). */
  const bacaAuditObjek = async (aksi: string, objekId: string) => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.audit_global', 'on', true)`);
      const r = await c.query(`SELECT detail::text AS d FROM audit_logs WHERE action = $1 AND object_id = $2`, [aksi, objekId]);
      await c.query('ROLLBACK');
      return r.rows.map((x) => x.d as string);
    } finally {
      c.release();
    }
  };


  /** Member yang sudah mengisi biodata lengkap + KTP dan mengajukan verifikasi. */
  const menunggu = async () => {
    const m = await buatMember();
    const nik = nikBaru();
    await http('put', '/member/profile', m).send(LENGKAP(nik)).expect(200);
    const dok = (await ktp(m).expect(201)).body;
    await http('post', '/member/profile/submit', m).expect(200);
    const id = (await profilDb(m.personId)).id as string;
    return { m, nik, id, docId: dok.id as string };
  };

  describe('alur verifikasi HRD', () => {
    it('daftar/detail menyamarkan NIK; HRD kembalikan (alasan wajib) -> member revisi -> ajukan ulang -> HRD setujui', async () => {
      const hrd = await buatStaff('HRD');
      const { m, nik, id } = await menunggu();
      const daftar = (await http('get', '/members?status=MENUNGGU_VERIFIKASI&limit=100', hrd).expect(200)).body;
      const butir = (daftar.items as { id: string; nik: string }[]).find((x) => x.id === id)!;
      expect(butir.nik).toBe(`************${nik.slice(-4)}`);
      const detail = (await http('get', `/members/${id}`, hrd).expect(200)).body;
      expect(detail.nik).toBe(`************${nik.slice(-4)}`);
      expect(JSON.stringify([daftar, detail])).not.toContain(nik);
      expect(JSON.stringify(detail)).not.toMatch(/object_key|objectKey|nik_enc|nik_hmac/);
      expect(detail.documents).toHaveLength(1);

      await http('post', `/members/${id}/return`, hrd).send({}).expect(400);
      await http('post', `/members/${id}/return`, hrd).send({ reason: 'ab' }).expect(400);
      await http('post', `/members/${id}/return`, hrd).send({ reason: 'Foto KTP kurang jelas, mohon unggah ulang' }).expect(200);
      const lihat = (await http('get', '/member/profile', m).expect(200)).body;
      expect(lihat.status).toBe('PROFIL_BELUM_LENGKAP');
      expect(lihat.reviewNote).toBe('Foto KTP kurang jelas, mohon unggah ulang');
      const hist = (await http('get', '/member/profile/history', m).expect(200)).body.items as { to: string; reason: string | null }[];
      expect(hist.some((h) => h.reason === 'Foto KTP kurang jelas, mohon unggah ulang')).toBe(true);
      await http('post', `/members/${id}/return`, hrd).send({ reason: 'Sudah dikembalikan' }).expect(409); // bukan MENUNGGU_VERIFIKASI lagi
      await http('post', `/members/${id}/approve`, hrd).expect(409);

      await http('post', '/member/profile/submit', m).expect(200);
      expect((await http('get', '/member/profile', m).expect(200)).body.reviewNote).toBeNull();
      expect((await http('post', `/members/${id}/approve`, hrd).expect(200)).body.status).toBe('BELUM_DITEMPATKAN');
      const p = await profilDb(m.personId);
      expect(p.status).toBe('BELUM_DITEMPATKAN');
      expect(p.verified_by).toBe(hrd.userId);
      const riwayat = (await pool.query(`SELECT to_status FROM member_status_histories WHERE person_id = $1 ORDER BY created_at, id`, [m.personId])).rows.map((x) => x.to_status);
      expect(riwayat).toEqual(expect.arrayContaining(['MENUNGGU_VERIFIKASI', 'PROFIL_BELUM_LENGKAP', 'TERVERIFIKASI', 'BELUM_DITEMPATKAN']));
      await http('post', `/members/${id}/approve`, hrd).expect(409);
      expect((await bacaAuditObjek('member.profile.approved', id)).length).toBe(1);
      expect((await bacaAuditObjek('member.profile.returned', id)).length).toBe(1);
    });

    it('persetujuan serentak: hanya satu berhasil', async () => {
      const h1 = await buatStaff('HRD');
      const h2 = await buatStaff('HRD');
      const { id } = await menunggu();
      const r = await Promise.all([http('post', `/members/${id}/approve`, h1), http('post', `/members/${id}/approve`, h2)]);
      expect(r.map((x) => x.status).sort()).toEqual([200, 409]);
    });

    it('reveal NIK dan unduh dokumen hanya untuk member.review, keduanya diaudit; isi dokumen terdekripsi', async () => {
      const hrd = await buatStaff('HRD');
      const { nik, id, docId } = await menunggu();
      const r = await http('get', `/members/${id}/nik`, hrd).expect(200);
      expect(r.body.nik).toBe(nik);
      expect(r.headers['cache-control']).toMatch(/no-store/);
      expect((await bacaAuditObjek('member.nik.revealed', id)).length).toBe(1);
      const dl = await http('get', `/members/${id}/documents/${docId}/download`, hrd).buffer(true).parse((res, cb) => { const b: Buffer[] = []; res.on('data', (d) => b.push(d)); res.on('end', () => cb(null, Buffer.concat(b))); }).expect(200);
      expect(Buffer.compare(dl.body as Buffer, PDF)).toBe(0);
      expect(dl.headers['content-disposition']).toMatch(/^attachment/);
      expect((await bacaAuditObjek('member.document.downloaded_by_staff', docId)).length).toBe(1);
      for (const peran of ['DIREKTUR', 'STAFF_ADMINISTRASI', 'MARKETING', 'MANAGER_OPERASIONAL']) {
        const s = await buatStaff(peran);
        await http('get', `/members/${id}/nik`, s).expect(403);
        await http('get', `/members/${id}/documents/${docId}/download`, s).expect(403);
      }
      // dokumen milik member lain tidak dapat diunduh lewat ID member yang salah
      const lain = await menunggu();
      await http('get', `/members/${id}/documents/${lain.docId}/download`, hrd).expect(404);
    });

    it('ID tidak dikenal 404, ID rusak 400; member tidak dapat memakai rute staff (403)', async () => {
      const hrd = await buatStaff('HRD');
      await http('get', `/members/${'00000000-0000-4000-8000-000000000000'}`, hrd).expect(404);
      await http('get', '/members/bukan-uuid', hrd).expect(400);
      const { m } = await menunggu();
      await http('get', '/members', m).expect(403);
      await http('get', '/members/summary', m).expect(403);
    });
  });

  describe('daftar dan ringkasan', () => {
    it('keyset tanpa duplikat; pencarian nama memperlakukan % dan _ sebagai teks; batas dan kursor divalidasi', async () => {
      const hrd = await buatStaff('HRD');
      const tanda = `Zz${randomBytes(3).toString('hex')}`;
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const m = await buatMember();
        await http('put', '/member/profile', m).send({ fullName: `SINTETIS ${tanda} ${i}` }).expect(200);
        ids.push((await profilDb(m.personId)).id);
      }
      const lihat = new Set<string>();
      let kursor: string | null = null;
      let n = 0;
      do {
        const r: request.Response = await http('get', `/members?limit=2&q=${tanda}${kursor ? `&cursor=${kursor}` : ''}`, hrd).expect(200);
        for (const x of r.body.items as { id: string }[]) {
          expect(lihat.has(x.id)).toBe(false);
          lihat.add(x.id);
        }
        kursor = r.body.nextCursor;
        n++;
      } while (kursor && n < 20);
      expect([...lihat].sort()).toEqual([...ids].sort());
      expect(((await http('get', `/members?q=${encodeURIComponent('%%')}`, hrd).expect(200)).body.items as unknown[]).length).toBe(0);
      expect(((await http('get', `/members?q=${encodeURIComponent('S_NTETIS ' + tanda)}`, hrd).expect(200)).body.items as unknown[]).length).toBe(0);
      await http('get', '/members?q=a', hrd).expect(400);
      await http('get', '/members?limit=101', hrd).expect(400);
      await http('get', '/members?status=ASAL', hrd).expect(400);
      await http('get', '/members?cursor=bukan-kursor', hrd).expect(400);
    });

    it('satu baris dengan NIK yang tidak dapat didekripsi tidak mematikan daftar (nik = null)', async () => {
      const hrd = await buatStaff('HRD');
      const { id } = await menunggu();
      await pool.query(`UPDATE member_profiles SET nik_enc = $2 WHERE id = $1`, [id, randomBytes(60)]);
      const r = await http('get', '/members?status=MENUNGGU_VERIFIKASI&limit=100', hrd).expect(200);
      expect((r.body.items as { id: string; nik: string | null }[]).find((x) => x.id === id)!.nik).toBeNull();
      await http('get', `/members/${id}`, hrd).expect(200);
      await http('get', `/members/${id}/nik`, hrd).expect(500); // reveal tidak boleh diam-diam gagal
    });

    it('ringkasan hanya hitungan per status tanpa data pribadi', async () => {
      const mkt = await buatStaff('MARKETING');
      await menunggu();
      const r = (await http('get', '/members/summary', mkt).expect(200)).body;
      const butir = r.items as { status: string; jumlah: number }[];
      expect(butir.find((x) => x.status === 'MENUNGGU_VERIFIKASI')!.jumlah).toBeGreaterThan(0);
      for (const x of butir) expect(Object.keys(x).sort()).toEqual(['jumlah', 'status']);
    });
  });

  describe('matriks izin database member (sesuai docs/rbac.md)', () => {
    // [lihat daftar/detail (view), ringkasan (view_summary), review (NIK/dokumen/kembalikan), setujui (approve)]
    const izin: Record<string, [boolean, boolean, boolean, boolean]> = {
      DIREKTUR: [true, false, false, false],
      MANAGER_OPERASIONAL: [false, true, false, false],
      IT_ADMIN: [false, true, false, false],
      HRD: [true, false, true, true],
      MARKETING: [false, true, false, false],
      STAFF_ADMINISTRASI: [true, false, false, false],
      STAFF_PAYROLL_ABSENSI_REKANAN: [false, false, false, false],
      STAFF_KEUANGAN: [false, false, false, false],
      STAFF_PAYROLL_INTERNAL: [false, false, false, false],
    };
    it('mencakup semua peran', () => expect(Object.keys(izin).sort()).toEqual([...ROLES].sort()));
    it.each(Object.entries(izin))('%s', async (peranKode, [v, sm, rv, ap]) => {
      const { id, docId } = await menunggu();
      const s = await buatStaff(peranKode);
      const cek = async (boleh: boolean, res: request.Test) => {
        const r = await res;
        if (boleh) expect(r.status).not.toBe(403);
        else expect(r.status).toBe(403);
      };
      await cek(v, http('get', '/members', s));
      await cek(v, http('get', `/members/${id}`, s));
      await cek(sm, http('get', '/members/summary', s));
      await cek(rv, http('get', `/members/${id}/nik`, s));
      await cek(rv, http('get', `/members/${id}/documents/${docId}/download`, s));
      await cek(rv, http('post', `/members/${id}/return`, s).send({ reason: 'uji izin' }));
      await cek(ap, http('post', `/members/${id}/approve`, s));
    });
  });
});
