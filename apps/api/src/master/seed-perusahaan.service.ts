import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { AuditService } from '../audit/audit.service';
import { POOL } from '../database/tokens';

/** Perusahaan awal grup. HANYA nama dan kode singkat (kode adalah usulan, dapat diubah IT); data hukum diisi lewat aplikasi. */
export const PERUSAHAAN_AWAL = [
  { name: 'PT. Damarindo Mandiri', kode: 'DMR' },
  { name: 'PT. OSI', kode: 'OSI' },
  { name: 'PT. Pancormas Perkasa', kode: 'PCP' },
] as const;

@Injectable()
export class SeedPerusahaanService {
  constructor(
    @Inject(POOL) private readonly pool: Pool,
    private readonly audit: AuditService,
  ) {}

  /** Idempoten: upsert berdasarkan kode singkat; perusahaan yang sudah ada tidak diubah. */
  async jalankan(): Promise<{ dibuat: number; sudahAda: number }> {
    let dibuat = 0;
    for (const p of PERUSAHAAN_AWAL) {
      const r = await this.pool.query(`INSERT INTO companies (name, short_code, active) VALUES ($1, $2, true) ON CONFLICT (short_code) DO NOTHING RETURNING id`, [p.name, p.kode]);
      if (r.rowCount) {
        dibuat++;
        await this.audit.catat({ aksi: 'master.company.seeded', objek: 'company', objekId: r.rows[0].id, detail: { kode: p.kode } });
      }
    }
    return { dibuat, sudahAda: PERUSAHAAN_AWAL.length - dibuat };
  }
}
