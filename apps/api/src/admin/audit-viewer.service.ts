import { Injectable } from '@nestjs/common';
import { ScopedDb } from '../database/scoped-db';
import type { Akses } from '../rbac/akses.service';
import { decodeKursor, encodeKursor } from './kursor';

export interface FilterAudit {
  action?: string;
  from?: Date;
  to?: Date;
  cursor?: string;
  limit: number;
}

@Injectable()
export class AuditViewerService {
  constructor(private readonly sdb: ScopedDb) {}

  /**
   * Membaca audit log DENGAN scope: hanya baris perusahaan dalam scope pengguna, ditambah baris global
   * (company_id NULL) bila perannya berhak. Penegakan dilakukan RLS di database, bukan filter aplikasi.
   */
  async baca(a: Akses, f: FilterAudit) {
    const k = decodeKursor(f.cursor);
    return this.sdb.tx({ companyIds: a.companyIds, auditGlobal: a.auditGlobal }, async (c) => {
      const r = await c.query(
        `SELECT id, occurred_at, occurred_at::text AS occurred_at_txt, action, actor_id, company_id, object_type, object_id, detail FROM audit_logs
          WHERE ($1::text IS NULL OR action LIKE $1 || '%')
            AND ($2::timestamptz IS NULL OR occurred_at >= $2) AND ($3::timestamptz IS NULL OR occurred_at < $3)
            AND ($4::timestamptz IS NULL OR (occurred_at, id) < ($4::timestamptz, $5::uuid))
          ORDER BY occurred_at DESC, id DESC LIMIT $6`,
        [f.action ? f.action.replace(/[\\%_]/g, '\\$&') : null, f.from ?? null, f.to ?? null, k?.t ?? null, k?.id ?? null, f.limit + 1],
      );
      const ada = r.rows.length > f.limit;
      const baris = r.rows.slice(0, f.limit);
      return {
        items: baris.map((x) => ({ id: x.id, occurredAt: x.occurred_at, action: x.action, actorId: x.actor_id, companyId: x.company_id, objectType: x.object_type, objectId: x.object_id, detail: x.detail })),
        nextCursor: ada ? encodeKursor({ t: baris[baris.length - 1].occurred_at_txt, id: baris[baris.length - 1].id }) : null,
      };
    });
  }
}
