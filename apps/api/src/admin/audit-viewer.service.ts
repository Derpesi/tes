import { Injectable } from '@nestjs/common';
import { AWALAN_TEKNIS, AWALAN_TRANSAKSI, KategoriAudit, kategoriAksi, kebijakanUntuk, saringDetail } from '../audit/kategori';
import { ScopedDb } from '../database/scoped-db';
import type { Akses } from '../rbac/akses.service';
import { decodeKursor, encodeKursor } from './kursor';

export interface FilterAudit {
  action?: string;
  kategori?: KategoriAudit;
  objectType?: string;
  objectId?: string;
  actorId?: string;
  companyId?: string;
  from?: Date;
  to?: Date;
  cursor?: string;
  limit: number;
}

const LIKE_ANY = (kolom: string, awalan: readonly string[]) => `(${awalan.map((a) => `${kolom} LIKE '${a.replace(/[\\%_']/g, '')}%'`).join(' OR ')})`;
const SQL_TEKNIS = LIKE_ANY('action', AWALAN_TEKNIS);
const SQL_TRANSAKSI = LIKE_ANY('action', AWALAN_TRANSAKSI);

@Injectable()
export class AuditViewerService {
  constructor(private readonly sdb: ScopedDb) {}

  /**
   * Membaca audit log DENGAN scope (RLS: baris perusahaan dalam scope + baris global bila berhak) DAN kategori menurut peran (ditegakkan di SQL):
   * Direktur semua; Mgr Ops operasional + transaksi; IT teknis saja TANPA detail; Keuangan transaksi saja. Peran lain: kosong. Detail disaring daftar putih.
   */
  async baca(a: Akses, f: FilterAudit) {
    const kebijakan = kebijakanUntuk(a.roles);
    let boleh = [...kebijakan.kategori];
    if (f.kategori) boleh = boleh.filter((k) => k === f.kategori); // filter di luar kewenangan -> hasil kosong (tanpa membocorkan keberadaan)
    if (!boleh.length) return { items: [], nextCursor: null };
    const k = decodeKursor(f.cursor);
    const ada = (x: KategoriAudit) => boleh.includes(x);
    return this.sdb.tx({ companyIds: a.companyIds, auditGlobal: a.auditGlobal }, async (c) => {
      const r = await c.query(
        `SELECT id, occurred_at, occurred_at::text AS occurred_at_txt, action, actor_id, company_id, object_type, object_id, detail FROM audit_logs
          WHERE (($7::boolean AND ${SQL_TEKNIS}) OR ($8::boolean AND ${SQL_TRANSAKSI}) OR ($9::boolean AND NOT ${SQL_TEKNIS} AND NOT ${SQL_TRANSAKSI}))
            AND ($1::text IS NULL OR action LIKE $1 || '%')
            AND ($2::timestamptz IS NULL OR occurred_at >= $2) AND ($3::timestamptz IS NULL OR occurred_at < $3)
            AND ($4::timestamptz IS NULL OR (occurred_at, id) < ($4::timestamptz, $5::uuid))
            AND ($10::text IS NULL OR object_type = $10) AND ($11::text IS NULL OR object_id = $11)
            AND ($12::uuid IS NULL OR actor_id = $12) AND ($13::uuid IS NULL OR company_id = $13)
          ORDER BY occurred_at DESC, id DESC LIMIT $6`,
        [f.action ? f.action.replace(/[\\%_]/g, '\\$&') : null, f.from ?? null, f.to ?? null, k?.t ?? null, k?.id ?? null, f.limit + 1, ada('TEKNIS'), ada('TRANSAKSI'), ada('OPERASIONAL'), f.objectType ?? null, f.objectId ?? null, f.actorId ?? null, f.companyId ?? null],
      );
      const lagi = r.rows.length > f.limit;
      const baris = r.rows.slice(0, f.limit);
      return {
        items: baris.map((x) => ({
          id: x.id, occurredAt: x.occurred_at, action: x.action, category: kategoriAksi(x.action), actorId: x.actor_id, companyId: x.company_id, objectType: x.object_type, objectId: x.object_id,
          detail: kebijakan.detail ? saringDetail(x.detail) : null,
        })),
        nextCursor: lagi ? encodeKursor({ t: baris[baris.length - 1].occurred_at_txt, id: baris[baris.length - 1].id }) : null,
      };
    });
  }
}
