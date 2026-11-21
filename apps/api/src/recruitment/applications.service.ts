import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { decodeKursor, encodeKursor } from '../admin/kursor';
import { AuditService } from '../audit/audit.service';
import { ScopedDb } from '../database/scoped-db';
import type { Akses } from '../rbac/akses.service';
import { DaftarLamaranQuery, TahapBody, TerimaBody, TolakBody } from './schemas';

const TDK_LAMARAN = () => new NotFoundException({ kode: 'LAMARAN_TIDAK_DITEMUKAN', message: 'Lamaran tidak ditemukan' });
const konflik = (kode: string, message: string) => new ConflictException({ kode, message });
const TAHAP_DARI: Record<string, string> = { SELEKSI_ADMINISTRASI: 'DIAJUKAN', INTERVIEW: 'SELEKSI_ADMINISTRASI' };
const AKTIF = ['DIAJUKAN', 'SELEKSI_ADMINISTRASI', 'INTERVIEW'];
/** Status member yang boleh diterima menjadi pegawai kontrak: bukan karyawan aktif/nonaktif. */
const BOLEH_DITERIMA = ['TERVERIFIKASI', 'BELUM_DITEMPATKAN'];
type Baris = Record<string, unknown>;

/**
 * Seleksi lamaran oleh staff dalam scope perusahaan (RLS tenant). Pindah tahap/tolak = vacancy_application.review;
 * keputusan diterima = vacancy_application.approve. Akhir Fase 5 = MENUNGGU_PKWT (PKWT dan penempatan di Fase 6).
 */
@Injectable()
export class ApplicationsService {
  constructor(
    private readonly sdb: ScopedDb,
    private readonly audit: AuditService,
  ) {}

  private tx<T>(a: Akses, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    return this.sdb.tx({ companyIds: a.companyIds }, fn);
  }

