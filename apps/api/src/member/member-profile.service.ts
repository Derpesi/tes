import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { dekripsiNik, enkripsiNik, blindIndexNik, samarkanNik, VERSI_KUNCI_PII } from '../common/crypto/pii';
import { KUNCI, Kunci } from '../config/config.module';
import { POOL } from '../database/tokens';
import { MemberContextService } from './member-context.service';
import { BiodataSimpan } from './schemas';

/** Status yang masih boleh diubah member. Setelah terverifikasi, perubahan biodata lewat HRD. */
const DAPAT_DIUBAH = ['TERDAFTAR', 'PROFIL_BELUM_LENGKAP', 'MENUNGGU_VERIFIKASI'];
const WAJIB: [string, string][] = [
  ['full_name', 'Nama lengkap'], ['nik_enc', 'NIK'], ['birth_place', 'Tempat lahir'], ['birth_date', 'Tanggal lahir'], ['gender', 'Jenis kelamin'],
  ['address', 'Alamat'], ['city', 'Kota'], ['province', 'Provinsi'], ['phone', 'Nomor telepon'], ['education', 'Pendidikan terakhir'],
  ['emergency_contact_name', 'Nama kontak darurat'], ['emergency_contact_phone', 'Telepon kontak darurat'],
];

type Baris = Record<string, unknown>;

/** Mencatat perubahan status member (hanya-tambah) di transaksi yang sama dengan perubahannya. */
export async function catatStatusMember(c: PoolClient, personId: string, dari: string | null, ke: string, aktorId: string, alasan?: string | null) {
  await c.query(`INSERT INTO member_status_histories (person_id, from_status, to_status, actor_user_id, reason) VALUES ($1, $2, $3, $4, $5)`, [personId, dari, ke, aktorId, alasan ?? null]);
}

@Injectable()
export class MemberProfileService {
  constructor(
    @Inject(POOL) private readonly pool: Pool,
    @Inject(KUNCI) private readonly kunci: Kunci,
    private readonly ctx: MemberContextService,
    private readonly audit: AuditService,
  ) {}

  /** Baris profil milik person (dibuat malas pada akses pertama), dikunci untuk perubahan. */
  async kunciProfil(c: PoolClient, personId: string): Promise<Baris> {
    await c.query(`INSERT INTO member_profiles (person_id) VALUES ($1) ON CONFLICT (person_id) DO NOTHING`, [personId]);
    return (await c.query(`SELECT * FROM member_profiles WHERE person_id = $1 FOR UPDATE`, [personId])).rows[0];
  }

  /**
   * Menyiapkan profil untuk diubah member: TERDAFTAR -> PROFIL_BELUM_LENGKAP; perubahan saat MENUNGGU_VERIFIKASI
   * mengembalikan status ke PROFIL_BELUM_LENGKAP; status terverifikasi ke atas terkunci.
   */
  async bukaUntukUbah(c: PoolClient, personId: string, userId: string): Promise<Baris> {
    const p = await this.kunciProfil(c, personId);
    const status = p.status as string;
    if (!DAPAT_DIUBAH.includes(status)) throw new ConflictException({ kode: 'PROFIL_TERKUNCI', message: 'Profil sudah terverifikasi. Hubungi HRD untuk mengubah data' });
    if (status !== 'PROFIL_BELUM_LENGKAP') {
      await c.query(`UPDATE member_profiles SET status = 'PROFIL_BELUM_LENGKAP', updated_at = now() WHERE person_id = $1`, [personId]);
      await catatStatusMember(c, personId, status, 'PROFIL_BELUM_LENGKAP', userId, status === 'MENUNGGU_VERIFIKASI' ? 'Diubah member saat menunggu verifikasi' : 'Mulai mengisi biodata');
      p.status = 'PROFIL_BELUM_LENGKAP';
    }
    return p;
  }

  private dto(p: Baris, kunciNik: string | null) {
    return {
      status: p.status, fullName: p.full_name, nik: kunciNik, birthPlace: p.birth_place, birthDate: p.birth_date, gender: p.gender, address: p.address, city: p.city,
      province: p.province, phone: p.phone, education: p.education, emergencyContactName: p.emergency_contact_name, emergencyContactPhone: p.emergency_contact_phone,
      reviewNote: p.review_note, submittedAt: p.submitted_at, verifiedAt: p.verified_at,
    };
  }
  private nikTersamar(p: Baris): string | null {
    if (!p.nik_enc) return null;
    return samarkanNik(dekripsiNik(p.nik_enc as Buffer, this.kunci.enkripsi, p.id as string));
  }

