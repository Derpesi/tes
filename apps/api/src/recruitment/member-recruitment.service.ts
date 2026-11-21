import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { decodeKursor, encodeKursor } from '../admin/kursor';
import { AuditService } from '../audit/audit.service';
import { ScopedDb } from '../database/scoped-db';
import { MemberContextService } from '../member/member-context.service';
import { DaftarMemberLowonganQuery, MelamarBody } from './schemas';

const TDK_LOWONGAN = () => new NotFoundException({ kode: 'LOWONGAN_TIDAK_DITEMUKAN', message: 'Lowongan tidak ditemukan' });
const TDK_LAMARAN = () => new NotFoundException({ kode: 'LAMARAN_TIDAK_DITEMUKAN', message: 'Lamaran tidak ditemukan' });

export interface HasilCanApply { bisaMelamar: boolean; kode?: string; pesan?: string }

/**
 * CanApply: SATU-SATUNYA sumber aturan "siapa boleh melamar", dipakai backend saat melamar dan oleh endpoint eligibility.
 * Karyawan aktif (dan yang kontraknya akan berakhir) DITOLAK 403 di backend; menyembunyikan menu di UI hanya kemudahan.
 */
export function canApply(statusMember: string | undefined): HasilCanApply {
  switch (statusMember) {
    case 'TERVERIFIKASI':
    case 'BELUM_DITEMPATKAN':
      return { bisaMelamar: true };
    case 'KARYAWAN_AKTIF':
    case 'KONTRAK_AKAN_BERAKHIR':
      return { bisaMelamar: false, kode: 'KARYAWAN_AKTIF_TIDAK_DAPAT_MELAMAR', pesan: 'Karyawan aktif tidak dapat melamar lowongan baru' };
    case 'KONTRAK_BERAKHIR':
      return { bisaMelamar: false, kode: 'KONTRAK_BERAKHIR_PERLU_VERIFIKASI', pesan: 'Kontrak Anda telah berakhir. Hubungi HRD untuk verifikasi sebelum melamar kembali' };
    case 'NONAKTIF':
      return { bisaMelamar: false, kode: 'AKUN_MEMBER_NONAKTIF', pesan: 'Akun Anda nonaktif. Hubungi HRD' };
    default:
      return { bisaMelamar: false, kode: 'PROFIL_BELUM_TERVERIFIKASI', pesan: 'Lengkapi biodata dan tunggu verifikasi HRD sebelum melamar lowongan' };
  }
}

const KOLOM_PUBLIK = `v.id, v.title, v.description, v.positions, v.closes_on::text AS closes_on, v.opened_at, v.created_at, v.created_at::text AS created_at_txt, c.name AS company_name`;
type Baris = Record<string, unknown>;
const petaLowongan = (r: Baris) => ({ id: r.id, title: r.title, description: r.description, positions: r.positions, closesOn: r.closes_on, openedAt: r.opened_at, companyName: r.company_name });

/** Lowongan dan lamaran dari sisi member. Lowongan dibaca lintas perusahaan lewat kebijakan RLS member_read; lamaran dibatasi person milik sesi. */
@Injectable()
export class MemberRecruitmentService {
  constructor(
    private readonly sdb: ScopedDb,
    private readonly ctx: MemberContextService,
    private readonly audit: AuditService,
  ) {}

  private async statusMember(c: PoolClient, personId: string, kunci = false): Promise<string | undefined> {
    const r = await c.query(`SELECT status FROM member_profiles WHERE person_id = $1 ${kunci ? 'FOR SHARE' : ''}`, [personId]);
    return r.rows[0]?.status as string | undefined;
  }

  async eligibility(userId: string): Promise<HasilCanApply> {
    const personId = await this.ctx.personId(userId);
    return this.sdb.tx({ companyIds: [], memberPersonId: personId }, async (c) => canApply(await this.statusMember(c, personId)));
  }

  async daftarLowongan(q: z.infer<typeof DaftarMemberLowonganQuery>) {
    const k = decodeKursor(q.cursor);
    return this.sdb.tx({ companyIds: [], memberRead: true }, async (c) => {
      const r = await c.query(
        `SELECT ${KOLOM_PUBLIK} FROM job_vacancies v JOIN companies c ON c.id = v.company_id
          WHERE ($1::timestamptz IS NULL OR (v.created_at, v.id) < ($1::timestamptz, $2::uuid))
          ORDER BY v.created_at DESC, v.id DESC LIMIT $3`,
        [k?.t ?? null, k?.id ?? null, q.limit + 1],
      );
      const ada = r.rows.length > q.limit;
      const baris = r.rows.slice(0, q.limit);
      return { items: baris.map(petaLowongan), nextCursor: ada ? encodeKursor({ t: baris[baris.length - 1].created_at_txt, id: baris[baris.length - 1].id }) : null };
    });
  }

  async detailLowongan(id: string) {
    return this.sdb.tx({ companyIds: [], memberRead: true }, async (c) => {
      const r = await c.query(`SELECT ${KOLOM_PUBLIK} FROM job_vacancies v JOIN companies c ON c.id = v.company_id WHERE v.id = $1`, [id]);
      if (!r.rowCount) throw TDK_LOWONGAN();
      return petaLowongan(r.rows[0]);
    });
  }

