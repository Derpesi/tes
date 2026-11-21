import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Pool } from 'pg';
import { z } from 'zod';
import { decodeKursor, encodeKursor } from '../admin/kursor';
import { AuditService } from '../audit/audit.service';
import { dekripsiNik, samarkanNik } from '../common/crypto/pii';
import { KUNCI, Kunci } from '../config/config.module';
import { POOL } from '../database/tokens';
import type { Akses } from '../rbac/akses.service';
import { MemberDocumentsService } from './member-documents.service';
import { catatStatusMember } from './member-profile.service';
import { DaftarMemberQuery, KembalikanBody } from './schemas';

const TDK_MEMBER = () => new NotFoundException({ kode: 'MEMBER_TIDAK_DITEMUKAN', message: 'Member tidak ditemukan' });
const TDK_DOKUMEN = () => new NotFoundException({ kode: 'DOKUMEN_TIDAK_DITEMUKAN', message: 'Dokumen tidak ditemukan' });
const lolosLike = (q: string) => q.replace(/[\\%_]/g, (m) => `\\${m}`);

type Baris = Record<string, unknown>;

/**
 * Database member untuk staff. Member lintas perusahaan: akses dijaga permission member.* (bukan scope perusahaan).
 * NIK selalu tersamar kecuali endpoint reveal (member.review) yang diaudit; dokumen hanya diunduh pemegang member.review dengan audit.
 */
@Injectable()
export class MembersAdminService {
  constructor(
    @Inject(POOL) private readonly pool: Pool,
    @Inject(KUNCI) private readonly kunci: Kunci,
    private readonly dokumen: MemberDocumentsService,
    private readonly audit: AuditService,
  ) {}

  private readonly log = new Logger(MembersAdminService.name);
  /** Satu baris yang tidak dapat didekripsi (kunci salah/data rusak) tidak boleh mematikan seluruh daftar; dicatat tanpa PII. */
  private nikTersamar(p: Baris): string | null {
    if (!p.nik_enc) return null;
    try {
      return samarkanNik(dekripsiNik(p.nik_enc as Buffer, this.kunci.enkripsi, p.id as string));
    } catch {
      this.log.error(`NIK profil ${String(p.id)} tidak dapat didekripsi (kunci tidak cocok atau data rusak)`);
      return null;
    }
  }
  private ringkas(p: Baris) {
    return { id: p.id, fullName: p.full_name, nik: this.nikTersamar(p), city: p.city, status: p.status, submittedAt: p.submitted_at, createdAt: p.created_at };
  }

  async daftar(q: z.infer<typeof DaftarMemberQuery>) {
    const k = decodeKursor(q.cursor);
    const r = await this.pool.query(
      `SELECT id, full_name, nik_enc, city, status, submitted_at, created_at, created_at::text AS created_at_txt FROM member_profiles
        WHERE ($1::text IS NULL OR status = $1) AND ($2::text IS NULL OR full_name ILIKE '%' || $2 || '%')
          AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::uuid))
        ORDER BY created_at DESC, id DESC LIMIT $5`,
      [q.status ?? null, q.q ? lolosLike(q.q) : null, k?.t ?? null, k?.id ?? null, q.limit + 1],
    );
    const ada = r.rows.length > q.limit;
    const baris = r.rows.slice(0, q.limit);
    return { items: baris.map((x) => this.ringkas(x)), nextCursor: ada ? encodeKursor({ t: baris[baris.length - 1].created_at_txt, id: baris[baris.length - 1].id }) : null };
  }

  /** Hitungan per status tanpa data pribadi. */
  async ringkasan() {
    const r = await this.pool.query(`SELECT status, count(*)::int AS jumlah FROM member_profiles GROUP BY status ORDER BY status`);
    return { items: r.rows.map((x) => ({ status: x.status as string, jumlah: x.jumlah as number })) };
  }

  async detail(id: string) {
    const r = await this.pool.query(`SELECT *, birth_date::text AS birth_date FROM member_profiles WHERE id = $1`, [id]);
    if (!r.rowCount) throw TDK_MEMBER();
    const p = r.rows[0];
    const dok = await this.pool.query(`SELECT id, kind, original_filename, mime_type, size_bytes, created_at FROM member_documents WHERE person_id = $1 AND status = 'AKTIF' ORDER BY created_at DESC, id DESC LIMIT 100`, [p.person_id]);
    const rw = await this.pool.query(`SELECT from_status, to_status, reason, created_at FROM member_status_histories WHERE person_id = $1 ORDER BY created_at DESC, id DESC LIMIT 100`, [p.person_id]);
    return {
      ...this.ringkas(p), birthPlace: p.birth_place, birthDate: p.birth_date, gender: p.gender, address: p.address, province: p.province, phone: p.phone, education: p.education,
      emergencyContactName: p.emergency_contact_name, emergencyContactPhone: p.emergency_contact_phone, reviewNote: p.review_note, verifiedAt: p.verified_at,
      documents: dok.rows.map((d) => ({ id: d.id, kind: d.kind, originalFilename: d.original_filename, mimeType: d.mime_type, sizeBytes: d.size_bytes, createdAt: d.created_at })),
      history: rw.rows.map((h) => ({ from: h.from_status, to: h.to_status, reason: h.reason, createdAt: h.created_at })),
    };
  }