  async profil(userId: string) {
    const personId = await this.ctx.personId(userId);
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`INSERT INTO member_profiles (person_id) VALUES ($1) ON CONFLICT (person_id) DO NOTHING`, [personId]);
      const p = (await c.query(`SELECT *, birth_date::text AS birth_date FROM member_profiles WHERE person_id = $1`, [personId])).rows[0];
      await c.query('COMMIT');
      return this.dto(p, this.nikTersamar(p));
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }

  async simpan(userId: string, b: z.infer<typeof BiodataSimpan>) {
    const personId = await this.ctx.personId(userId);
    const kolom: Record<string, string> = { fullName: 'full_name', birthPlace: 'birth_place', birthDate: 'birth_date', gender: 'gender', address: 'address', city: 'city', province: 'province', phone: 'phone', education: 'education', emergencyContactName: 'emergency_contact_name', emergencyContactPhone: 'emergency_contact_phone' };
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const p = await this.bukaUntukUbah(c, personId, userId);
      const sets: string[] = [];
      const nilai: unknown[] = [personId];
      for (const [k, kol] of Object.entries(kolom)) {
        const v = (b as Record<string, unknown>)[k];
        if (v !== undefined) {
          nilai.push(v);
          sets.push(`${kol} = $${nilai.length}`);
        }
      }
      if (b.nik !== undefined) {
        nilai.push(enkripsiNik(b.nik, this.kunci.enkripsi, p.id as string), blindIndexNik(this.kunci.hmac, b.nik), VERSI_KUNCI_PII);
        sets.push(`nik_enc = $${nilai.length - 2}`, `nik_hmac = $${nilai.length - 1}`, `key_version = $${nilai.length}`);
      }
      try {
        await c.query(`UPDATE member_profiles SET ${sets.join(', ')}, updated_at = now() WHERE person_id = $1`, nilai);
      } catch (e) {
        // Pesan sengaja generik: tidak membocorkan apakah NIK dimiliki akun lain.
        if ((e as { constraint?: string }).constraint === 'member_profiles_nik_hmac_key') {
          throw new ConflictException({ kode: 'NIK_TIDAK_DAPAT_DIGUNAKAN', message: 'NIK tidak dapat digunakan. Hubungi HRD jika Anda merasa ini keliru' });
        }
        throw e;
      }
      const baru = (await c.query(`SELECT *, birth_date::text AS birth_date FROM member_profiles WHERE person_id = $1`, [personId])).rows[0];
      await c.query('COMMIT');
      await this.audit.catat({ aksi: 'member.profile.updated', aktorId: userId, objek: 'member_profile', objekId: baru.id, detail: { bidang: Object.keys(b) } });
      return this.dto(baru, this.nikTersamar(baru));
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }

  /** Mengajukan verifikasi: kelengkapan biodata + KTP diperiksa backend. */
  async ajukan(userId: string) {
    const personId = await this.ctx.personId(userId);
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const p = await this.kunciProfil(c, personId);
      if (p.status !== 'PROFIL_BELUM_LENGKAP') {
        throw new ConflictException({ kode: 'TRANSISI_TIDAK_VALID', message: p.status === 'MENUNGGU_VERIFIKASI' ? 'Profil sudah diajukan dan menunggu verifikasi' : 'Profil tidak dapat diajukan pada status ini' });
      }
      const kurang = WAJIB.filter(([kol]) => p[kol] === null || p[kol] === undefined).map(([, label]) => label);
      const ktp = await c.query(`SELECT 1 FROM member_documents WHERE person_id = $1 AND kind = 'KTP' AND status = 'AKTIF'`, [personId]);
      if (!ktp.rowCount) kurang.push('Dokumen KTP');
      if (kurang.length) throw new BadRequestException({ kode: 'PROFIL_BELUM_LENGKAP', message: `Lengkapi data berikut sebelum mengajukan: ${kurang.join(', ')}` });
      await c.query(`UPDATE member_profiles SET status = 'MENUNGGU_VERIFIKASI', submitted_at = now(), review_note = NULL, updated_at = now() WHERE person_id = $1`, [personId]);
      await catatStatusMember(c, personId, 'PROFIL_BELUM_LENGKAP', 'MENUNGGU_VERIFIKASI', userId, 'Diajukan member');
      await c.query('COMMIT');
      await this.audit.catat({ aksi: 'member.profile.submitted', aktorId: userId, objek: 'member_profile', objekId: p.id as string });
      return { status: 'MENUNGGU_VERIFIKASI' };
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }

  async riwayat(userId: string) {
    const personId = await this.ctx.personId(userId);
    const r = await this.pool.query(`SELECT from_status, to_status, reason, created_at FROM member_status_histories WHERE person_id = $1 ORDER BY created_at DESC, id DESC LIMIT 100`, [personId]);
    return { items: r.rows.map((x) => ({ from: x.from_status, to: x.to_status, reason: x.reason, createdAt: x.created_at })) };
  }
}
