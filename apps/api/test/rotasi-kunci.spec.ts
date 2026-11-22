import 'reflect-metadata';
import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { generateSync } from 'otplib';
import { Pool } from 'pg';
import request from 'supertest';
import { cincinKunci, dekripsi, enkripsi } from '../src/common/crypto/crypto';
import { dekripsiBerkas, dekripsiNik, enkripsiBerkas, enkripsiNik } from '../src/common/crypto/pii';
import { LocalObjectStorage } from '../src/common/storage/local-storage';
import { type Ringkasan, jalankanRotasi } from '../src/ops/rotasi-kunci';

/**
 * Rotasi kunci enkripsi (ADR-0013) pada PostgreSQL asli. Alat rotasi wajib role superuser/BYPASSRLS: pada mode non-superuser (role pemilik biasa)
 * hanya uji penolakan yang berjalan; uji penuh berjalan di CI dan pada mode superuser lokal.
 */
const DB_URL = process.env.TEST_DATABASE_URL;
const jalan = DB_URL ? describe : describe.skip;

const ORIGIN = 'https://hris.contoh.invalid';
const K1 = randomBytes(32);
const K2 = randomBytes(32);
process.env.APP_BASE_URL = ORIGIN;
process.env.AUTH_HMAC_KEY = randomBytes(32).toString('base64');
delete process.env.APP_ENCRYPTION_KEY;
process.env.APP_ENCRYPTION_KEYS = `1:${K1.toString('base64')},2:${K2.toString('base64')}`;
process.env.TRUST_PROXY = '1';
const PASSWORD = 'kuda lari malam hari di sawah';
const SKEMA = `rotasi_${randomBytes(4).toString('hex')}`;

const ring1 = cincinKunci([{ id: 1, kunci: K1 }]);
const ring2saja = cincinKunci([{ id: 2, kunci: K2 }]);
const ring12 = cincinKunci([{ id: 1, kunci: K1 }, { id: 2, kunci: K2 }]);
/** Format lama sebelum rotasi: iv | tag | ciphertext, tanpa awalan, kunci id 1. */
const formatLama = (plain: Buffer | string, aad: string): Buffer => {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', K1, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
};
const kunciObjek = (id: string) => `${id}/${randomUUID()}`;

