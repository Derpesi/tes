import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { decodeKursor, encodeKursor } from '../admin/kursor';
import { AuditService } from '../audit/audit.service';
import { dekripsiBerkas, dekripsiNik, enkripsiBerkas } from '../common/crypto/pii';
import { buatKunciObjek, OBJECT_STORAGE, ObjectStorage, ObjekTidakDitemukan } from '../common/storage/object-storage';
import { BerkasMasuk, periksaUnggahan } from '../common/storage/upload';
import { KUNCI, Kunci } from '../config/config.module';
import { ScopedDb } from '../database/scoped-db';
import type { Akses } from '../rbac/akses.service';
import { ContractLifecycleService } from './lifecycle.service';
import { NumberingService } from './numbering.service';
import { buatPdf, tanggalPanjang } from './pdf';
import { AlasanBody, DaftarKontrakQuery, KontrakBuat, KontrakUbah } from './schemas';
import { isiTemplate } from './variabel';

const TDK_KONTRAK = () => new NotFoundException({ kode: 'KONTRAK_TIDAK_DITEMUKAN', message: 'Kontrak tidak ditemukan' });
const TDK_DOKUMEN = () => new NotFoundException({ kode: 'DOKUMEN_TIDAK_DITEMUKAN', message: 'Dokumen tidak ditemukan' });
const konflik = (kode: string, message: string) => new ConflictException({ kode, message });
const SOD = (pesan: string) => new ForbiddenException({ kode: 'PEMISAHAN_TUGAS', message: pesan });
const DAPAT_DIBATALKAN = ['DRAFT', 'REVIEW', 'PERSETUJUAN', 'PENANDATANGANAN', 'MENUNGGU_VERIFIKASI_DOKUMEN'];
const DAPAT_DIKONTRAK = ['TERVERIFIKASI', 'BELUM_DITEMPATKAN'];

const KOLOM = `c.id, c.company_id, c.application_id, c.person_id, c.template_id, c.extends_contract_id, c.contract_number, c.position, c.start_date::text AS start_date, c.end_date::text AS end_date,
  c.status, c.current_version, c.created_by, c.reviewed_by, c.approved_by, c.reviewed_at, c.approved_at, c.activated_at, c.ended_at, c.created_at, c.created_at::text AS created_at_txt, c.updated_at`;
type Baris = Record<string, unknown>;
const peta = (r: Baris) => ({
  id: r.id, companyId: r.company_id, applicationId: r.application_id, templateId: r.template_id, extendsContractId: r.extends_contract_id, contractNumber: r.contract_number, position: r.position,
  startDate: r.start_date, endDate: r.end_date, status: r.status, currentVersion: r.current_version, createdBy: r.created_by, reviewedBy: r.reviewed_by, approvedBy: r.approved_by,
  reviewedAt: r.reviewed_at, approvedAt: r.approved_at, activatedAt: r.activated_at, endedAt: r.ended_at, createdAt: r.created_at, updatedAt: r.updated_at,
  applicantName: r.full_name, templateName: r.template_name, templateVersion: r.template_version,
});

/**
 * Alur PKWT: DRAFT -> REVIEW -> PERSETUJUAN -> PENANDATANGANAN -> MENUNGGU_VERIFIKASI_DOKUMEN -> DITANDATANGANI. Pembuat, pemeriksa,
 * dan penyetuju harus orang berbeda (aplikasi + database). Template harus TERVERIFIKASI sebelum PERSETUJUAN. "Setuju" di sistem BUKAN tanda tangan
 * sah: kontrak baru sah setelah scan bertanda tangan basah diverifikasi HRD (pemverifikasi ≠ pengunggah). Perubahan = versi baru (tidak menimpa).
 * Aktivasi saat tanggal mulai tiba dilakukan siklus hidup kontrak (6C). Perpanjangan = kontrak lanjutan bertaut yang melewati alur yang sama.
 */
