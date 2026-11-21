import { Pool } from 'pg';
import { dalamScope } from './db';

export interface KonfigKebocoran {
  /** Nama tabel tenant (sudah aman/terkutip) yang punya kolom id dan company_id. */
  tabel: string;
  companyA: string;
  companyB: string;
  idBarisA: string;
  idBarisB: string;
  /** Pernyataan INSERT yang membuat satu baris untuk companyId yang diberikan. */
  sisipUntuk(companyId: string): { text: string; values: unknown[] };
}

/**
 * Memeriksa apakah pengguna scope A dapat menyentuh data B. Mengembalikan daftar kebocoran
 * (kosong = terisolasi). Dipakai ulang oleh tiap modul bertabel tenant.
 */
export async function cekKebocoran(pool: Pool, k: KonfigKebocoran): Promise<string[]> {
  const bocor: string[] = [];

  await dalamScope(pool, [k.companyA], async (c) => {
    const semua = await c.query(`SELECT company_id FROM ${k.tabel}`);
    if (semua.rows.some((r) => r.company_id === k.companyB)) bocor.push('SELECT massal melihat baris perusahaan lain');
    const langsung = await c.query(`SELECT 1 FROM ${k.tabel} WHERE id = $1`, [k.idBarisB]);
    if (langsung.rowCount) bocor.push('SELECT per ID melihat baris perusahaan lain');
  });
  await dalamScope(pool, [k.companyA], async (c) => {
    const u = await c.query(`UPDATE ${k.tabel} SET company_id = company_id WHERE id = $1`, [k.idBarisB]);
    if (u.rowCount) bocor.push('UPDATE mengubah baris perusahaan lain');
  });
  await dalamScope(pool, [k.companyA], async (c) => {
    const d = await c.query(`DELETE FROM ${k.tabel} WHERE id = $1`, [k.idBarisB]);
    if (d.rowCount) bocor.push('DELETE menghapus baris perusahaan lain');
  });
  await dalamScope(pool, [k.companyA], async (c) => {
    const { text, values } = k.sisipUntuk(k.companyB);
    try {
      await c.query(text, values);
    } catch {
      return; // ditolak = benar
    }
    bocor.push('INSERT menulis baris untuk perusahaan lain');
  });
  await dalamScope(pool, [], async (c) => {
    const kosong = await c.query(`SELECT 1 FROM ${k.tabel}`);
    if (kosong.rowCount) bocor.push('Tanpa scope tetap melihat baris');
  });
  return bocor;
}
