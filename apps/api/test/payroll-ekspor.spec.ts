import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool, PoolClient } from 'pg';
import request from 'supertest';
import { PDFDocument } from 'pdf-lib';
import { bacaZip } from './helpers/zip';
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
jalan('Payroll: ekspor CSV/xlsx/PDF (PostgreSQL asli)', () => {
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
  const aksi = (id: string, jalur: string, x: Sesi, b: object = {}) => http('post', `/payroll/recaps/${id}/${jalur}`, x).send(b);


  const unduh = (id: string, ext: string, x: Sesi) =>
    http('get', `/payroll/recaps/${id}/export.${ext}`, x).buffer(true).parse((res, cb) => { const d: Buffer[] = []; res.on('data', (c: Buffer) => d.push(c)); res.on('end', () => { const b = Buffer.concat(d); cb(null, /json/.test(String(res.headers['content-type'])) ? JSON.parse(b.toString('utf8')) : b); }); });
  /** Rekap PARTNER disetujui dengan nama dan komponen berbahaya (formula injection) serta nominal desimal. */
  const rekapDisetujui = async (selesai: 'DISETUJUI' | 'DIFINALISASI' = 'DISETUJUI') => {
    const th = tahun();
    const x = await dasar(A);
    const jahat = await pekerja(x, '=HYPERLINK("http://jahat.invalid","klik")');
    const biasa = await pekerja(x, 'SINTETIS Normal, Koma');
    for (const w of [jahat, biasa]) {
      await rekaman(w, { tanggal: `${th}-03-02`, waktu: '07:00' });
      await rekaman(w, { tanggal: `${th}-03-02`, waktu: '15:30', kind: 'PULANG' });
    }
    const r = (await http('post', '/payroll/periods', s.payabs).send(periodeBody(th)).expect(201)).body;
    const d = (await http('post', `/payroll/recaps/${r.id}/pull`, s.payabs).expect(200)).body;
    const l1 = d.lines.find((l: { workerName: string }) => l.workerName.startsWith('=')).id;
    const l2 = d.lines.find((l: { workerName: string }) => l.workerName.startsWith('SINTETIS')).id;
    await komponen(r.id, l1, s.payabs, { kind: 'TUNJANGAN', name: '@SUM(1+1)', amount: '150000.50' }).expect(201);
    await komponen(r.id, l1, s.payabs, { kind: 'POTONGAN', name: '+cmd|x', amount: '0.10' }).expect(201);
    await komponen(r.id, l2, s.payabs, { kind: 'INSENTIF', name: '-2+3', amount: '999999999999.99' }).expect(201);
    await http('put', `/payroll/recaps/${r.id}/lines/${l2}`, s.payabs).send({ note: '=catatan berbahaya', overtimeHours: '2.25' }).expect(200);
    await aksi(r.id, 'verify', s.keu1).expect(200);
    await aksi(r.id, 'approve', s.dir1).expect(200);
    if (selesai === 'DIFINALISASI') await aksi(r.id, 'finalize', s.keu2).expect(200);
    return { id: r.id as string, periodId: r.periodId as string, th };
  };

  describe('izin dan status', () => {
    it('PARTNER: hanya Keuangan (payroll_recap_partner.export); INTERNAL: hanya PayInt; peran lain 403 untuk ketiga format', async () => {
      const { id } = await rekapDisetujui();
      for (const ext of ['csv', 'xlsx', 'pdf']) {
        for (const n of ['payabs', 'dir1', 'mo', 'hrd', 'adm', 'it', 'mkt', 'payint']) await unduh(id, ext, s[n]).expect(403);
        await unduh(id, ext, s.keu1).expect(200);
      }
      const i = await siapRekap('payint', { internal: true });
      const orang = (await pool.query(`INSERT INTO persons (display_name) VALUES ('SINTETIS Staf Internal') RETURNING id`)).rows[0].id as string;
      const t = (await http('post', `/payroll/recaps/${i.id}/lines`, s.payint).send({ personId: orang, workerName: 'SINTETIS Staf Internal' }).expect(201)).body;
      await komponen(i.id, t.lines[0].id, s.payint, { kind: 'TUNJANGAN', name: 'Jabatan', amount: '2500000' }).expect(201);
      await aksi(i.id, 'verify', s.keu1).expect(200);
      await aksi(i.id, 'approve', s.dir1).expect(200);
      for (const n of ['keu1', 'keu2', 'dir1', 'payabs', 'mo']) await unduh(i.id, 'csv', s[n]).expect(403);
      expect((await unduh(i.id, 'csv', s.payint).expect(200)).body.toString('utf8')).toContain('SINTETIS Staf Internal');
    });

    it('hanya DISETUJUI/DIFINALISASI; DRAFT, DIVERIFIKASI, dan DIGANTIKAN ditolak (409)', async () => {
      const { id, lineId } = await siapRekap();
      for (const ext of ['csv', 'xlsx', 'pdf']) expect((await unduh(id, ext, s.keu1).expect(409)).body.kode).toBe('REKAP_BELUM_DISETUJUI');
      await komponen(id, lineId, s.payabs, { kind: 'INSENTIF', name: 'B', amount: '1' }).expect(201);
      await aksi(id, 'verify', s.keu1).expect(200);
      expect((await unduh(id, 'csv', s.keu2).expect(409)).body.kode).toBe('REKAP_BELUM_DISETUJUI');
      await aksi(id, 'approve', s.dir1).expect(200);
      await unduh(id, 'csv', s.keu2).expect(200);
      await aksi(id, 'finalize', s.keu2).expect(200);
      await unduh(id, 'csv', s.keu2).expect(200);
      const v2 = (await aksi(id, 'correct', s.payabs, { reason: 'Koreksi untuk uji ekspor' }).expect(201)).body;
      await aksi(v2.id, 'verify', s.keu1).expect(200);
      await aksi(v2.id, 'approve', s.dir1).expect(200);
      expect((await unduh(id, 'csv', s.keu2).expect(409)).body.kode).toBe('REKAP_DIGANTIKAN');
      await unduh(v2.id, 'csv', s.keu2).expect(200);
      await http('get', `/payroll/recaps/${UUID_NOL}/export.csv`, s.keu1).expect(404);
      await http('get', '/payroll/recaps/bukan-uuid/export.csv', s.keu1).expect(400);
    });
  });

  describe('isi ekspor dan perlindungan formula injection', () => {
    it('CSV: BOM, kolom sementara, nominal tepat, sel berbahaya dinetralkan; tanpa kata gaji/neto/PPh/BPJS pada kolom', async () => {
      const { id } = await rekapDisetujui();
      const r = await unduh(id, 'csv', s.keu1).expect(200);
      expect(r.headers['content-type']).toMatch(/text\/csv/);
      expect(r.headers['content-disposition']).toMatch(/^attachment; filename="rekap-payroll-partner-\d{4}-03-01_\d{4}-03-31-v1\.csv"$/);
      expect(r.headers['cache-control']).toMatch(/no-store/);
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      const csv = (r.body as Buffer).toString('utf8');
      expect(csv.charCodeAt(0)).toBe(0xfeff);
      const baris = csv.slice(1).trimEnd().split('\r\n');
      expect(baris[0]).toBe('No,Nama,Sumber,Hari Hadir,Hari Tidak Hadir,Izin,Sakit,Cuti,Terlambat,Pulang Cepat,Jam Kerja,Jam Lembur,Tunjangan,Potongan,Insentif,Catatan');
      expect(baris[0]).not.toMatch(/gaji|neto|pph|bpjs|slip|total/i);
      expect(baris).toHaveLength(3);
      expect(csv).toContain(`"'=HYPERLINK(""http://jahat.invalid"",""klik"")"`); // nama berawalan =
      expect(csv).toContain(`'=catatan berbahaya`);
      expect(csv).toContain('"SINTETIS Normal, Koma"');
      const jahat = baris.find((b) => b.includes('HYPERLINK'))!;
      expect(jahat).toMatch(/,1,0,0,0,0,0,0,8\.50,0\.00,150000\.50,0\.10,0\.00,/); // hadir 1, 8,50 jam, tunjangan/potongan tepat
      const normal = baris.find((b) => b.includes('Normal'))!;
      expect(normal).toMatch(/,2\.25,0\.00,0\.00,999999999999\.99,/);
      for (const b of baris.slice(1)) expect(b.split(',')[1].replace(/^"/, '')).not.toMatch(/^[=+\-@]/);
    });

    it('xlsx: paket OOXML sah (3 lembar), nominal numerik tepat, teks berbahaya tetap STRING ber-apostrof, tanpa rumus', async () => {
      const { id } = await rekapDisetujui();
      const r = await unduh(id, 'xlsx', s.keu1).expect(200);
      expect(r.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      expect(r.headers['content-disposition']).toMatch(/\.xlsx"$/);
      const f = bacaZip(r.body as Buffer);
      expect(f['xl/workbook.xml']).toMatch(/name="Rekap".*name="Komponen".*name="Info"/);
      const rekap = f['xl/worksheets/sheet1.xml'];
      const komp = f['xl/worksheets/sheet2.xml'];
      const info = f['xl/worksheets/sheet3.xml'];
      for (const x of [rekap, komp, info]) expect(x).not.toMatch(/<f[ >]/); // tidak ada rumus
      expect(rekap).toContain('&apos;=HYPERLINK(&quot;http://jahat.invalid&quot;,&quot;klik&quot;)');
      expect(rekap).toContain('&apos;=catatan berbahaya');
      expect(rekap).toMatch(/<c r="M\d"><v>150000\.50<\/v><\/c>/); // kolom Tunjangan numerik eksak
      expect(rekap).toMatch(/<c r="O\d"><v>999999999999\.99<\/v><\/c>/);
      expect(komp).toContain('&apos;@SUM(1+1)');
      expect(komp).toContain('&apos;+cmd|x');
      expect(komp).toContain('&apos;-2+3');
      expect(info).toMatch(/Hash isi \(SHA-256\)/);
      expect(info).toMatch(/BUKAN slip gaji/);
      expect(info).toContain('<v>999999999999.99</v>'); // subtotal Insentif
    });

    it('PDF: dokumen sah, lanskap, banyak baris membentuk beberapa halaman; bukan slip', async () => {
      const i = await siapRekap('payint', { internal: true });
      const banyak = 120;
      await tenant([A], async (c) => {
        for (let n = 0; n < banyak; n++) {
          const p = (await pool.query(`INSERT INTO persons (display_name) VALUES ('SINTETIS Massal') RETURNING id`)).rows[0].id;
          await c.query(`INSERT INTO payroll_recap_lines (company_id, recap_id, person_id, worker_name, source, days_present) VALUES ($1, $2, $3, $4, 'MANUAL', 20)`, [A, i.id, p, `SINTETIS Massal ${n}`]);
        }
      });
      await aksi(i.id, 'verify', s.keu1).expect(200);
      await aksi(i.id, 'approve', s.dir1).expect(200);
      const r = await unduh(i.id, 'pdf', s.payint).expect(200);
      const pdf = await PDFDocument.load(r.body as Buffer);
      expect(pdf.getPageCount()).toBeGreaterThan(1);
      const { width, height } = pdf.getPage(0).getSize();
      expect(width).toBeGreaterThan(height);
      expect((r.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
      const csv = (await unduh(i.id, 'csv', s.payint).expect(200)).body.toString('utf8');
      expect(csv.trimEnd().split('\r\n')).toHaveLength(banyak + 1);
    });
  });

  describe('pencatatan, audit, integritas, dan isolasi', () => {
    it('setiap ekspor dicatat (format, baris, SHA-256 = isi berkas) dan diaudit tanpa nominal/nama; riwayat dapat dilihat', async () => {
      const { id } = await rekapDisetujui('DIFINALISASI');
      const r = await unduh(id, 'xlsx', s.keu1).expect(200);
      await unduh(id, 'csv', s.keu2).expect(200);
      const { createHash } = await import('node:crypto');
      const rows = (await tenant([A], (c) => c.query(`SELECT format, row_count, sha256, exported_by FROM payroll_exports WHERE recap_id = $1 ORDER BY created_at, id`, [id]))).rows;
      expect(rows.map((x) => x.format)).toEqual(['XLSX', 'CSV']);
      expect(rows[0]).toMatchObject({ row_count: 2, sha256: createHash('sha256').update(r.body as Buffer).digest('hex'), exported_by: s.keu1.userId });
      const aud = await audit('payroll.recap.exported', id);
      expect(aud).toHaveLength(2);
      expect(JSON.stringify(aud)).not.toMatch(/150000|HYPERLINK|SINTETIS|0\.10|nama/i);
      expect(aud[0].detail).toMatchObject({ format: 'XLSX', jumlahBaris: 2, versi: 1 });
      const h = (await http('get', `/payroll/recaps/${id}/exports`, s.dir1).expect(200)).body.items;
      expect(h.map((x: { format: string }) => x.format).sort()).toEqual(['CSV', 'XLSX']);
      await http('get', `/payroll/recaps/${id}/exports`, s.hrd).expect(403);
    });

    it('ekspor gagal bila isi tidak lagi sama dengan yang disetujui (hash), dan tidak tercatat', async () => {
      const { id } = await rekapDisetujui();
      await tenant([A], async (c) => {
        await c.query(`ALTER TABLE payroll_components DISABLE TRIGGER payroll_components_hanya_draft`);
        try {
          await c.query(`UPDATE payroll_components SET amount = 1 WHERE line_id IN (SELECT id FROM payroll_recap_lines WHERE recap_id = $1)`, [id]);
        } finally {
          await c.query(`ALTER TABLE payroll_components ENABLE TRIGGER payroll_components_hanya_draft`);
        }
      });
      expect((await unduh(id, 'csv', s.keu1).expect(409)).body.kode).toBe('INTEGRITAS_REKAP_GAGAL');
      expect((await tenant([A], (c) => c.query(`SELECT count(*)::int AS n FROM payroll_exports WHERE recap_id = $1`, [id]))).rows[0].n).toBe(0);
    });

    it('ISOLASI: staf B tidak dapat mengekspor atau melihat riwayat ekspor rekap A (404)', async () => {
      const { id } = await rekapDisetujui();
      for (const ext of ['csv', 'xlsx', 'pdf']) await unduh(id, ext, s.keuB).expect(404);
      await http('get', `/payroll/recaps/${id}/exports`, s.keuB).expect(404);
      expect((await tenant([A], (c) => c.query(`SELECT count(*)::int AS n FROM payroll_exports WHERE recap_id = $1`, [id]))).rows[0].n).toBe(0);
    });
  });
});