  /** Pembukaan NIK penuh: hanya pemegang member.review, setiap akses diaudit. */
  async bukaNik(a: Akses, id: string) {
    const r = await this.pool.query(`SELECT id, nik_enc FROM member_profiles WHERE id = $1`, [id]);
    if (!r.rowCount) throw TDK_MEMBER();
    if (!r.rows[0].nik_enc) throw new NotFoundException({ kode: 'NIK_BELUM_DIISI', message: 'Member belum mengisi NIK' });
    await this.audit.catat({ aksi: 'member.nik.revealed', aktorId: a.userId, objek: 'member_profile', objekId: id });
    return { nik: dekripsiNik(r.rows[0].nik_enc, this.kunci.enkripsi, id) };
  }

  async unduhDokumen(a: Akses, id: string, docId: string) {
    const r = await this.pool.query(
      `SELECT d.object_key, d.original_filename, d.mime_type FROM member_documents d JOIN member_profiles p ON p.person_id = d.person_id
        WHERE d.id = $1 AND p.id = $2 AND d.status = 'AKTIF'`,
      [docId, id],
    );
    if (!r.rowCount) throw TDK_DOKUMEN();
    const data = await this.dokumen.bacaIsi(r.rows[0].object_key);
    await this.audit.catat({ aksi: 'member.document.downloaded_by_staff', aktorId: a.userId, objek: 'member_document', objekId: docId });
    return { data, mime: r.rows[0].mime_type as string, nama: r.rows[0].original_filename as string };
  }

  private async tahan(c: import('pg').PoolClient, id: string): Promise<Baris> {
    const r = await c.query(`SELECT id, person_id, status FROM member_profiles WHERE id = $1 FOR UPDATE`, [id]);
    if (!r.rowCount) throw TDK_MEMBER();
    if (r.rows[0].status !== 'MENUNGGU_VERIFIKASI') {
      throw new ConflictException({ kode: 'TRANSISI_TIDAK_VALID', message: `Member berstatus ${r.rows[0].status}; hanya status MENUNGGU_VERIFIKASI yang dapat diperiksa` });
    }
    return r.rows[0];
  }

  /** Mengembalikan untuk revisi; alasan wajib dan terlihat member. */
  async kembalikan(a: Akses, id: string, b: z.infer<typeof KembalikanBody>) {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const p = await this.tahan(c, id);
      const u = await c.query(`UPDATE member_profiles SET status = 'PROFIL_BELUM_LENGKAP', review_note = $2, updated_at = now() WHERE id = $1 AND status = 'MENUNGGU_VERIFIKASI'`, [id, b.reason]);
      if (!u.rowCount) throw new ConflictException({ kode: 'TRANSISI_TIDAK_VALID', message: 'Status member sudah berubah' }); // guard atomik di samping FOR UPDATE
      await catatStatusMember(c, p.person_id as string, 'MENUNGGU_VERIFIKASI', 'PROFIL_BELUM_LENGKAP', a.userId, b.reason);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
    await this.audit.catat({ aksi: 'member.profile.returned', aktorId: a.userId, objek: 'member_profile', objekId: id });
    return { status: 'PROFIL_BELUM_LENGKAP' };
  }

  /** Verifikasi HRD agar member yang kontraknya berakhir dapat melamar kembali (satu-satunya jalan kembali ke BELUM_DITEMPATKAN). */
  async aktifkanKembali(a: Akses, id: string, b: z.infer<typeof KembalikanBody>) {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const r = await c.query(`SELECT id, person_id, status FROM member_profiles WHERE id = $1 FOR UPDATE`, [id]);
      if (!r.rowCount) throw TDK_MEMBER();
      if (r.rows[0].status !== 'KONTRAK_BERAKHIR') throw new ConflictException({ kode: 'TRANSISI_TIDAK_VALID', message: `Member berstatus ${r.rows[0].status}; hanya KONTRAK_BERAKHIR yang dapat diverifikasi untuk melamar kembali` });
      const u = await c.query(`UPDATE member_profiles SET status = 'BELUM_DITEMPATKAN', updated_at = now() WHERE id = $1 AND status = 'KONTRAK_BERAKHIR'`, [id]);
      if (!u.rowCount) throw new ConflictException({ kode: 'TRANSISI_TIDAK_VALID', message: 'Status member sudah berubah' });
      await catatStatusMember(c, r.rows[0].person_id as string, 'KONTRAK_BERAKHIR', 'BELUM_DITEMPATKAN', a.userId, b.reason);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
    await this.audit.catat({ aksi: 'member.profile.reactivated', aktorId: a.userId, objek: 'member_profile', objekId: id });
    return { status: 'BELUM_DITEMPATKAN' };
  }

  /** Menyetujui: TERVERIFIKASI lalu BELUM_DITEMPATKAN (kedua langkah tercatat di riwayat). */
  async setujui(a: Akses, id: string) {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const p = await this.tahan(c, id);
      const u = await c.query(`UPDATE member_profiles SET status = 'BELUM_DITEMPATKAN', review_note = NULL, verified_by = $2, verified_at = now(), updated_at = now() WHERE id = $1 AND status = 'MENUNGGU_VERIFIKASI'`, [id, a.userId]);
      if (!u.rowCount) throw new ConflictException({ kode: 'TRANSISI_TIDAK_VALID', message: 'Status member sudah berubah' }); // guard atomik di samping FOR UPDATE
      await catatStatusMember(c, p.person_id as string, 'MENUNGGU_VERIFIKASI', 'TERVERIFIKASI', a.userId, 'Diverifikasi HRD');
      await catatStatusMember(c, p.person_id as string, 'TERVERIFIKASI', 'BELUM_DITEMPATKAN', a.userId, null);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
    await this.audit.catat({ aksi: 'member.profile.approved', aktorId: a.userId, objek: 'member_profile', objekId: id });
    return { status: 'BELUM_DITEMPATKAN' };
  }
}
