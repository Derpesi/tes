import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';

/** Status member yang dikelola otomatis dari kontrak + penempatan. Status lain (NONAKTIF, pra-verifikasi) tidak disentuh. */
const DIKELOLA = ['TERVERIFIKASI', 'BELUM_DITEMPATKAN', 'KARYAWAN_AKTIF', 'KONTRAK_AKAN_BERAKHIR', 'KONTRAK_BERAKHIR'];
export const JENDELA_AKAN_BERAKHIR_HARI = 30; // asumsi A-31 (dapat dikonfigurasi pemilik)

/**
 * SATU-SATUNYA penulis status member turunan (KARYAWAN_AKTIF, KONTRAK_AKAN_BERAKHIR, KONTRAK_BERAKHIR). Dipanggil di dalam transaksi
 * siklus hidup dengan baris profil terkunci FOR UPDATE (pasangan FOR SHARE milik canApply), sehingga lamaran dan perubahan status tidak balapan.
 *
 * Aturan: kontrak AKTIF + penempatan AKTIF => KARYAWAN_AKTIF; berakhir dalam 30 hari tanpa kontrak lanjutan yang sudah ditandatangani
 * => KONTRAK_AKAN_BERAKHIR; tidak ada kontrak AKTIF lagi => KONTRAK_BERAKHIR. Kembali ke BELUM_DITEMPATKAN HANYA lewat verifikasi HRD.
 * Kontrak aktif tanpa penempatan aktif (mis. ditangguhkan) tidak menurunkan status.
 */
@Injectable()
export class MemberStatusService {
  /** Mengembalikan status baru bila berubah, atau null. `hariIni` = YYYY-MM-DD (WIB). */
  async sinkronkan(c: PoolClient, personId: string, hariIni: string): Promise<string | null> {
    const p = await c.query(`SELECT status FROM member_profiles WHERE person_id = $1 FOR UPDATE`, [personId]);
    if (!p.rowCount) return null;
    const sekarang = p.rows[0].status as string;
    if (!DIKELOLA.includes(sekarang)) return null;

    const k = await c.query(
      `SELECT c.id, c.end_date::text AS end_date,
              EXISTS (SELECT 1 FROM placements pl WHERE pl.contract_id = c.id AND pl.status = 'AKTIF') AS punya_penempatan,
              EXISTS (SELECT 1 FROM employment_contracts n WHERE n.extends_contract_id = c.id AND n.status IN ('DITANDATANGANI', 'AKTIF')) AS ada_lanjutan
         FROM employment_contracts c WHERE c.person_id = $1 AND c.status = 'AKTIF'`,
      [personId],
    );
    const adaKontrakAktif = k.rows.length > 0;
    const karyawan = k.rows.filter((r) => r.punya_penempatan);
    let baru: string | null = null;
    let alasan = '';
    if (karyawan.length) {
      const hariKeAkhir = (r: { end_date: string }) => Math.round((Date.parse(`${r.end_date}T00:00:00Z`) - Date.parse(`${hariIni}T00:00:00Z`)) / 86400000);
      const akanBerakhir = karyawan.every((r) => !r.ada_lanjutan && hariKeAkhir(r) <= JENDELA_AKAN_BERAKHIR_HARI);
      baru = akanBerakhir ? 'KONTRAK_AKAN_BERAKHIR' : 'KARYAWAN_AKTIF';
      alasan = akanBerakhir ? `Otomatis: kontrak berakhir dalam ${JENDELA_AKAN_BERAKHIR_HARI} hari tanpa kontrak lanjutan` : 'Otomatis: kontrak dan penempatan aktif';
    } else if (!adaKontrakAktif && ['KARYAWAN_AKTIF', 'KONTRAK_AKAN_BERAKHIR'].includes(sekarang)) {
      baru = 'KONTRAK_BERAKHIR';
      alasan = 'Otomatis: kontrak berakhir';
    }
    if (!baru || baru === sekarang) return null;

    await c.query(`UPDATE member_profiles SET status = $2, updated_at = now() WHERE person_id = $1`, [personId, baru]);
    await c.query(`INSERT INTO member_status_histories (person_id, from_status, to_status, actor_user_id, reason) VALUES ($1, $2, $3, NULL, $4)`, [personId, sekarang, baru, alasan]);

    if (baru === 'KARYAWAN_AKTIF' && sekarang !== 'KONTRAK_AKAN_BERAKHIR') {
      // Menjadi karyawan: lamaran aktif lain ditarik otomatis (lamaran yang menghasilkan kontrak, MENUNGGU_PKWT, tidak disentuh).
      const tarik = await c.query(
        `WITH t AS (SELECT id, company_id, status FROM job_applications WHERE person_id = $1 AND status IN ('DIAJUKAN', 'SELEKSI_ADMINISTRASI', 'INTERVIEW') FOR UPDATE),
              u AS (UPDATE job_applications a SET status = 'DITARIK', updated_at = now() FROM t WHERE a.id = t.id RETURNING a.id)
         SELECT t.id, t.company_id, t.status FROM t JOIN u ON u.id = t.id`,
        [personId],
      );
      for (const r of tarik.rows) {
        await c.query(`INSERT INTO application_status_histories (company_id, application_id, from_status, to_status, actor_user_id, reason) VALUES ($1, $2, $3, 'DITARIK', NULL, 'Otomatis: menjadi karyawan aktif')`, [r.company_id, r.id, r.status]);
      }
    }
    return baru;
  }
}