jalan('Rotasi kunci enkripsi (PostgreSQL asli)', () => {
  let adm: Pool; // koneksi pemilik/superuser ke skema terisolasi (hitungan tepat)
  let pub: Pool; // koneksi ke skema public (uji aplikasi)
  let bypass = false;
  let app: INestApplication;
  let storage: LocalObjectStorage;
  let storageDir: string;
  let appPool: Pool;
  let nomorIp = 1;

  const seed = async (pool: Pool, penyimpan: LocalObjectStorage) => {
    const c = await pool.connect();
    const id = { nikLama: randomUUID(), nikV1: randomUUID(), mfa: randomUUID(), outbox: randomUUID(), doc: randomUUID(), dok: randomUUID(), selfie: randomUUID(), hilang: randomUUID(), tertukar: randomUUID() };
    try {
      await c.query('BEGIN');
      await c.query(`SET LOCAL session_replication_role = replica`); // data sintetis tanpa rantai FK
      const person = async (pid: string, nik: Buffer) => {
        await c.query(`INSERT INTO persons (id, display_name) VALUES ($1, 'SINTETIS Rotasi')`, [pid]);
        await c.query(`INSERT INTO member_profiles (id, person_id, status, nik_enc, nik_hmac) VALUES ($1, $2, 'TERDAFTAR', $3, $4)`, [pid, pid, nik, randomBytes(32)]);
      };
      await person(id.nikLama, formatLama('3201010101010001', `member_profile:${id.nikLama}:nik`));
      await person(id.nikV1, enkripsiNik('3201010101010002', ring1, id.nikV1));
      const user = randomUUID();
      await c.query(`INSERT INTO persons (id, display_name) VALUES ($1, 'SINTETIS Staf')`, [user]);
      await c.query(`INSERT INTO users (id, person_id, realm, email, status) VALUES ($1, $1, 'staff', $2, 'AKTIF')`, [user, `rot-${randomBytes(4).toString('hex')}@contoh.invalid`]);
      await c.query(`INSERT INTO staff_mfa_factors (id, user_id, secret_enc, status, confirmed_at) VALUES ($1, $2, $3, 'AKTIF', now())`, [id.mfa, user, formatLama('JBSWY3DPEHPK3PXP', `mfa:${user}`)]);
      await c.query(`INSERT INTO notification_outbox (id, channel, recipient, template, payload_enc, status) VALUES ($1, 'email', 'x@contoh.invalid', 't', $2, 'GAGAL')`, [id.outbox, enkripsi('{"a":"b"}', ring1, `outbox:${id.outbox}`)]);
      const perusahaan = randomUUID();
      const obj = async (tabel: 'member_documents' | 'contract_documents' | 'attendance_selfies', baris: string, isi: Buffer, owner: string) => {
        const kunci = kunciObjek(owner);
        await penyimpan.simpan(kunci, isi.length ? enkripsiBerkas(isi, ring1, kunci) : isi);
        if (tabel === 'member_documents') await c.query(`INSERT INTO member_documents (id, person_id, kind, object_key, original_filename, mime_type, size_bytes, sha256) VALUES ($1, $2, 'LAINNYA', $3, 'a.pdf', 'application/pdf', $4, $5)`, [baris, owner, kunci, isi.length || 1, randomBytes(32)]);
        if (tabel === 'contract_documents') await c.query(`INSERT INTO contract_documents (id, company_id, contract_id, version_no, object_key, original_filename, mime_type, size_bytes, sha256, uploaded_by) VALUES ($1, $2, $3, 1, $4, 'k.pdf', 'application/pdf', $5, $6, $7)`, [baris, perusahaan, randomUUID(), kunci, isi.length, randomBytes(32), randomUUID()]);
        if (tabel === 'attendance_selfies') await c.query(`INSERT INTO attendance_selfies (id, company_id, record_id, storage_key, sha256, size_bytes, purge_after) VALUES ($1, $2, $3, $4, $5, $6, now() + interval '30 days')`, [baris, perusahaan, randomUUID(), kunci, 'a'.repeat(64), isi.length]);
        return kunci;
      };
      const kDoc = await obj('member_documents', id.doc, Buffer.from('ISI-DOKUMEN-SINTETIS'), id.nikV1);
      // objek lama (format tanpa awalan) untuk dokumen kontrak
      const kKon = kunciObjek(perusahaan);
      await penyimpan.simpan(kKon, formatLama(Buffer.from('ISI-KONTRAK-SINTETIS'), `berkas:${kKon}`));
      await c.query(`INSERT INTO contract_documents (id, company_id, contract_id, version_no, object_key, original_filename, mime_type, size_bytes, sha256, uploaded_by) VALUES ($1, $2, $3, 1, $4, 'k.pdf', 'application/pdf', 20, $5, $6)`, [id.dok, perusahaan, randomUUID(), kKon, randomBytes(32), randomUUID()]);
      const kSelfie = await obj('attendance_selfies', id.selfie, Buffer.from('FOTO-SINTETIS'), perusahaan);
      // objek yang HILANG dari penyimpanan
      await c.query(`INSERT INTO member_documents (id, person_id, kind, object_key, original_filename, mime_type, size_bytes, sha256) VALUES ($1, $2, 'IJAZAH', $3, 'h.pdf', 'application/pdf', 5, $4)`, [id.hilang, id.nikV1, kunciObjek(id.nikV1), randomBytes(32)]);
      // objek TERTUKAR: isi dienkripsi untuk kunci objek lain (AAD tidak cocok) -> tidak boleh dirotasi diam-diam
      const kTuker = kunciObjek(id.nikV1);
      await penyimpan.simpan(kTuker, enkripsiBerkas(Buffer.from('MILIK-LAIN'), ring1, kunciObjek(id.nikV1)));
      await c.query(`INSERT INTO member_documents (id, person_id, kind, object_key, original_filename, mime_type, size_bytes, sha256) VALUES ($1, $2, 'LAINNYA', $3, 't.pdf', 'application/pdf', 10, $4)`, [id.tertukar, id.nikV1, kTuker, randomBytes(32)]);
      await c.query('COMMIT');
      return { id, user, kDoc, kKon, kSelfie, kTuker };
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  };
  const nilai = async (pool: Pool, tabel: string, kolom: string, id: string): Promise<Buffer> => (await pool.query(`SELECT ${kolom} AS n FROM ${tabel} WHERE id = $1`, [id])).rows[0].n;
  const jalankan = (perintah: 'cek' | 'jalan' | 'verifikasi', o: { pool?: Pool; kering?: boolean; kunci?: typeof ring12 } = {}): Promise<Ringkasan> =>
    jalankanRotasi({ pool: o.pool ?? adm, kunci: o.kunci ?? ring12, storage, perintah, kering: o.kering, batas: 2 });
  const hasil = (r: Ringkasan, nama: string) => r.hasil.find((h) => h.nama === nama)!;

  beforeAll(async () => {
    storageDir = mkdtempSync(join(tmpdir(), 'hris-rotasi-'));
    process.env.STORAGE_DIR = storageDir;
    storage = new LocalObjectStorage(storageDir);
    const url = (extra: string) => `${DB_URL}${DB_URL!.includes('?') ? '&' : '?'}${extra}`;
    execFileSync('node', ['scripts/migrate.js', 'up'], { env: { ...process.env, DATABASE_URL: DB_URL } });
    execFileSync('node', ['scripts/migrate.js', 'up'], { env: { ...process.env, DATABASE_URL: DB_URL, MIGRATE_SCHEMA: SKEMA } });
    adm = new Pool({ connectionString: url(`options=${encodeURIComponent(`-c search_path=${SKEMA}`)}`), max: 2 });
    pub = new Pool({ connectionString: DB_URL, max: 2 });
    bypass = (await adm.query(`SELECT rolsuper OR rolbypassrls AS l FROM pg_roles WHERE rolname = current_user`)).rows[0].l;
    // aplikasi berjalan sebagai role NON-superuser tanpa BYPASSRLS (syarat ADR-0003)
    await pub.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hris_app_uji') THEN CREATE ROLE hris_app_uji NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$`);
    await pub.query(`GRANT hris_app_uji TO CURRENT_USER`);
    await pub.query(`GRANT ALL ON ALL TABLES IN SCHEMA public TO hris_app_uji`);
    await pub.query(`GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO hris_app_uji`);
    process.env.DATABASE_URL = url(`options=${encodeURIComponent('-c role=hris_app_uji')}`);
    appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    const { AppModule } = await import('../src/app.module');
    const { konfigurasiApp } = await import('../src/app.factory');
    const { EMAIL_CHANNEL } = await import('../src/notifications/email.channel');
    const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(EMAIL_CHANNEL).useValue({ tersedia: () => true, kirim: async () => undefined }).compile();
    app = mod.createNestApplication();
    konfigurasiApp(app);
    await app.init();
  });
  afterAll(async () => {
    await adm?.query(`DROP SCHEMA IF EXISTS ${SKEMA} CASCADE`).catch(() => undefined);
    await Promise.all([adm?.end(), pub?.end(), appPool?.end()]);
    await app?.close();
  });

  const bila = (nama: string, fn: () => Promise<void>) => it(nama, async () => {
    if (!bypass) return; // butuh superuser/BYPASSRLS (CI); mode non-superuser hanya menguji penolakan
    await fn();
  });

  it('role biasa (tanpa BYPASSRLS) DITOLAK: RLS dipaksa, alat tidak boleh berjalan dengan role aplikasi', async () => {
    await expect(jalankanRotasi({ pool: appPool, kunci: ring12, storage, perintah: 'cek' })).rejects.toThrow(/BYPASSRLS/);
    if (!bypass) await expect(jalankan('cek')).rejects.toThrow(/BYPASSRLS/);
  });

  describe('skema terisolasi (hitungan tepat)', () => {
    let s: Awaited<ReturnType<typeof seed>>;
    beforeAll(async () => { if (bypass) s = await seed(adm, storage); });

    bila('cek: mengelompokkan data per versi tanpa mengubah apa pun; tiap data terdeteksi (format lama vs v1), yang tertukar dan hilang dilaporkan', async () => {
      const sebelum = await nilai(adm, 'member_profiles', 'nik_enc', s.id.nikLama);
      const r = await jalankan('cek');
      expect(r.kunciAktif).toBe(2);
      expect(hasil(r, 'NIK member')).toMatchObject({ total: 2, perVersi: { lama: 1, '1': 1 }, diubah: 0 });
      expect(hasil(r, 'Rahasia TOTP staf')).toMatchObject({ total: 1, perVersi: { lama: 1 } });
      expect(hasil(r, 'Payload outbox')).toMatchObject({ total: 1, perVersi: { '1': 1 } });
      expect(hasil(r, 'Berkas member')).toMatchObject({ total: 3, hilang: 1, gagalDekripsi: 1, perVersi: { '1': 1 } }); // 1 baik, 1 hilang, 1 tertukar
      expect(hasil(r, 'Dokumen kontrak')).toMatchObject({ total: 1, perVersi: { lama: 1 } });
      expect(hasil(r, 'Selfie absensi')).toMatchObject({ total: 1, perVersi: { '1': 1 } });
      expect(r.bersih).toBe(false);
      expect((await nilai(adm, 'member_profiles', 'nik_enc', s.id.nikLama)).equals(sebelum)).toBe(true);
    });

    bila('jalan --kering: melaporkan yang akan diubah tanpa menulis (DB maupun objek)', async () => {
      const nik = await nilai(adm, 'member_profiles', 'nik_enc', s.id.nikV1);
      const objek = readFileSync(join(storageDir, s.kDoc));
      const r = await jalankan('jalan', { kering: true });
      expect(hasil(r, 'NIK member').diubah).toBe(2);
      expect(hasil(r, 'Berkas member').diubah).toBe(1);
      expect((await nilai(adm, 'member_profiles', 'nik_enc', s.id.nikV1)).equals(nik)).toBe(true);
      expect(readFileSync(join(storageDir, s.kDoc)).equals(objek)).toBe(true);
      expect((await adm.query(`SELECT count(*)::int n FROM audit_logs WHERE action = 'system.key_rotation.run'`)).rows[0].n).toBe(0);
    });

    bila('jalan: semua data terenkripsi ulang ke kunci aktif; isi tetap sama; key_version NIK = 2; kunci lama tidak lagi dibutuhkan', async () => {
      const r = await jalankan('jalan');
      expect(hasil(r, 'NIK member').diubah).toBe(2);
      expect(hasil(r, 'Rahasia TOTP staf').diubah).toBe(1);
      expect(hasil(r, 'Payload outbox').diubah).toBe(1);
      expect(hasil(r, 'Berkas member').diubah).toBe(1);
      expect(hasil(r, 'Dokumen kontrak').diubah).toBe(1);
      expect(hasil(r, 'Selfie absensi').diubah).toBe(1);
      // hanya kunci 2 yang dipakai untuk membuka (kunci lama dibuang dari cincin)
      expect(dekripsiNik(await nilai(adm, 'member_profiles', 'nik_enc', s.id.nikLama), ring2saja, s.id.nikLama)).toBe('3201010101010001');
      expect(dekripsiNik(await nilai(adm, 'member_profiles', 'nik_enc', s.id.nikV1), ring2saja, s.id.nikV1)).toBe('3201010101010002');
      expect((await adm.query(`SELECT key_version FROM member_profiles WHERE id = ANY($1)`, [[s.id.nikLama, s.id.nikV1]])).rows.map((x) => x.key_version)).toEqual([2, 2]);
      expect(dekripsi(await nilai(adm, 'staff_mfa_factors', 'secret_enc', s.id.mfa), ring2saja, `mfa:${s.user}`).toString()).toBe('JBSWY3DPEHPK3PXP');
      expect(dekripsi(await nilai(adm, 'notification_outbox', 'payload_enc', s.id.outbox), ring2saja, `outbox:${s.id.outbox}`).toString()).toBe('{"a":"b"}');
      expect(dekripsiBerkas(readFileSync(join(storageDir, s.kDoc)), ring2saja, s.kDoc).toString()).toBe('ISI-DOKUMEN-SINTETIS');
      expect(dekripsiBerkas(readFileSync(join(storageDir, s.kKon)), ring2saja, s.kKon).toString()).toBe('ISI-KONTRAK-SINTETIS');
      expect(dekripsiBerkas(readFileSync(join(storageDir, s.kSelfie)), ring2saja, s.kSelfie).toString()).toBe('FOTO-SINTETIS');
    });

    bila('objek tertukar (AAD tidak cocok) TIDAK dirotasi diam-diam: tetap utuh dan dilaporkan sebagai gagal dekripsi', async () => {
      const sebelum = readFileSync(join(storageDir, s.kTuker));
      const r = await jalankan('jalan');
      expect(hasil(r, 'Berkas member').gagalDekripsi).toBe(1);
      expect(readFileSync(join(storageDir, s.kTuker)).equals(sebelum)).toBe(true);
    });

    bila('idempoten: jalan kedua tidak mengubah apa pun; verifikasi hanya dengan kunci aktif membuktikan (kecuali yang tertukar)', async () => {
      const nik = await nilai(adm, 'member_profiles', 'nik_enc', s.id.nikV1);
      const r = await jalankan('jalan');
      expect(r.hasil.reduce((a, h) => a + h.diubah, 0)).toBe(0);
      expect((await nilai(adm, 'member_profiles', 'nik_enc', s.id.nikV1)).equals(nik)).toBe(true);
      const v = await jalankan('verifikasi', { kunci: ring12 });
      expect(hasil(v, 'NIK member')).toMatchObject({ total: 2, perVersi: { '2': 2 }, gagalDekripsi: 0 });
      expect(hasil(v, 'Dokumen kontrak')).toMatchObject({ perVersi: { '2': 1 }, gagalDekripsi: 0 });
      expect(v.bersih).toBe(false); // hanya karena satu objek tertukar yang sengaja dibiarkan
    });

    bila('verifikasi mendeteksi kunci lama dibuang SEBELUM dienkripsi ulang (data v1 tak terbaca dengan cincin kunci 2 saja)', async () => {
      const idBaru = randomUUID();
      await adm.query(`INSERT INTO notification_outbox (id, channel, recipient, template, payload_enc, status) VALUES ($1, 'email', 'y@contoh.invalid', 't', $2, 'GAGAL')`, [idBaru, enkripsi('x', ring1, `outbox:${idBaru}`)]);
      const v = await jalankan('verifikasi', { kunci: ring12 });
      expect(hasil(v, 'Payload outbox')).toMatchObject({ total: 2, perVersi: { '2': 1 }, gagalDekripsi: 1 });
      await adm.query(`DELETE FROM notification_outbox WHERE id = $1`, [idBaru]);
    });

    bila('perubahan serentak tidak ditimpa: baris yang berubah saat dirotasi dilaporkan dan nilai terbarunya dipertahankan', async () => {
      const id = randomUUID();
      await adm.query(`INSERT INTO notification_outbox (id, channel, recipient, template, payload_enc, status) VALUES ($1, 'email', 'z@contoh.invalid', 't', $2, 'GAGAL')`, [id, enkripsi('lama', ring1, `outbox:${id}`)]);
      const terbaru = enkripsi('TERBARU', ring12, `outbox:${id}`); // penulis serentak (aplikasi) memakai kunci aktif
      let sudah = false;
      const pembungkus = { query: (sql: string, p?: unknown[]) => {
        if (!sudah && sql.startsWith('UPDATE "notification_outbox"')) {
          sudah = true;
          return adm.query(`UPDATE notification_outbox SET payload_enc = $2 WHERE id = $1`, [id, terbaru]).then(() => adm.query(sql, p));
        }
        return adm.query(sql, p);
      } } as unknown as Pool;
      const r = await jalankanRotasi({ pool: pembungkus, kunci: ring12, storage, perintah: 'jalan', batas: 100 });
      expect(hasil(r, 'Payload outbox').berubahSerentak).toBe(1);
      expect(dekripsi(await nilai(adm, 'notification_outbox', 'payload_enc', id), ring2saja, `outbox:${id}`).toString()).toBe('TERBARU');
      await adm.query(`DELETE FROM notification_outbox WHERE id = $1`, [id]);
    });

    bila('catatan audit teknis ada, berisi hitungan saja (tanpa nilai rahasia)', async () => {
      const r = (await adm.query(`SELECT detail, actor_id, company_id FROM audit_logs WHERE action = 'system.key_rotation.run' ORDER BY occurred_at`)).rows;
      expect(r.length).toBeGreaterThanOrEqual(2);
      expect(Object.keys(r[0].detail).sort()).toEqual(['diubah', 'gagal', 'kunciAktif']);
      expect(JSON.stringify(r)).not.toMatch(/3201010101010001|JBSWY3DPEHPK3PXP|ISI-DOKUMEN|rahasia/i);
    });
  });

  describe('aplikasi tetap bekerja setelah rotasi (skema public, role aplikasi)', () => {
    const ip = () => `10.91.${Math.floor(nomorIp / 250)}.${(nomorIp++ % 250) + 1}`;
    const cookie = (res: request.Response) => ((res.headers['set-cookie'] as unknown as string[] | undefined)?.find((x) => x.startsWith('__Host-sid=')) ?? '').split(';')[0];
    const http = (metode: 'post' | 'get', path: string, o: { cookie?: string; csrf?: string } = {}) => {
      let r = request(app.getHttpServer())[metode](path).set('X-Forwarded-For', ip()).set('Origin', ORIGIN);
      if (o.cookie) r = r.set('Cookie', o.cookie);
      if (o.csrf) r = r.set('X-CSRF-Token', o.csrf);
      return r;
    };

    bila('login staf dengan TOTP berjalan sebelum rotasi (rahasia format lama, cincin dua kunci) DAN sesudahnya (rahasia v2)', async () => {
      const { PasswordService } = await import('../src/auth/password.service');
      const hash = await app.get(PasswordService).hash(PASSWORD);
      const { generateSecret } = await import('otplib');
      const secret = generateSecret();
      const email = `rot-${randomBytes(4).toString('hex')}@contoh.invalid`;
      const p = (await pub.query(`INSERT INTO persons (display_name) VALUES ('SINTETIS Rotasi') RETURNING id`)).rows[0].id;
      const userId = (await pub.query(`INSERT INTO users (person_id, realm, email, status) VALUES ($1, 'staff', $2, 'AKTIF') RETURNING id`, [p, email])).rows[0].id as string;
      await pub.query(`INSERT INTO staff_credentials (user_id, password_hash) VALUES ($1, $2)`, [userId, hash]);
      await pub.query(`INSERT INTO staff_mfa_factors (user_id, secret_enc, status, confirmed_at) VALUES ($1, $2, 'AKTIF', now())`, [userId, formatLama(secret, `mfa:${userId}`)]);
      const masuk = async (offset: number) => {
        const l = await http('post', '/auth/staff/login').send({ email, password: PASSWORD }).expect(200);
        const v = await http('post', '/auth/staff/mfa/verify', { cookie: cookie(l), csrf: l.body.csrfToken }).send({ code: generateSync({ secret, epoch: Math.floor(Date.now() / 1000) + offset }) });
        return v.status;
      };
      expect(await masuk(30)).toBe(200); // sebelum rotasi
      const r = await jalankanRotasi({ pool: pub, kunci: ring12, storage, perintah: 'jalan', batas: 100 }); // data tetangga lain mungkin tidak terbaca: abaikan
      expect(r.hasil.find((h) => h.nama === 'Rahasia TOTP staf')!.diubah).toBeGreaterThanOrEqual(1);
      const tersimpan = (await pub.query(`SELECT secret_enc FROM staff_mfa_factors WHERE user_id = $1`, [userId])).rows[0].secret_enc as Buffer;
      expect(dekripsi(tersimpan, ring2saja, `mfa:${userId}`).toString()).toBe(secret);
      await pub.query(`UPDATE staff_mfa_factors SET last_used_step = NULL WHERE user_id = $1`, [userId]); // lepaskan proteksi pakai-ulang agar yang diuji hanya dekripsi
      expect(await masuk(30)).toBe(200); // sesudah rotasi
    });
  });
});