  private ringkas(r: Baris) {
    return {
      id: r.id, vacancyId: r.vacancy_id, vacancyTitle: r.vacancy_title, companyId: r.company_id, status: r.status, applicantName: r.full_name, createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  async daftar(a: Akses, q: z.infer<typeof DaftarLamaranQuery>) {
    const k = decodeKursor(q.cursor);
    return this.tx(a, async (c) => {
      const r = await c.query(
        `SELECT a.id, a.vacancy_id, a.company_id, a.status, a.created_at, a.created_at::text AS created_at_txt, a.updated_at, v.title AS vacancy_title, p.full_name
           FROM job_applications a JOIN job_vacancies v ON v.id = a.vacancy_id LEFT JOIN member_profiles p ON p.person_id = a.person_id
          WHERE ($1::uuid IS NULL OR a.vacancy_id = $1) AND ($2::text IS NULL OR a.status = $2)
            AND ($3::timestamptz IS NULL OR (a.created_at, a.id) < ($3::timestamptz, $4::uuid))
          ORDER BY a.created_at DESC, a.id DESC LIMIT $5`,
        [q.vacancyId ?? null, q.status ?? null, k?.t ?? null, k?.id ?? null, q.limit + 1],
      );
      const ada = r.rows.length > q.limit;
      const baris = r.rows.slice(0, q.limit);
      return { items: baris.map((x) => this.ringkas(x)), nextCursor: ada ? encodeKursor({ t: baris[baris.length - 1].created_at_txt, id: baris[baris.length - 1].id }) : null };
    });
  }

  /** Profil ringkas pelamar TANPA NIK dan tanpa kontak (kontak lewat database member oleh pemegang izinnya). */
  async detail(a: Akses, id: string) {
    return this.tx(a, async (c) => {
      const r = await c.query(
        `SELECT a.id, a.vacancy_id, a.company_id, a.status, a.note, a.created_at, a.updated_at, v.title AS vacancy_title, p.full_name, p.city, p.province, p.education, p.status AS member_status
           FROM job_applications a JOIN job_vacancies v ON v.id = a.vacancy_id LEFT JOIN member_profiles p ON p.person_id = a.person_id WHERE a.id = $1`,
        [id],
      );
      if (!r.rowCount) throw TDK_LAMARAN();
      const x = r.rows[0];
      const h = await c.query(`SELECT from_status, to_status, reason, created_at FROM application_status_histories WHERE application_id = $1 ORDER BY created_at DESC, id DESC LIMIT 100`, [id]);
      return {
        ...this.ringkas(x), note: x.note, applicant: { fullName: x.full_name, city: x.city, province: x.province, education: x.education, memberStatus: x.member_status },
        history: h.rows.map((y) => ({ from: y.from_status, to: y.to_status, reason: y.reason, createdAt: y.created_at })),
      };
    });
  }

  private async tahan(c: PoolClient, id: string): Promise<Baris> {
    const r = await c.query(`SELECT id, company_id, person_id, status FROM job_applications WHERE id = $1 FOR UPDATE`, [id]);
    if (!r.rowCount) throw TDK_LAMARAN();
    return r.rows[0];
  }
  private async ubahStatus(c: PoolClient, a: Akses, l: Baris, ke: string, alasan: string | null, putusan = false) {
    const u = await c.query(
      `UPDATE job_applications SET status = $3, note = COALESCE($4, note), decided_by = CASE WHEN $5 THEN $6::uuid ELSE decided_by END, decided_at = CASE WHEN $5 THEN now() ELSE decided_at END, updated_at = now()
        WHERE id = $1 AND status = $2`,
      [l.id, l.status, ke, alasan, putusan, a.userId],
    );
    if (!u.rowCount) throw konflik('TRANSISI_TIDAK_VALID', 'Status lamaran sudah berubah'); // guard atomik di samping FOR UPDATE
    await c.query(`INSERT INTO application_status_histories (company_id, application_id, from_status, to_status, actor_user_id, reason) VALUES ($1, $2, $3, $4, $5, $6)`, [l.company_id, l.id, l.status, ke, a.userId, alasan]);
    l.status = ke;
  }

  /** DIAJUKAN -> SELEKSI_ADMINISTRASI -> INTERVIEW. */
  async tahap(a: Akses, id: string, b: z.infer<typeof TahapBody>) {
    const l = await this.tx(a, async (c) => {
      const cur = await this.tahan(c, id);
      if (cur.status !== TAHAP_DARI[b.status]) throw konflik('TRANSISI_TIDAK_VALID', `Lamaran berstatus ${cur.status} tidak dapat dipindahkan ke ${b.status}`);
      await this.ubahStatus(c, a, cur, b.status, b.note ?? null);
      return cur;
    });
    await this.audit.catat({ aksi: 'recruitment.application.stage_changed', aktorId: a.userId, companyId: l.company_id as string, objek: 'job_application', objekId: id, detail: { ke: b.status } });
    return { status: b.status };
  }

  /** INTERVIEW -> DITERIMA -> MENUNGGU_PKWT (keduanya tercatat). Pelamar yang sudah karyawan aktif tidak dapat diterima. */
  async terima(a: Akses, id: string, b: z.infer<typeof TerimaBody>) {
    const l = await this.tx(a, async (c) => {
      const cur = await this.tahan(c, id);
      if (cur.status !== 'INTERVIEW') throw konflik('TRANSISI_TIDAK_VALID', `Lamaran berstatus ${cur.status} tidak dapat diterima; selesaikan tahap interview terlebih dahulu`);
      const m = await c.query(`SELECT status FROM member_profiles WHERE person_id = $1 FOR SHARE`, [cur.person_id]);
      if (!m.rowCount || !BOLEH_DITERIMA.includes(m.rows[0].status)) throw konflik('PELAMAR_TIDAK_DAPAT_DITERIMA', 'Status member pelamar tidak memenuhi syarat untuk diterima');
      await this.ubahStatus(c, a, cur, 'DITERIMA', b.note ?? null, true);
      await this.ubahStatus(c, a, cur, 'MENUNGGU_PKWT', null);
      return cur;
    });
    await this.audit.catat({ aksi: 'recruitment.application.accepted', aktorId: a.userId, companyId: l.company_id as string, objek: 'job_application', objekId: id });
    return { status: 'MENUNGGU_PKWT' };
  }

  async tolak(a: Akses, id: string, b: z.infer<typeof TolakBody>) {
    const l = await this.tx(a, async (c) => {
      const cur = await this.tahan(c, id);
      if (!AKTIF.includes(cur.status as string)) throw konflik('TRANSISI_TIDAK_VALID', `Lamaran berstatus ${cur.status} tidak dapat ditolak`);
      await this.ubahStatus(c, a, cur, 'DITOLAK', b.reason, true);
      return cur;
    });
    await this.audit.catat({ aksi: 'recruitment.application.rejected', aktorId: a.userId, companyId: l.company_id as string, objek: 'job_application', objekId: id });
    return { status: 'DITOLAK' };
  }
}