@Injectable()
export class PkwtService {
  private readonly log = new Logger(PkwtService.name);
  constructor(
    private readonly sdb: ScopedDb,
    private readonly audit: AuditService,
    private readonly nomor: NumberingService,
    private readonly siklus: ContractLifecycleService,
    @Inject(KUNCI) private readonly kunci: Kunci,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  private tx<T>(a: Akses, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    return this.sdb.tx({ companyIds: a.companyIds }, fn);
  }

  private async muat(c: PoolClient, id: string, kunci = false): Promise<Baris> {
    const r = await c.query(`SELECT ${KOLOM}, p.full_name, t.name AS template_name, t.version AS template_version FROM employment_contracts c
        LEFT JOIN member_profiles p ON p.person_id = c.person_id LEFT JOIN contract_templates t ON t.id = c.template_id WHERE c.id = $1 ${kunci ? 'FOR UPDATE OF c' : ''}`, [id]);
    if (!r.rowCount) throw TDK_KONTRAK();
    return r.rows[0];
  }
  private async catat(c: PoolClient, k: Baris, dari: string | null, ke: string, aktor: string | null, alasan?: string | null) {
    await c.query(`INSERT INTO contract_status_histories (company_id, contract_id, from_status, to_status, actor_user_id, reason) VALUES ($1, $2, $3, $4, $5, $6)`, [k.company_id, k.id, dari, ke, aktor, alasan ?? null]);
  }
  private async versi(c: PoolClient, k: Baris, no: number, alasan: string | null, userId: string) {
    const t = await c.query(`SELECT version FROM contract_templates WHERE id = $1`, [k.template_id]);
    await c.query(
      `INSERT INTO contract_versions (company_id, contract_id, version_no, contract_number, position, start_date, end_date, template_id, template_version, variables, reason, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, '{}'::jsonb, $10, $11)`,
      [k.company_id, k.id, no, k.contract_number, k.position, k.start_date, k.end_date, k.template_id, t.rows[0].version, alasan, userId],
    );
  }
  /** Perubahan status dengan guard atomik di UPDATE (selain FOR UPDATE pada pembacaan). */
  private async pindah(c: PoolClient, k: Baris, dari: string[], ke: string, set: string, nilai: unknown[]) {
    const r = await c.query(`UPDATE employment_contracts SET status = $2, ${set}${set ? ',' : ''} updated_at = now() WHERE id = $1 AND status = ANY($${nilai.length + 3}::text[])`, [k.id, ke, ...nilai, dari]);
    if (!r.rowCount) throw konflik('TRANSISI_TIDAK_VALID', 'Status kontrak sudah berubah');
  }
  private lihatStatus(k: Baris, dari: string[], aksi: string) {
    if (!dari.includes(k.status as string)) throw konflik('TRANSISI_TIDAK_VALID', `Kontrak berstatus ${k.status} tidak dapat ${aksi}`);
  }

  // ---------- baca ----------
  async daftar(a: Akses, q: z.infer<typeof DaftarKontrakQuery>) {
    const k = decodeKursor(q.cursor);
    return this.tx(a, async (c) => {
      const r = await c.query(
        `SELECT ${KOLOM}, p.full_name, t.name AS template_name, t.version AS template_version FROM employment_contracts c
           LEFT JOIN member_profiles p ON p.person_id = c.person_id LEFT JOIN contract_templates t ON t.id = c.template_id
          WHERE ($1::text IS NULL OR c.status = $1) AND ($2::uuid IS NULL OR c.application_id = $2)
            AND ($3::timestamptz IS NULL OR (c.created_at, c.id) < ($3::timestamptz, $4::uuid))
          ORDER BY c.created_at DESC, c.id DESC LIMIT $5`,
        [q.status ?? null, q.applicationId ?? null, k?.t ?? null, k?.id ?? null, q.limit + 1],
      );
      const ada = r.rows.length > q.limit;
      const baris = r.rows.slice(0, q.limit);
      return { items: baris.map(peta), nextCursor: ada ? encodeKursor({ t: baris[baris.length - 1].created_at_txt, id: baris[baris.length - 1].id }) : null };
    });
  }

  async detail(a: Akses, id: string) {
    return this.tx(a, async (c) => {
      const k = await this.muat(c, id);
      const v = await c.query(`SELECT version_no, position, start_date::text AS start_date, end_date::text AS end_date, reason, created_at FROM contract_versions WHERE contract_id = $1 ORDER BY version_no DESC`, [id]);
      const d = await c.query(`SELECT id, version_no, original_filename, mime_type, size_bytes, status, reject_reason, created_at, verified_at FROM contract_documents WHERE contract_id = $1 ORDER BY created_at DESC, id DESC LIMIT 50`, [id]);
      const h = await c.query(`SELECT from_status, to_status, reason, created_at FROM contract_status_histories WHERE contract_id = $1 ORDER BY created_at DESC, id DESC LIMIT 100`, [id]);
      return {
        ...peta(k),
        versions: v.rows.map((x) => ({ versionNo: x.version_no, position: x.position, startDate: x.start_date, endDate: x.end_date, reason: x.reason, createdAt: x.created_at })),
        documents: d.rows.map((x) => ({ id: x.id, versionNo: x.version_no, originalFilename: x.original_filename, mimeType: x.mime_type, sizeBytes: x.size_bytes, status: x.status, rejectReason: x.reject_reason, createdAt: x.created_at, verifiedAt: x.verified_at })),
        history: h.rows.map((x) => ({ from: x.from_status, to: x.to_status, reason: x.reason, createdAt: x.created_at })),
      };
    });
  }

  // ---------- alur ----------
  async buat(a: Akses, b: z.infer<typeof KontrakBuat>) {
    const hasil = await this.tx(a, async (c) => {
      const l = await c.query(`SELECT id, company_id, person_id, status FROM job_applications WHERE id = $1 FOR SHARE`, [b.applicationId]);
      if (!l.rowCount) throw new NotFoundException({ kode: 'LAMARAN_TIDAK_DITEMUKAN', message: 'Lamaran tidak ditemukan' });
      const lam = l.rows[0];
      if (lam.status !== 'MENUNGGU_PKWT') throw konflik('LAMARAN_BELUM_DITERIMA', `Lamaran berstatus ${lam.status}; kontrak hanya dibuat untuk lamaran MENUNGGU_PKWT`);
      const t = await c.query(`SELECT status FROM contract_templates WHERE id = $1 AND company_id = $2`, [b.templateId, lam.company_id]);
      if (!t.rowCount) throw new NotFoundException({ kode: 'TEMPLATE_TIDAK_DITEMUKAN', message: 'Template tidak ditemukan' });
      if (t.rows[0].status === 'DIARSIPKAN') throw konflik('TEMPLATE_DIARSIPKAN', 'Template sudah diarsipkan');
      if (b.extendsContractId) {
        const p = await c.query(`SELECT person_id, status, end_date::text AS end_date FROM employment_contracts WHERE id = $1 AND company_id = $2`, [b.extendsContractId, lam.company_id]);
        if (!p.rowCount) throw TDK_KONTRAK();
        if (p.rows[0].person_id !== lam.person_id) throw konflik('KONTRAK_BUKAN_MILIK_PELAMAR', 'Kontrak sebelumnya bukan milik pelamar ini');
        if (!['DITANDATANGANI', 'AKTIF'].includes(p.rows[0].status)) throw konflik('KONTRAK_SEBELUMNYA_TIDAK_BERJALAN', 'Perpanjangan hanya untuk kontrak yang sudah ditandatangani/aktif');
        if (b.startDate <= p.rows[0].end_date) throw konflik('PERIODE_TUMPANG_TINDIH', 'Kontrak lanjutan harus dimulai setelah kontrak sebelumnya berakhir');
      } else {
        const m = await c.query(`SELECT status FROM member_profiles WHERE person_id = $1 FOR SHARE`, [lam.person_id]);
        if (!m.rowCount || !DAPAT_DIKONTRAK.includes(m.rows[0].status)) throw konflik('PELAMAR_TIDAK_DAPAT_DIKONTRAK', 'Status member pelamar tidak memenuhi syarat untuk dikontrak');
      }
      const no = await this.nomor.terbitkan(c, lam.company_id, Number(b.startDate.slice(0, 4)));
      let id: string;
      try {
        id = (await c.query(
          `INSERT INTO employment_contracts (company_id, application_id, person_id, template_id, extends_contract_id, contract_number, position, start_date, end_date, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
          [lam.company_id, lam.id, lam.person_id, b.templateId, b.extendsContractId ?? null, no, b.position, b.startDate, b.endDate, a.userId],
        )).rows[0].id;
      } catch (e) {
        if ((e as { constraint?: string }).constraint === 'employment_contracts_satu_per_lamaran') throw konflik('KONTRAK_SUDAH_ADA', 'Lamaran ini sudah memiliki kontrak');
        throw e;
      }
      const k = await this.muat(c, id);
      await this.versi(c, k, 1, 'Dibuat', a.userId);
      await this.catat(c, k, null, 'DRAFT', a.userId, 'Dibuat');
      return k;
    });
    await this.audit.catat({ aksi: 'pkwt.contract.created', aktorId: a.userId, companyId: hasil.company_id as string, objek: 'employment_contract', objekId: hasil.id as string });
    return peta(hasil);
  }

  /** Mengubah kontrak DRAFT: setiap perubahan = versi baru (tidak menimpa). */
  async ubah(a: Akses, id: string, b: z.infer<typeof KontrakUbah>) {
    const hasil = await this.tx(a, async (c) => {
      const k = await this.muat(c, id, true);
      this.lihatStatus(k, ['DRAFT'], 'diubah (hanya DRAFT)');
      if (b.templateId) {
        const t = await c.query(`SELECT status FROM contract_templates WHERE id = $1 AND company_id = $2`, [b.templateId, k.company_id]);
        if (!t.rowCount) throw new NotFoundException({ kode: 'TEMPLATE_TIDAK_DITEMUKAN', message: 'Template tidak ditemukan' });
        if (t.rows[0].status === 'DIARSIPKAN') throw konflik('TEMPLATE_DIARSIPKAN', 'Template sudah diarsipkan');
      }
      const mulai = b.startDate ?? (k.start_date as string);
      const akhir = b.endDate ?? (k.end_date as string);
      if (akhir < mulai) throw new BadRequestException({ kode: 'PERIODE_TIDAK_VALID', message: 'Tanggal berakhir tidak boleh sebelum tanggal mulai' });
      const no = (k.current_version as number) + 1;
      await c.query(`UPDATE employment_contracts SET template_id = COALESCE($2, template_id), position = COALESCE($3, position), start_date = $4, end_date = $5, current_version = $6, updated_at = now() WHERE id = $1 AND status = 'DRAFT'`, [id, b.templateId ?? null, b.position ?? null, mulai, akhir, no]);
      const baru = await this.muat(c, id);
      await this.versi(c, baru, no, b.reason ?? 'Diubah', a.userId);
      return baru;
    });
    await this.audit.catat({ aksi: 'pkwt.contract.updated', aktorId: a.userId, companyId: hasil.company_id as string, objek: 'employment_contract', objekId: id, detail: { bidang: Object.keys(b), versi: hasil.current_version } });
    return peta(hasil);
  }

  private async ubahStatus(a: Akses, id: string, aksi: string, fn: (c: PoolClient, k: Baris) => Promise<{ ke: string; alasan?: string | null }>, auditAksi: string) {
    const hasil = await this.tx(a, async (c) => {
      const k = await this.muat(c, id, true);
      const { ke, alasan } = await fn(c, k);
      await this.catat(c, k, k.status as string, ke, a.userId, alasan);
      return { k, ke };
    });
    await this.audit.catat({ aksi: auditAksi, aktorId: a.userId, companyId: hasil.k.company_id as string, objek: 'employment_contract', objekId: id, detail: { ke: hasil.ke } });
    return { status: hasil.ke };
  }

  ajukanReview(a: Akses, id: string) {
    return this.ubahStatus(a, id, 'diajukan', async (c, k) => {
      this.lihatStatus(k, ['DRAFT'], 'diajukan untuk review');
      await this.pindah(c, k, ['DRAFT'], 'REVIEW', '', []);
      return { ke: 'REVIEW' };
    }, 'pkwt.contract.submitted');
  }

  /** Pemeriksaan HRD: pemeriksa ≠ pembuat; template wajib terverifikasi sebelum PERSETUJUAN. */
  periksa(a: Akses, id: string) {
    return this.ubahStatus(a, id, 'diperiksa', async (c, k) => {
      this.lihatStatus(k, ['REVIEW'], 'diperiksa');
      if (k.created_by === a.userId) throw SOD('Pemeriksa tidak boleh sama dengan pembuat kontrak');
      const t = await c.query(`SELECT verified_at FROM contract_templates WHERE id = $1`, [k.template_id]);
      if (!t.rows[0]?.verified_at) throw konflik('TEMPLATE_BELUM_DIVERIFIKASI', 'Template belum diverifikasi; kontrak tidak dapat dilanjutkan ke persetujuan');
      await this.pindah(c, k, ['REVIEW'], 'PERSETUJUAN', 'reviewed_by = $3, reviewed_at = now()', [a.userId]);
      return { ke: 'PERSETUJUAN' };
    }, 'pkwt.contract.reviewed');
  }

  /** Persetujuan Direktur: penyetuju ≠ pembuat dan ≠ pemeriksa. Ini BUKAN tanda tangan: lanjut ke penandatanganan basah. */
  setujui(a: Akses, id: string) {
    return this.ubahStatus(a, id, 'disetujui', async (c, k) => {
      this.lihatStatus(k, ['PERSETUJUAN'], 'disetujui');
      if (k.created_by === a.userId || k.reviewed_by === a.userId) throw SOD('Penyetuju tidak boleh sama dengan pembuat atau pemeriksa kontrak');
      await this.pindah(c, k, ['PERSETUJUAN'], 'PENANDATANGANAN', 'approved_by = $3, approved_at = now()', [a.userId]);
      return { ke: 'PENANDATANGANAN' };
    }, 'pkwt.contract.approved');
  }

  tolakReview(a: Akses, id: string, b: z.infer<typeof AlasanBody>) {
    return this.ubahStatus(a, id, 'ditolak', async (c, k) => {
      this.lihatStatus(k, ['REVIEW'], 'dikembalikan dari review');
      await this.pindah(c, k, ['REVIEW'], 'DRAFT', '', []);
      return { ke: 'DRAFT', alasan: b.reason };
    }, 'pkwt.contract.review_rejected');
  }

  tolakPersetujuan(a: Akses, id: string, b: z.infer<typeof AlasanBody>) {
    return this.ubahStatus(a, id, 'ditolak', async (c, k) => {
      this.lihatStatus(k, ['PERSETUJUAN'], 'dikembalikan dari persetujuan');
      await this.pindah(c, k, ['PERSETUJUAN'], 'DRAFT', 'reviewed_by = NULL, reviewed_at = NULL', []);
      return { ke: 'DRAFT', alasan: b.reason };
    }, 'pkwt.contract.approval_rejected');
  }

  batalkan(a: Akses, id: string, b: z.infer<typeof AlasanBody>) {
    return this.ubahStatus(a, id, 'dibatalkan', async (c, k) => {
      this.lihatStatus(k, DAPAT_DIBATALKAN, 'dibatalkan (kontrak yang sudah ditandatangani diakhiri, bukan dibatalkan)');
      await this.pindah(c, k, DAPAT_DIBATALKAN, 'DIBATALKAN', '', []);
      return { ke: 'DIBATALKAN', alasan: b.reason };
    }, 'pkwt.contract.cancelled');
  }

  /** Memicu siklus hidup untuk satu orang; kegagalan tidak membatalkan operasi utama (worker interval menyusul). */
  async picuSiklus(personId: string): Promise<void> {
    try {
      await this.siklus.prosesOrang(personId, new Date());
    } catch (e) {
      this.log.error(`Siklus kontrak (pemicu) gagal: ${(e as Error).message}`);
    }
  }

  /** Mengakhiri kontrak AKTIF lebih awal (Direktur). Penempatan selesai dan status member menjadi KONTRAK_BERAKHIR oleh siklus. */
  async akhiri(a: Akses, id: string, b: z.infer<typeof AlasanBody>) {
    const k = await this.tx(a, async (c) => {
      const kon = await this.muat(c, id, true);
      this.lihatStatus(kon, ['AKTIF'], 'diakhiri lebih awal (hanya kontrak AKTIF)');
      await c.query(`UPDATE employment_contracts SET status = 'DIAKHIRI_LEBIH_AWAL', ended_at = now(), end_reason = $2, updated_at = now() WHERE id = $1 AND status = 'AKTIF'`, [id, b.reason]);
      await this.catat(c, kon, 'AKTIF', 'DIAKHIRI_LEBIH_AWAL', a.userId, b.reason);
      return kon;
    });
    await this.audit.catat({ aksi: 'pkwt.contract.terminated', aktorId: a.userId, companyId: k.company_id as string, objek: 'employment_contract', objekId: id });
    await this.picuSiklus(k.person_id as string);
    return { status: 'DIAKHIRI_LEBIH_AWAL' };
  }

  // ---------- PDF ----------
  /** Dibangkitkan sesuai permintaan dari data saat ini; NIK didekripsi saat itu juga dan tidak disimpan/dicatat. */
  async pdf(a: Akses, id: string): Promise<Buffer> {
    const { k, isi, perusahaan, nik, nama, terverifikasi } = await this.tx(a, async (c) => {
      const k = await this.muat(c, id);
      if (k.status === 'DIBATALKAN') throw konflik('KONTRAK_DIBATALKAN', 'Kontrak yang dibatalkan tidak dapat dicetak');
      const t = await c.query(`SELECT body, verified_at FROM contract_templates WHERE id = $1`, [k.template_id]);
      const p = await c.query(`SELECT id, full_name, nik_enc FROM member_profiles WHERE person_id = $1`, [k.person_id]);
      const co = await c.query(`SELECT name FROM companies WHERE id = $1`, [k.company_id]);
      if (!p.rowCount || !p.rows[0].full_name || !p.rows[0].nik_enc) throw konflik('DATA_PEKERJA_BELUM_LENGKAP', 'Biodata pekerja (nama/NIK) belum lengkap untuk mencetak kontrak');
      return { k, isi: t.rows[0].body as string, perusahaan: co.rows[0].name as string, nik: dekripsiNik(p.rows[0].nik_enc as Buffer, this.kunci.enkripsi, p.rows[0].id as string), nama: p.rows[0].full_name as string, terverifikasi: !!t.rows[0].verified_at };
    });
    const sah = ['PENANDATANGANAN', 'MENUNGGU_VERIFIKASI_DOKUMEN', 'DITANDATANGANI', 'AKTIF', 'BERAKHIR', 'DIAKHIRI_LEBIH_AWAL'].includes(k.status as string);
    const teks = isiTemplate(isi, {
      nama, nik, nomor: k.contract_number as string, jabatan: k.position as string, tanggal_mulai: tanggalPanjang(k.start_date as string), tanggal_akhir: tanggalPanjang(k.end_date as string),
      perusahaan, tanggal_cetak: tanggalPanjang(new Date().toISOString().slice(0, 10)),
    });
    const pdf = await buatPdf({
      judul: `Nomor: ${k.contract_number}`,
      isi: teks,
      peringatan: terverifikasi ? undefined : 'TEMPLATE BELUM DIVERIFIKASI — DRAF',
      catatanKaki: sah
        ? 'Dokumen untuk ditandatangani basah. Belum sah sebelum scan bertanda tangan diunggah dan diverifikasi HRD.'
        : 'DRAF — belum disetujui. Bukan dokumen yang sah.',
    });
    await this.audit.catat({ aksi: 'pkwt.pdf.generated', aktorId: a.userId, companyId: k.company_id as string, objek: 'employment_contract', objekId: id, detail: { versi: k.current_version } });
    return pdf;
  }

  // ---------- scan bertanda tangan ----------
  async daftarDokumen(a: Akses, id: string) {
    return this.tx(a, async (c) => {
      await this.muat(c, id);
      const d = await c.query(`SELECT id, version_no, original_filename, mime_type, size_bytes, status, reject_reason, created_at, verified_at FROM contract_documents WHERE contract_id = $1 ORDER BY created_at DESC, id DESC LIMIT 50`, [id]);
      return { items: d.rows.map((x) => ({ id: x.id, versionNo: x.version_no, originalFilename: x.original_filename, mimeType: x.mime_type, sizeBytes: x.size_bytes, status: x.status, rejectReason: x.reject_reason, createdAt: x.created_at, verifiedAt: x.verified_at })) };
    });
  }

  /** Unggah scan: hanya saat PENANDATANGANAN; isi dienkripsi; kontrak -> MENUNGGU_VERIFIKASI_DOKUMEN. */
  async unggah(a: Akses, id: string, berkas: BerkasMasuk | undefined) {
    const v = periksaUnggahan(berkas);
    const awal = await this.tx(a, async (c) => {
      const k = await this.muat(c, id);
      this.lihatStatus(k, ['PENANDATANGANAN'], 'menerima scan (hanya saat PENANDATANGANAN)');
      return k;
    });
    const kunciObjek = buatKunciObjek(awal.company_id as string);
    await this.storage.simpan(kunciObjek, enkripsiBerkas(berkas!.buffer, this.kunci.enkripsi, kunciObjek));
    try {
      const dok = await this.tx(a, async (c) => {
        const k = await this.muat(c, id, true);
        this.lihatStatus(k, ['PENANDATANGANAN'], 'menerima scan (hanya saat PENANDATANGANAN)');
        let baris: Baris;
        try {
          baris = (await c.query(
            `INSERT INTO contract_documents (company_id, contract_id, version_no, object_key, original_filename, mime_type, size_bytes, sha256, uploaded_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, version_no, original_filename, mime_type, size_bytes, status, created_at`,
            [k.company_id, id, k.current_version, kunciObjek, v.namaAsli, v.mime, v.ukuran, v.sha256, a.userId],
          )).rows[0];
        } catch (e) {
          if ((e as { constraint?: string }).constraint === 'contract_documents_satu_berjalan') throw konflik('DOKUMEN_SUDAH_ADA', 'Sudah ada scan yang menunggu verifikasi');
          throw e;
        }
        await this.pindah(c, k, ['PENANDATANGANAN'], 'MENUNGGU_VERIFIKASI_DOKUMEN', '', []);
        await this.catat(c, k, 'PENANDATANGANAN', 'MENUNGGU_VERIFIKASI_DOKUMEN', a.userId, 'Scan diunggah');
        return { baris, companyId: k.company_id as string };
      });
      await this.audit.catat({ aksi: 'pkwt.document.uploaded', aktorId: a.userId, companyId: dok.companyId, objek: 'contract_document', objekId: dok.baris.id as string, detail: { ukuran: v.ukuran } });
      return { id: dok.baris.id, versionNo: dok.baris.version_no, originalFilename: dok.baris.original_filename, mimeType: dok.baris.mime_type, sizeBytes: dok.baris.size_bytes, status: dok.baris.status };
    } catch (e) {
      await this.storage.hapus(kunciObjek).catch((x) => this.log.error(`Gagal membersihkan objek yatim: ${(x as Error).name}`));
      throw e;
    }
  }

  async unduhDokumen(a: Akses, id: string, docId: string) {
    const d = await this.tx(a, async (c) => {
      const r = await c.query(`SELECT company_id, object_key, original_filename, mime_type FROM contract_documents WHERE id = $1 AND contract_id = $2`, [docId, id]);
      return r.rows[0] as { company_id: string; object_key: string; original_filename: string; mime_type: string } | undefined;
    });
    if (!d) throw TDK_DOKUMEN();
    let data: Buffer;
    try {
      data = dekripsiBerkas(await this.storage.baca(d.object_key), this.kunci.enkripsi, d.object_key);
    } catch (e) {
      if (e instanceof ObjekTidakDitemukan) throw TDK_DOKUMEN();
      throw e;
    }
    await this.audit.catat({ aksi: 'pkwt.document.downloaded', aktorId: a.userId, companyId: d.company_id, objek: 'contract_document', objekId: docId });
    return { data, mime: d.mime_type, nama: d.original_filename };
  }

  /** HRD memverifikasi scan (pemverifikasi ≠ pengunggah) -> kontrak DITANDATANGANI. Aktivasi menunggu tanggal mulai (siklus hidup). */
  async verifikasiDokumen(a: Akses, id: string, docId: string) {
    const k = await this.tx(a, async (c) => {
      const kon = await this.muat(c, id, true);
      this.lihatStatus(kon, ['MENUNGGU_VERIFIKASI_DOKUMEN'], 'menerima verifikasi dokumen');
      const d = await c.query(`SELECT uploaded_by, status FROM contract_documents WHERE id = $1 AND contract_id = $2 FOR UPDATE`, [docId, id]);
      if (!d.rowCount) throw TDK_DOKUMEN();
      if (d.rows[0].status !== 'MENUNGGU_VERIFIKASI') throw konflik('DOKUMEN_SUDAH_DIPUTUSKAN', `Dokumen sudah berstatus ${d.rows[0].status}`);
      if (d.rows[0].uploaded_by === a.userId) throw SOD('Pemverifikasi tidak boleh sama dengan pengunggah scan');
      await c.query(`UPDATE contract_documents SET status = 'TERVERIFIKASI', verified_by = $2, verified_at = now() WHERE id = $1 AND status = 'MENUNGGU_VERIFIKASI'`, [docId, a.userId]);
      await this.pindah(c, kon, ['MENUNGGU_VERIFIKASI_DOKUMEN'], 'DITANDATANGANI', '', []);
      await this.catat(c, kon, 'MENUNGGU_VERIFIKASI_DOKUMEN', 'DITANDATANGANI', a.userId, 'Scan bertanda tangan diverifikasi HRD');
      return kon;
    });
    await this.audit.catat({ aksi: 'pkwt.document.verified', aktorId: a.userId, companyId: k.company_id as string, objek: 'contract_document', objekId: docId });
    await this.picuSiklus(k.person_id as string); // bila tanggal mulai sudah tiba, kontrak langsung AKTIF
    return { status: 'DITANDATANGANI' };
  }

  /** Menolak scan dengan alasan -> kontrak kembali PENANDATANGANAN untuk diunggah ulang. */
  async tolakDokumen(a: Akses, id: string, docId: string, b: z.infer<typeof AlasanBody>) {
    const k = await this.tx(a, async (c) => {
      const kon = await this.muat(c, id, true);
      this.lihatStatus(kon, ['MENUNGGU_VERIFIKASI_DOKUMEN'], 'menolak dokumen');
      const d = await c.query(`SELECT uploaded_by, status FROM contract_documents WHERE id = $1 AND contract_id = $2 FOR UPDATE`, [docId, id]);
      if (!d.rowCount) throw TDK_DOKUMEN();
      if (d.rows[0].status !== 'MENUNGGU_VERIFIKASI') throw konflik('DOKUMEN_SUDAH_DIPUTUSKAN', `Dokumen sudah berstatus ${d.rows[0].status}`);
      if (d.rows[0].uploaded_by === a.userId) throw SOD('Pemverifikasi tidak boleh sama dengan pengunggah scan');
      await c.query(`UPDATE contract_documents SET status = 'DITOLAK', verified_by = $2, verified_at = now(), reject_reason = $3 WHERE id = $1 AND status = 'MENUNGGU_VERIFIKASI'`, [docId, a.userId, b.reason]);
      await this.pindah(c, kon, ['MENUNGGU_VERIFIKASI_DOKUMEN'], 'PENANDATANGANAN', '', []);
      await this.catat(c, kon, 'MENUNGGU_VERIFIKASI_DOKUMEN', 'PENANDATANGANAN', a.userId, `Scan ditolak: ${b.reason}`);
      return kon;
    });
    await this.audit.catat({ aksi: 'pkwt.document.rejected', aktorId: a.userId, companyId: k.company_id as string, objek: 'contract_document', objekId: docId });
    return { status: 'PENANDATANGANAN' };
  }
}
