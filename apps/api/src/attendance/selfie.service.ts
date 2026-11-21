import { ConflictException, GoneException, Inject, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { dekripsiBerkas } from '../common/crypto/pii';
import { OBJECT_STORAGE, ObjectStorage, ObjekTidakDitemukan } from '../common/storage/object-storage';
import { ENV, KUNCI, Kunci } from '../config/config.module';
import type { Env } from '../config/env';
import { ScopedDb } from '../database/scoped-db';
import { POOL } from '../database/tokens';
import type { Akses } from '../rbac/akses.service';
import { JAM_ABSENSI, JamAbsensi } from './jam';
import { HoldBody } from './schemas';

const TDK = () => new NotFoundException({ kode: 'SELFIE_TIDAK_DITEMUKAN', message: 'Selfie tidak ditemukan' });
const BATCH = 500;

/**
 * Selfie absensi: hanya petugas berizin selfie.view; SETIAP akses diaudit (sebelum byte dikirim: gagal-aman); tanpa face recognition.
 * Retensi dapat dikonfigurasi per perusahaan (bawaan 90 hari); pekerjaan harian menghapus objek yang lewat batas kecuali LEGAL HOLD.
 * Baris rekaman tetap ada (bahan audit); hanya objek foto yang dihapus.
 */
@Injectable()
export class SelfieService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(SelfieService.name);
  private timer?: NodeJS.Timeout;
  constructor(
    @Inject(POOL) private readonly pool: Pool,
    @Inject(ENV) private readonly env: Env,
    @Inject(KUNCI) private readonly kunci: Kunci,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(JAM_ABSENSI) private readonly jam: JamAbsensi,
    private readonly sdb: ScopedDb,
    private readonly audit: AuditService,
  ) {}

  onModuleInit() {
    if (this.env.NODE_ENV === 'test') return; // tes memanggil purge() dengan jam yang disuntikkan
    this.timer = setInterval(() => void this.purge().catch((e) => this.log.error(`Purge selfie gagal: ${(e as Error).message}`)), 24 * 60 * 60 * 1000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private tx<T>(a: Akses, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    return this.sdb.tx({ companyIds: a.companyIds }, fn);
  }

  async lihat(a: Akses, recordId: string): Promise<Buffer> {
    const s = await this.tx(a, async (c) => {
      const r = await c.query(`SELECT s.id, s.company_id, s.storage_key, s.purged_at FROM attendance_selfies s WHERE s.record_id = $1`, [recordId]);
      if (!r.rowCount) throw TDK();
      return r.rows[0];
    });
    if (s.purged_at) throw new GoneException({ kode: 'SELFIE_SUDAH_DIHAPUS', message: 'Selfie sudah dihapus sesuai kebijakan retensi' });
    await this.audit.catat({ aksi: 'attendance.selfie.viewed', aktorId: a.userId, companyId: s.company_id, objek: 'attendance_record', objekId: recordId }); // gagal-aman: tanpa audit, tanpa foto
    try {
      return dekripsiBerkas(await this.storage.baca(s.storage_key), this.kunci.enkripsi, s.storage_key);
    } catch (e) {
      if (e instanceof ObjekTidakDitemukan) throw TDK();
      throw e;
    }
  }

  async tahan(a: Akses, recordId: string, b: z.infer<typeof HoldBody>) {
    const s = await this.tx(a, async (c) => {
      const r = await c.query(`SELECT id, company_id, purged_at, legal_hold FROM attendance_selfies WHERE record_id = $1 FOR UPDATE`, [recordId]);
      if (!r.rowCount) throw TDK();
      if (r.rows[0].purged_at) throw new ConflictException({ kode: 'SELFIE_SUDAH_DIHAPUS', message: 'Selfie sudah dihapus; legal hold tidak dapat diterapkan' });
      await c.query(`UPDATE attendance_selfies SET legal_hold = $2 WHERE id = $1`, [r.rows[0].id, b.hold]);
      return r.rows[0];
    });
    await this.audit.catat({ aksi: b.hold ? 'attendance.selfie.hold_set' : 'attendance.selfie.hold_released', aktorId: a.userId, companyId: s.company_id, objek: 'attendance_record', objekId: recordId, detail: { alasan: b.reason } });
    return { legalHold: b.hold };
  }

  /**
   * Menghapus objek selfie yang lewat batas retensi (kecuali legal hold). Idempoten; jam disuntikkan. Berjalan sebagai SISTEM (scope diturunkan server).
   * Satu objek yang gagal dihapus tidak menghentikan yang lain; kegagalan dihitung dan dicatat (tanpa kunci objek) untuk ditindaklanjuti operator.
   */
  async purge(sekarang: Date = this.jam()): Promise<{ dihapus: number; gagal: number }> {
    const perusahaan = (await this.pool.query(`SELECT id FROM companies`)).rows.map((r) => r.id as string);
    let total = 0;
    let gagal = 0;
    for (const companyId of perusahaan) {
      for (;;) {
        const hasil = await this.sdb.tx({ companyIds: [companyId] }, async (c) => {
          const r = await c.query(
            `SELECT id, storage_key FROM attendance_selfies WHERE purge_after <= $1 AND purged_at IS NULL AND legal_hold = false ORDER BY purge_after, id LIMIT ${BATCH} FOR UPDATE SKIP LOCKED`,
            [sekarang],
          );
          let ok = 0;
          for (const x of r.rows) {
            try {
              await this.storage.hapus(x.storage_key);
            } catch (e) {
              if (!(e instanceof ObjekTidakDitemukan)) {
                this.log.error(`Selfie ${x.id} gagal dihapus dari penyimpanan`);
                continue;
              }
            }
            await c.query(`UPDATE attendance_selfies SET purged_at = $2 WHERE id = $1 AND legal_hold = false AND purged_at IS NULL`, [x.id, sekarang]);
            ok += 1;
          }
          return { ok, diproses: r.rowCount ?? 0 };
        });
        if (hasil.ok > 0) await this.audit.catat({ aksi: 'attendance.selfie.purged', aktorId: null, companyId, objek: 'attendance_selfie', detail: { jumlah: hasil.ok } });
        total += hasil.ok;
        gagal += hasil.diproses - hasil.ok;
        if (hasil.diproses < BATCH || hasil.ok === 0) break;
      }
    }
    return { dihapus: total, gagal };
  }
}
