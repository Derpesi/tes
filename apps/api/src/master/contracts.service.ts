import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { decodeKursor, encodeKursor } from '../admin/kursor';
import { AuditService } from '../audit/audit.service';
import { buatKunciObjek, OBJECT_STORAGE, ObjectStorage, ObjekTidakDitemukan } from '../common/storage/object-storage';
import { BerkasMasuk, periksaUnggahan } from '../common/storage/upload';
import { ScopedDb } from '../database/scoped-db';
import type { Akses } from '../rbac/akses.service';
import { KontrakBuat, KontrakUbah, LampiranKontrakBody } from './schemas';

const TDK_KONTRAK = () => new NotFoundException({ kode: 'KONTRAK_TIDAK_DITEMUKAN', message: 'Kontrak tidak ditemukan' });
const TDK_LAMPIRAN = () => new NotFoundException({ kode: 'LAMPIRAN_TIDAK_DITEMUKAN', message: 'Lampiran tidak ditemukan' });
const konflik = (kode: string, message: string) => new ConflictException({ kode, message });
const NOMOR_SUDAH_ADA = () => konflik('NOMOR_KONTRAK_SUDAH_ADA', 'Nomor kontrak sudah dipakai di perusahaan ini');

const KOLOM = `id, company_id, partner_id, contract_number, service_type, start_date::text AS start_date, end_date::text AS end_date, status, notes,
  created_by, approved_by, approved_at, ended_at, created_at, created_at::text AS created_at_txt, updated_at`;
type Baris = Record<string, unknown>;
const peta = (r: Baris) => ({
  id: r.id, companyId: r.company_id, partnerId: r.partner_id, contractNumber: r.contract_number, serviceType: r.service_type, startDate: r.start_date, endDate: r.end_date,
  status: r.status, notes: r.notes, createdBy: r.created_by, approvedBy: r.approved_by, approvedAt: r.approved_at, endedAt: r.ended_at, createdAt: r.created_at, updatedAt: r.updated_at,
});

/**
 * Kontrak layanan rekanan. State machine: DRAFT -> AKTIF -> BERAKHIR, DRAFT -> DIBATALKAN. Transisi lain ditolak (409).
 * Aktivasi dan pengakhiran hanya oleh pemegang partner_contract.approve (Direktur); penyetuju tidak boleh pembuat
 * (ditegakkan aplikasi DAN constraint database). Isi kontrak hanya dapat diubah saat DRAFT; setelah aktif tidak diam-diam berubah.
 * Perubahan pasca-aktif lewat versi/adendum ditunda ke Fase 6 (keputusan D-26); lampiran (mis. salinan bertanda tangan basah) tetap dapat ditambahkan.
 * Teks/klausul hukum kontrak TIDAK dibuat sistem: template resmi menyusul.
 */
