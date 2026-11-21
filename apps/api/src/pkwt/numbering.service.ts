import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';

/**
 * Nomor kontrak otomatis: `<prefiks>/<kode perusahaan>/<tahun>/<urut 4 digit>`. Prefiks dari companies.document_settings
 * (bawaan "PKWT"). Penerbitan memakai baris counter per (perusahaan, tahun) yang dikunci FOR UPDATE di transaksi pemanggil,
 * sehingga permintaan serentak mendapat nomor berurutan tanpa duplikat. Jika transaksi pemanggil dibatalkan, nomor ikut batal (tanpa celah).
 */
@Injectable()
export class NumberingService {
  async terbitkan(c: PoolClient, companyId: string, tahun: number): Promise<string> {
    const co = await c.query(`SELECT short_code, document_settings->>'contractNumberPrefix' AS prefiks FROM companies WHERE id = $1`, [companyId]);
    if (!co.rowCount) throw new Error('Perusahaan tidak ditemukan');
    await c.query(`INSERT INTO contract_number_counters (company_id, year) VALUES ($1, $2) ON CONFLICT (company_id, year) DO NOTHING`, [companyId, tahun]);
    const r = await c.query(`UPDATE contract_number_counters SET last_value = last_value + 1 WHERE company_id = $1 AND year = $2 RETURNING last_value`, [companyId, tahun]);
    const urut = String(r.rows[0].last_value).padStart(4, '0');
    return `${co.rows[0].prefiks ?? 'PKWT'}/${co.rows[0].short_code}/${tahun}/${urut}`;
  }
}
