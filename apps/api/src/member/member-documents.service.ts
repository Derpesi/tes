import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Pool } from 'pg';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { dekripsiBerkas, enkripsiBerkas } from '../common/crypto/pii';
import { buatKunciObjekMember, OBJECT_STORAGE, ObjectStorage, ObjekTidakDitemukan } from '../common/storage/object-storage';
import { BerkasMasuk, periksaUnggahan } from '../common/storage/upload';
import { KUNCI, Kunci } from '../config/config.module';
import { POOL } from '../database/tokens';
import { MemberContextService } from './member-context.service';
import { MemberProfileService } from './member-profile.service';
import { DokumenMemberBody } from './schemas';

const TDK_DOKUMEN = () => new NotFoundException({ kode: 'DOKUMEN_TIDAK_DITEMUKAN', message: 'Dokumen tidak ditemukan' });
const peta = (r: Record<string, unknown>) => ({ id: r.id, kind: r.kind, originalFilename: r.original_filename, mimeType: r.mime_type, sizeBytes: r.size_bytes, createdAt: r.created_at });

/** Dokumen identitas member. Isi berkas DIENKRIPSI sebelum disimpan (AAD = kunci objek); unduhan hanya lewat API. */
@Injectable()
export class MemberDocumentsService {
  private readonly log = new Logger(MemberDocumentsService.name);
  constructor(
    @Inject(POOL) private readonly pool: Pool,
    @Inject(KUNCI) private readonly kunci: Kunci,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    private readonly ctx: MemberContextService,
    private readonly profil: MemberProfileService,
    private readonly audit: AuditService,
  ) {}

  /** Membaca dan mendekripsi isi berkas (dipakai pemilik dan, di 5C, petugas berizin). */
  async bacaIsi(objectKey: string): Promise<Buffer> {
    let data: Buffer;
    try {
      data = await this.storage.baca(objectKey);
    } catch (e) {
      if (e instanceof ObjekTidakDitemukan) throw TDK_DOKUMEN();
      throw e;
    }
    return dekripsiBerkas(data, this.kunci.enkripsi, objectKey);
  }

  async daftar(userId: string) {
    const personId = await this.ctx.personId(userId);
    const r = await this.pool.query(`SELECT id, kind, original_filename, mime_type, size_bytes, created_at FROM member_documents WHERE person_id = $1 AND status = 'AKTIF' ORDER BY created_at DESC, id DESC LIMIT 100`, [personId]);
    return { items: r.rows.map(peta) };
  }

  async unggah(userId: string, b: z.infer<typeof DokumenMemberBody>, berkas: BerkasMasuk | undefined) {
    const personId = await this.ctx.personId(userId);
    const v = periksaUnggahan(berkas);
    const kunciObjek = buatKunciObjekMember(personId);
    await this.storage.simpan(kunciObjek, enkripsiBerkas(berkas!.buffer, this.kunci.enkripsi, kunciObjek));
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await this.profil.bukaUntukUbah(c, personId, userId);
      let baris: Record<string, unknown>;
      try {
        baris = (await c.query(
          `INSERT INTO member_documents (person_id, kind, object_key, original_filename, mime_type, size_bytes, sha256) VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, kind, original_filename, mime_type, size_bytes, created_at`,
          [personId, b.kind, kunciObjek, v.namaAsli, v.mime, v.ukuran, v.sha256],
        )).rows[0];
      } catch (e) {
        if ((e as { constraint?: string }).constraint === 'member_documents_satu_aktif') {
          throw new ConflictException({ kode: 'DOKUMEN_SUDAH_ADA', message: 'Dokumen jenis ini sudah ada. Hapus dokumen lama terlebih dahulu' });
        }
        throw e;
      }
      await c.query('COMMIT');
      await this.audit.catat({ aksi: 'member.document.uploaded', aktorId: userId, objek: 'member_document', objekId: baris.id as string, detail: { kind: b.kind, ukuran: v.ukuran } });
      return peta(baris);
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      await this.storage.hapus(kunciObjek).catch((x) => this.log.error(`Gagal membersihkan objek yatim: ${(x as Error).name}`));
      throw e;
    } finally {
      c.release();
    }
  }

  async unduh(userId: string, docId: string) {
    const personId = await this.ctx.personId(userId);
    const r = await this.pool.query(`SELECT object_key, original_filename, mime_type FROM member_documents WHERE id = $1 AND person_id = $2 AND status = 'AKTIF'`, [docId, personId]);
    if (!r.rowCount) throw TDK_DOKUMEN();
    return { data: await this.bacaIsi(r.rows[0].object_key), mime: r.rows[0].mime_type as string, nama: r.rows[0].original_filename as string };
  }

  /** Hapus lunak: objek dipertahankan (kebijakan retensi final menunggu pemilik/UU PDP). */
  async hapus(userId: string, docId: string) {
    const personId = await this.ctx.personId(userId);
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await this.profil.bukaUntukUbah(c, personId, userId);
      const r = await c.query(`UPDATE member_documents SET status = 'DIHAPUS' WHERE id = $1 AND person_id = $2 AND status = 'AKTIF'`, [docId, personId]);
      if (!r.rowCount) throw TDK_DOKUMEN();
      await c.query('COMMIT');
      await this.audit.catat({ aksi: 'member.document.deleted', aktorId: userId, objek: 'member_document', objekId: docId });
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }
}