  async melamar(userId: string, b: z.infer<typeof MelamarBody>) {
    const personId = await this.ctx.personId(userId);
    const hasil = await this.sdb.tx({ companyIds: [], memberRead: true, memberPersonId: personId }, async (c) => {
      // CanApply dievaluasi di transaksi yang sama (baris profil dikunci bersama) agar konsisten dengan perubahan status Fase 6.
      const izin = canApply(await this.statusMember(c, personId, true));
      if (!izin.bisaMelamar) throw new ForbiddenException({ kode: izin.kode, message: izin.pesan });
      const v = await c.query(`SELECT id, company_id FROM job_vacancies WHERE id = $1 AND status = 'DIBUKA' AND (closes_on IS NULL OR closes_on >= current_date)`, [b.vacancyId]);
      if (!v.rowCount) throw TDK_LOWONGAN();
      const companyId = v.rows[0].company_id as string;
      let id: string;
      try {
        id = (await c.query(`INSERT INTO job_applications (company_id, vacancy_id, person_id) VALUES ($1, $2, $3) RETURNING id`, [companyId, b.vacancyId, personId])).rows[0].id;
      } catch (e) {
        if ((e as { constraint?: string }).constraint === 'job_applications_satu_per_lowongan') throw new ConflictException({ kode: 'SUDAH_MELAMAR', message: 'Anda sudah melamar lowongan ini' });
        throw e;
      }
      await c.query(`INSERT INTO application_status_histories (company_id, application_id, from_status, to_status, actor_user_id, reason) VALUES ($1, $2, NULL, 'DIAJUKAN', $3, 'Diajukan member')`, [companyId, id, userId]);
      return { id, companyId };
    });
    await this.audit.catat({ aksi: 'recruitment.application.submitted', aktorId: userId, companyId: hasil.companyId, objek: 'job_application', objekId: hasil.id });
    return { id: hasil.id, status: 'DIAJUKAN' };
  }

  /** Lamaran milik sendiri. Catatan internal staff tidak ditampilkan. */
  async daftarLamaran(userId: string, q: z.infer<typeof DaftarMemberLowonganQuery>) {
    const personId = await this.ctx.personId(userId);
    const k = decodeKursor(q.cursor);
    return this.sdb.tx({ companyIds: [], memberPersonId: personId }, async (c) => {
      const r = await c.query(
        `SELECT a.id, a.status, a.created_at, a.created_at::text AS created_at_txt, a.updated_at, v.title AS vacancy_title, co.name AS company_name
           FROM job_applications a JOIN job_vacancies v ON v.id = a.vacancy_id JOIN companies co ON co.id = a.company_id
          WHERE ($1::timestamptz IS NULL OR (a.created_at, a.id) < ($1::timestamptz, $2::uuid))
          ORDER BY a.created_at DESC, a.id DESC LIMIT $3`,
        [k?.t ?? null, k?.id ?? null, q.limit + 1],
      );
      const ada = r.rows.length > q.limit;
      const baris = r.rows.slice(0, q.limit);
      return {
        items: baris.map((x) => ({ id: x.id, status: x.status, vacancyTitle: x.vacancy_title, companyName: x.company_name, createdAt: x.created_at, updatedAt: x.updated_at })),
        nextCursor: ada ? encodeKursor({ t: baris[baris.length - 1].created_at_txt, id: baris[baris.length - 1].id }) : null,
      };
    });
  }

  async tarik(userId: string, id: string) {
    const personId = await this.ctx.personId(userId);
    const companyId = await this.sdb.tx({ companyIds: [], memberPersonId: personId }, async (c) => {
      const r = await c.query(`SELECT company_id, status FROM job_applications WHERE id = $1 FOR UPDATE`, [id]); // RLS: hanya milik sendiri
      if (!r.rowCount) throw TDK_LAMARAN();
      const dari = r.rows[0].status as string;
      if (!['DIAJUKAN', 'SELEKSI_ADMINISTRASI', 'INTERVIEW'].includes(dari)) throw new ConflictException({ kode: 'TRANSISI_TIDAK_VALID', message: `Lamaran berstatus ${dari} tidak dapat ditarik` });
      const u = await c.query(`UPDATE job_applications SET status = 'DITARIK', updated_at = now() WHERE id = $1 AND status = $2`, [id, dari]);
      if (!u.rowCount) throw new ConflictException({ kode: 'TRANSISI_TIDAK_VALID', message: 'Status lamaran sudah berubah' });
      await c.query(`INSERT INTO application_status_histories (company_id, application_id, from_status, to_status, actor_user_id, reason) VALUES ($1, $2, $3, 'DITARIK', $4, 'Ditarik member')`, [r.rows[0].company_id, id, dari, userId]);
      return r.rows[0].company_id as string;
    });
    await this.audit.catat({ aksi: 'recruitment.application.withdrawn', aktorId: userId, companyId, objek: 'job_application', objekId: id });
    return { status: 'DITARIK' };
  }
}