@Injectable()
export class ContractsService {
  private readonly log = new Logger(ContractsService.name);
  constructor(
    private readonly sdb: ScopedDb,
    private readonly audit: AuditService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  private tx<T>(a: Akses, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    return this.sdb.tx({ companyIds: a.companyIds }, fn);
  }

  async daftar(a: Akses, q: { partnerId?: string; status?: string; cursor?: string; limit: number }) {
    const k = decodeKursor(q.cursor);
    return this.tx(a, async (c) => {
      const r = await c.query(
        `SELECT ${KOLOM} FROM partner_contracts
          WHERE ($1::uuid IS NULL OR partner_id = $1) AND ($2::text IS NULL OR status = $2)
            AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::uuid))
          ORDER BY created_at DESC, id DESC LIMIT $5`,
        [q.partnerId ?? null, q.status ?? null, k?.t ?? null, k?.id ?? null, q.limit + 1],
      );
      const ada = r.rows.length > q.limit;
      const baris = r.rows.slice(0, q.limit);
      return { items: baris.map(peta), nextCursor: ada ? encodeKursor({ t: baris[baris.length - 1].created_at_txt, id: baris[baris.length - 1].id }) : null };
    });
  }

  async detail(a: Akses, id: string) {
    return this.tx(a, async (c) => {
      const r = await c.query(`SELECT ${KOLOM} FROM partner_contracts WHERE id = $1`, [id]);
      if (!r.rowCount) throw TDK_KONTRAK();
      return peta(r.rows[0]);
    });
  }

  async buat(a: Akses, b: z.infer<typeof KontrakBuat>) {
    const hasil = await this.tx(a, async (c) => {
      // company_id diturunkan dari rekanan yang terlihat (RLS), bukan dari input.
      const p = await c.query(`SELECT company_id, status FROM partners WHERE id = $1`, [b.partnerId]);
      if (!p.rowCount) throw new NotFoundException({ kode: 'REKANAN_TIDAK_DITEMUKAN', message: 'Rekanan tidak ditemukan' });
      if (p.rows[0].status !== 'AKTIF') throw konflik('INDUK_NONAKTIF', 'Rekanan sudah nonaktif');
      try {
        const r = await c.query(
          `INSERT INTO partner_contracts (company_id, partner_id, contract_number, service_type, start_date, end_date, notes, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${KOLOM}`,
          [p.rows[0].company_id, b.partnerId, b.contractNumber, b.serviceType, b.startDate, b.endDate, b.notes ?? null, a.userId],
        );
        return r.rows[0];
      } catch (e) {
        if ((e as { constraint?: string }).constraint === 'partner_contracts_nomor_unik') throw NOMOR_SUDAH_ADA();
        throw e;
      }
    });
    await this.audit.catat({ aksi: 'master.partner_contract.created', aktorId: a.userId, companyId: hasil.company_id, objek: 'partner_contract', objekId: hasil.id });
    return peta(hasil);
  }

  async ubah(a: Akses, id: string, b: z.infer<typeof KontrakUbah>) {
    const kolom: Record<string, string> = { contractNumber: 'contract_number', serviceType: 'service_type', startDate: 'start_date', endDate: 'end_date', notes: 'notes' };
    const sets: string[] = [];
    const nilai: unknown[] = [id];
    for (const [k, kol] of Object.entries(kolom)) {
      if (k in b) {
        nilai.push((b as Record<string, unknown>)[k] ?? null);
        sets.push(`${kol} = $${nilai.length}`);
      }
    }
    const hasil = await this.tx(a, async (c) => {
      try {
        const r = await c.query(`UPDATE partner_contracts SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 AND status = 'DRAFT' RETURNING ${KOLOM}`, nilai);
        if (r.rowCount) return r.rows[0];
      } catch (e) {
        const k = (e as { constraint?: string }).constraint;
        if (k === 'partner_contracts_nomor_unik') throw NOMOR_SUDAH_ADA();
        if (k === 'partner_contracts_periode') throw new BadRequestException({ kode: 'PERIODE_TIDAK_VALID', message: 'Tanggal berakhir tidak boleh sebelum tanggal mulai' });
        throw e;
      }
      await this.pastikanAda(c, id);
      throw konflik('KONTRAK_TIDAK_DAPAT_DIUBAH', 'Isi kontrak hanya dapat diubah selama berstatus DRAFT');
    });
    await this.audit.catat({ aksi: 'master.partner_contract.updated', aktorId: a.userId, companyId: hasil.company_id, objek: 'partner_contract', objekId: id, detail: { bidang: Object.keys(b) } });
    return peta(hasil);
  }

  private async pastikanAda(c: PoolClient, id: string): Promise<string> {
    const r = await c.query(`SELECT status FROM partner_contracts WHERE id = $1`, [id]);
    if (!r.rowCount) throw TDK_KONTRAK();
    return r.rows[0].status as string;
  }

  /** Aktivasi oleh pemegang izin approve; penyetuju tidak boleh pembuat (pemisahan tugas). */
  async aktifkan(a: Akses, id: string) {
    const hasil = await this.tx(a, async (c) => {
      const cur = await c.query(`SELECT status, created_by, partner_id FROM partner_contracts WHERE id = $1 FOR UPDATE`, [id]);
      if (!cur.rowCount) throw TDK_KONTRAK();
      if (cur.rows[0].status !== 'DRAFT') throw konflik('TRANSISI_TIDAK_VALID', `Kontrak berstatus ${cur.rows[0].status} tidak dapat diaktifkan`);
      if (cur.rows[0].created_by === a.userId) throw new ForbiddenException({ kode: 'PEMISAHAN_TUGAS', message: 'Penyetuju tidak boleh sama dengan pembuat kontrak' });
      const p = await c.query(`SELECT status FROM partners WHERE id = $1`, [cur.rows[0].partner_id]);
      if (p.rows[0]?.status !== 'AKTIF') throw konflik('INDUK_NONAKTIF', 'Rekanan sudah nonaktif');
      // Guard atomik pada UPDATE itu sendiri (selain FOR UPDATE): tidak pernah menimpa persetujuan yang sudah ada.
      const r = await c.query(`UPDATE partner_contracts SET status = 'AKTIF', approved_by = $2, approved_at = now(), updated_at = now() WHERE id = $1 AND status = 'DRAFT' RETURNING ${KOLOM}`, [id, a.userId]);
      if (!r.rowCount) throw konflik('TRANSISI_TIDAK_VALID', 'Kontrak sudah tidak berstatus DRAFT');
      return r.rows[0];
    });
    await this.audit.catat({ aksi: 'master.partner_contract.activated', aktorId: a.userId, companyId: hasil.company_id, objek: 'partner_contract', objekId: id });
    return peta(hasil);
  }

  async akhiri(a: Akses, id: string) {
    return this.transisi(a, id, 'AKTIF', `status = 'BERAKHIR', ended_at = now()`, 'master.partner_contract.ended');
  }

  /** Pembatalan hanya untuk DRAFT; kontrak aktif harus diakhiri (riwayat tidak dihapus). */
  async batalkan(a: Akses, id: string) {
    return this.transisi(a, id, 'DRAFT', `status = 'DIBATALKAN'`, 'master.partner_contract.cancelled');
  }

  private async transisi(a: Akses, id: string, dari: string, set: string, aksi: string) {
    const hasil = await this.tx(a, async (c) => {
      const r = await c.query(`UPDATE partner_contracts SET ${set}, updated_at = now() WHERE id = $1 AND status = $2 RETURNING ${KOLOM}`, [id, dari]);
      if (r.rowCount) return r.rows[0];
      const status = await this.pastikanAda(c, id);
      throw konflik('TRANSISI_TIDAK_VALID', `Kontrak berstatus ${status} tidak dapat menjalani perubahan ini`);
    });
    await this.audit.catat({ aksi, aktorId: a.userId, companyId: hasil.company_id, objek: 'partner_contract', objekId: id });
    return peta(hasil);
  }

  // ---------- lampiran ----------
  private petaLampiran = (r: Baris) => ({ id: r.id, contractId: r.contract_id, title: r.title, originalFilename: r.original_filename, mimeType: r.mime_type, sizeBytes: r.size_bytes, createdAt: r.created_at });

  async daftarLampiran(a: Akses, kontrakId: string) {
    return this.tx(a, async (c) => {
      await this.pastikanAda(c, kontrakId);
      const r = await c.query(`SELECT id, contract_id, title, original_filename, mime_type, size_bytes, created_at FROM partner_contract_documents WHERE contract_id = $1 AND status = 'AKTIF' ORDER BY created_at DESC, id DESC LIMIT 200`, [kontrakId]);
      return { items: r.rows.map(this.petaLampiran) };
    });
  }

  async unggah(a: Akses, kontrakId: string, b: z.infer<typeof LampiranKontrakBody>, berkas: BerkasMasuk | undefined) {
    const v = periksaUnggahan(berkas);
    // Kontrak harus terlihat (RLS) dan tidak DIBATALKAN; company_id diturunkan dari kontrak.
    const { companyId } = await this.tx(a, async (c) => {
      const r = await c.query(`SELECT company_id, status FROM partner_contracts WHERE id = $1`, [kontrakId]);
      if (!r.rowCount) throw TDK_KONTRAK();
      if (r.rows[0].status === 'DIBATALKAN') throw konflik('KONTRAK_DIBATALKAN', 'Kontrak yang dibatalkan tidak menerima lampiran');
      return { companyId: r.rows[0].company_id as string };
    });
    const kunci = buatKunciObjek(companyId);
    await this.storage.simpan(kunci, berkas!.buffer);
    try {
      const baris = await this.tx(a, async (c) => {
        const r = await c.query(
          `INSERT INTO partner_contract_documents (company_id, contract_id, title, object_key, original_filename, mime_type, size_bytes, sha256, uploaded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, contract_id, title, original_filename, mime_type, size_bytes, created_at`,
          [companyId, kontrakId, b.title, kunci, v.namaAsli, v.mime, v.ukuran, v.sha256, a.userId],
        );
        return r.rows[0];
      });
      await this.audit.catat({ aksi: 'master.partner_contract_document.uploaded', aktorId: a.userId, companyId, objek: 'partner_contract_document', objekId: baris.id, detail: { ukuran: v.ukuran } });
      return this.petaLampiran(baris);
    } catch (e) {
      await this.storage.hapus(kunci).catch((x) => this.log.error(`Gagal membersihkan objek yatim: ${(x as Error).name}`));
      throw e;
    }
  }

  async unduh(a: Akses, kontrakId: string, lampiranId: string) {
    const d = await this.tx(a, async (c) => {
      const r = await c.query(`SELECT company_id, object_key, original_filename, mime_type FROM partner_contract_documents WHERE id = $1 AND contract_id = $2 AND status = 'AKTIF'`, [lampiranId, kontrakId]);
      return r.rows[0] as { company_id: string; object_key: string; original_filename: string; mime_type: string } | undefined;
    });
    if (!d) throw TDK_LAMPIRAN();
    let data: Buffer;
    try {
      data = await this.storage.baca(d.object_key);
    } catch (e) {
      if (e instanceof ObjekTidakDitemukan) throw TDK_LAMPIRAN();
      throw e;
    }
    await this.audit.catat({ aksi: 'master.partner_contract_document.downloaded', aktorId: a.userId, companyId: d.company_id, objek: 'partner_contract_document', objekId: lampiranId });
    return { data, mime: d.mime_type, nama: d.original_filename };
  }

  async hapusLampiran(a: Akses, kontrakId: string, lampiranId: string) {
    const companyId = await this.tx(a, async (c) => {
      const r = await c.query(`UPDATE partner_contract_documents SET status = 'DIHAPUS' WHERE id = $1 AND contract_id = $2 AND status = 'AKTIF' RETURNING company_id`, [lampiranId, kontrakId]);
      if (!r.rowCount) throw TDK_LAMPIRAN();
      return r.rows[0].company_id as string;
    });
    await this.audit.catat({ aksi: 'master.partner_contract_document.deleted', aktorId: a.userId, companyId, objek: 'partner_contract_document', objekId: lampiranId });
  }
}
