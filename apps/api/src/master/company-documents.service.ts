import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { BerkasMasuk, periksaUnggahan } from '../common/storage/upload';
import { buatKunciObjek, OBJECT_STORAGE, ObjectStorage, ObjekTidakDitemukan } from '../common/storage/object-storage';
import { ScopedDb } from '../database/scoped-db';
import type { Akses } from '../rbac/akses.service';
import { DokumenPerusahaanBody } from './schemas';

const TIDAK_ADA = () => new NotFoundException({ kode: 'DOKUMEN_TIDAK_DITEMUKAN', message: 'Dokumen tidak ditemukan' });

/** Dokumen legalitas perusahaan. Objek privat; unduhan hanya lewat API (izin + scope + audit). Respons tidak pernah memuat kunci objek. */
@Injectable()
export class CompanyDocumentsService {
  private readonly log = new Logger(CompanyDocumentsService.name);
  constructor(
    private readonly sdb: ScopedDb,
    private readonly audit: AuditService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  /** Perusahaan di luar scope diperlakukan seperti tidak ada (404), sebelum menyentuh penyimpanan. */
  private pastikanScope(a: Akses, companyId: string) {
    if (!a.companyIds.includes(companyId)) throw new NotFoundException({ kode: 'PERUSAHAAN_TIDAK_DITEMUKAN', message: 'Perusahaan tidak ditemukan' });
  }

  private peta(r: Record<string, unknown>) {
    return { id: r.id, kind: r.kind, title: r.title, originalFilename: r.original_filename, mimeType: r.mime_type, sizeBytes: r.size_bytes, validUntil: r.valid_until, createdAt: r.created_at };
  }

  async daftar(a: Akses, companyId: string) {
    this.pastikanScope(a, companyId);
    return this.sdb.tx({ companyIds: a.companyIds }, async (c) => {
      const r = await c.query(`SELECT id, kind, title, original_filename, mime_type, size_bytes, valid_until::text AS valid_until, created_at FROM company_documents WHERE company_id = $1 AND status = 'AKTIF' ORDER BY created_at DESC, id DESC LIMIT 200`, [companyId]);
      return { items: r.rows.map((x) => this.peta(x)) };
    });
  }

  async unggah(a: Akses, companyId: string, b: z.infer<typeof DokumenPerusahaanBody>, berkas: BerkasMasuk | undefined) {
    this.pastikanScope(a, companyId);
    const v = periksaUnggahan(berkas); // jenis dari magic bytes, ukuran, ekstensi
    const kunci = buatKunciObjek(companyId);
    await this.storage.simpan(kunci, berkas!.buffer);
    try {
      const baris = await this.sdb.tx({ companyIds: a.companyIds }, async (c) => {
        const r = await c.query(
          `INSERT INTO company_documents (company_id, kind, title, object_key, original_filename, mime_type, size_bytes, sha256, valid_until, uploaded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id, kind, title, original_filename, mime_type, size_bytes, valid_until::text AS valid_until, created_at`,
          [companyId, b.kind, b.title, kunci, v.namaAsli, v.mime, v.ukuran, v.sha256, b.validUntil ?? null, a.userId],
        );
        return r.rows[0];
      });
      await this.audit.catat({ aksi: 'master.company_document.uploaded', aktorId: a.userId, companyId, objek: 'company_document', objekId: baris.id, detail: { kind: b.kind, ukuran: v.ukuran } });
      return this.peta(baris);
    } catch (e) {
      // Kompensasi: jangan tinggalkan objek yatim bila penyimpanan metadata gagal.
      await this.storage.hapus(kunci).catch((x) => this.log.error(`Gagal membersihkan objek yatim: ${(x as Error).name}`));
      throw e;
    }
  }

  async unduh(a: Akses, companyId: string, docId: string) {
    this.pastikanScope(a, companyId);
    const d = await this.sdb.tx({ companyIds: a.companyIds }, async (c) => {
      const r = await c.query(`SELECT object_key, original_filename, mime_type FROM company_documents WHERE id = $1 AND company_id = $2 AND status = 'AKTIF'`, [docId, companyId]);
      return r.rows[0] as { object_key: string; original_filename: string; mime_type: string } | undefined;
    });
    if (!d) throw TIDAK_ADA();
    let data: Buffer;
    try {
      data = await this.storage.baca(d.object_key);
    } catch (e) {
      if (e instanceof ObjekTidakDitemukan) throw TIDAK_ADA();
      throw e;
    }
    await this.audit.catat({ aksi: 'master.company_document.downloaded', aktorId: a.userId, companyId, objek: 'company_document', objekId: docId });
    return { data, mime: d.mime_type, nama: d.original_filename };
  }

  /** Penghapusan lunak: tidak tampil dan tidak dapat diunduh; objek dipertahankan untuk kebutuhan audit/hukum. */
  async hapus(a: Akses, companyId: string, docId: string) {
    this.pastikanScope(a, companyId);
    const n = await this.sdb.tx({ companyIds: a.companyIds }, async (c) => (await c.query(`UPDATE company_documents SET status = 'DIHAPUS' WHERE id = $1 AND company_id = $2 AND status = 'AKTIF'`, [docId, companyId])).rowCount);
    if (!n) throw TIDAK_ADA();
    await this.audit.catat({ aksi: 'master.company_document.deleted', aktorId: a.userId, companyId, objek: 'company_document', objekId: docId });
  }
}


