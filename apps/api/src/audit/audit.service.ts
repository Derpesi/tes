import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { POOL } from '../database/database.module';

export interface EntriAudit {
  aksi: string;
  aktorId?: string | null;
  companyId?: string | null;
  objek?: string | null;
  objekId?: string | null;
  /** Rincian perubahan. JANGAN berisi rahasia atau PII mentah. */
  detail?: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  async catat(e: EntriAudit): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_logs (action, actor_id, company_id, object_type, object_id, detail)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [e.aksi, e.aktorId ?? null, e.companyId ?? null, e.objek ?? null, e.objekId ?? null, JSON.stringify(e.detail ?? {})],
    );
  }
}
