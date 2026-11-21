import { Pool } from 'pg';
import { COMPANY_SINTETIS } from './data-sintetis';
import { dalamScope } from './db';
import type { KonfigKebocoran } from './kebocoran';

export const TABEL_UJI = 'uji_item_sintetis';

/** Membuat tabel uji sementara (hanya di database uji) dengan RLS standar dan mengisi data sintetis A dan B. */
export async function buatTabelUji(pool: Pool, roleUji: string): Promise<KonfigKebocoran> {
  await pool.query(`DROP TABLE IF EXISTS ${TABEL_UJI}`);
  await pool.query(`CREATE TABLE ${TABEL_UJI} (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL,
    label text NOT NULL
  )`);
  await pool.query(`SELECT enable_tenant_rls('${TABEL_UJI}')`);
  await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${TABEL_UJI} TO ${roleUji}`);

  const sisip = (companyId: string, label: string) => ({
    text: `INSERT INTO ${TABEL_UJI} (company_id, label) VALUES ($1, $2) RETURNING id`,
    values: [companyId, label],
  });
  const buat = async (companyId: string, label: string) =>
    dalamScope(pool, [companyId], async (c) => (await c.query(sisip(companyId, label).text, sisip(companyId, label).values)).rows[0].id as string, { commit: true });

  const idBarisA = await buat(COMPANY_SINTETIS.A, 'SINTETIS baris A');
  const idBarisB = await buat(COMPANY_SINTETIS.B, 'SINTETIS baris B');

  return {
    tabel: TABEL_UJI,
    companyA: COMPANY_SINTETIS.A,
    companyB: COMPANY_SINTETIS.B,
    idBarisA,
    idBarisB,
    sisipUntuk: (companyId) => sisip(companyId, 'SINTETIS sisipan'),
  };
}

export async function hapusTabelUji(pool: Pool): Promise<void> {
  await pool.query(`DROP TABLE IF EXISTS ${TABEL_UJI}`);
}
