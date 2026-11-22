import type { Pool } from 'pg';
import { PengaturanPkwt } from '../master/schemas';
import { variabelTidakDikenal } from '../pkwt/variabel';
import { pastikanPeranBypass } from './rotasi-kunci';

/**
 * Impor templat PKWT dari berkas isi milik pemilik (docs/templates/pkwt-alih-daya/isi.txt) ke SEMUA/satu perusahaan aktif.
 * - Selalu berstatus BELUM_DIVERIFIKASI (verifikasi oleh staf berwenang yang BUKAN pembuat, lewat sistem); alat ini tidak pernah memverifikasi.
 * - Idempoten: bila perusahaan sudah punya versi dengan isi yang sama, dilewati.
 * - Pengaturan PKWT (opsional) hanya diisikan bila perusahaan BELUM punya pengaturan PKWT (tidak menimpa hasil sunting pemilik).
 * - Tidak mencetak isi templat atau nilai pengaturan; audit teknis hanya memuat versi dan status.
 */
export interface OpsiImpor {
  pool: Pool;
  isi: string;
  nama: string;
  /** Perusahaan tertentu; kosong = semua perusahaan aktif. */
  perusahaanId?: string;
  /** Pengguna staf yang tercatat sebagai pembuat templat. */
  oleh: string;
  /** Pengaturan PKWT awal (mis. dari pengaturan-damarindo-mandiri.json); hanya untuk perusahaan yang belum punya. */
  pengaturan?: unknown;
  kering?: boolean;
}
export interface HasilImpor {
  perusahaan: { id: string; nama: string; templat: 'dibuat' | 'sudah-ada'; versi: number; pengaturan: 'diisi' | 'dilewati' | 'tidak-diminta' }[];
  kering: boolean;
}

const NAMA_MAKS = 150;
const ISI_MAKS = 50000;

export async function imporTemplatPkwt(o: OpsiImpor): Promise<HasilImpor> {
  await pastikanPeranBypass(o.pool);
  const isi = o.isi.replace(/\r\n/g, '\n');
  if (!isi.trim()) throw new Error('Isi templat kosong');
  if (isi.length > ISI_MAKS) throw new Error(`Isi templat melebihi ${ISI_MAKS} karakter`);
  const asing = variabelTidakDikenal(isi);
  if (asing.length) throw new Error(`Variabel templat tidak dikenal: ${asing.join(', ')}`);
  const nama = o.nama.trim();
  if (!nama || nama.length > NAMA_MAKS) throw new Error(`Nama templat wajib diisi (maksimal ${NAMA_MAKS} karakter)`);
  let pengaturan: ReturnType<typeof PengaturanPkwt.parse> | undefined;
  if (o.pengaturan !== undefined) {
    const p = PengaturanPkwt.safeParse(o.pengaturan);
    if (!p.success) throw new Error(`Pengaturan PKWT tidak valid: ${p.error.issues.map((i) => i.message).join('; ')}`);
    pengaturan = p.data;
  }
  const u = await o.pool.query(`SELECT 1 FROM users WHERE id = $1 AND realm = 'staff'`, [o.oleh]);
  if (!u.rowCount) throw new Error('Pengguna pembuat (--oleh) harus pengguna staf yang ada');

  const daftar = await o.pool.query(`SELECT id, name FROM companies WHERE active AND ($1::uuid IS NULL OR id = $1) ORDER BY name`, [o.perusahaanId ?? null]);
  if (o.perusahaanId && !daftar.rowCount) throw new Error('Perusahaan tidak ditemukan atau tidak aktif');
  const hasil: HasilImpor = { perusahaan: [], kering: Boolean(o.kering) };

  for (const c of daftar.rows as { id: string; name: string }[]) {
    const klien = await o.pool.connect();
    try {
      await klien.query('BEGIN');
      await klien.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`impor-templat:${c.id}:${nama}`]);
      const ada = (await klien.query(`SELECT version, body FROM contract_templates WHERE company_id = $1 AND name = $2 ORDER BY version DESC`, [c.id, nama])).rows as { version: number; body: string }[];
      const sama = ada.find((x) => x.body === isi);
      let versi = sama?.version ?? (ada[0]?.version ?? 0) + 1;
      let templat: 'dibuat' | 'sudah-ada' = 'sudah-ada';
      if (!sama) {
        templat = 'dibuat';
        if (!o.kering) {
          await klien.query(`INSERT INTO contract_templates (company_id, name, version, body, status, created_by) VALUES ($1, $2, $3, $4, 'BELUM_DIVERIFIKASI', $5)`, [c.id, nama, versi, isi, o.oleh]);
          await klien.query(`INSERT INTO audit_logs (action, actor_id, company_id, object_type, detail) VALUES ('system.pkwt_template.imported', $1, $2, 'contract_template', $3)`, [o.oleh, c.id, JSON.stringify({ versi, status: 'BELUM_DIVERIFIKASI' })]);
        }
      } else versi = sama.version;
      let status: 'diisi' | 'dilewati' | 'tidak-diminta' = 'tidak-diminta';
      if (pengaturan) {
        const punya = (await klien.query(`SELECT document_settings->'pkwt' IS NOT NULL AND document_settings->'pkwt' <> '{}'::jsonb AS ada FROM companies WHERE id = $1`, [c.id])).rows[0].ada as boolean;
        if (punya) status = 'dilewati';
        else {
          status = 'diisi';
          if (!o.kering) await klien.query(`UPDATE companies SET document_settings = jsonb_set(COALESCE(document_settings, '{}'::jsonb), '{pkwt}', $2::jsonb), updated_at = now() WHERE id = $1`, [c.id, JSON.stringify(pengaturan)]);
        }
      }
      await klien.query(o.kering ? 'ROLLBACK' : 'COMMIT');
      hasil.perusahaan.push({ id: c.id, nama: c.name, templat, versi, pengaturan: status });
    } catch (e) {
      await klien.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      klien.release();
    }
  }
  return hasil;
}
