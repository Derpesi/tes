import type { Pool } from 'pg';
import { type KunciEnkripsi, cincinKunci, dekripsiBerversi, enkripsi } from '../common/crypto/crypto';
import { ObjekTidakDitemukan, type ObjectStorage } from '../common/storage/object-storage';

/**
 * Logika rotasi kunci enkripsi (ADR-0013). Mengenkripsi ulang SEMUA data terenkripsi aplikasi ke kunci aktif tanpa mengubah isi.
 * Idempoten, tahan interupsi (hanya memproses yang bukan versi aktif), dan tidak menimpa perubahan serentak (bandingan optimistis).
 * Harus berjalan dengan role yang melewati RLS (data lintas perusahaan dan member); `pastikanPeranBypass` menolak role biasa.
 * TIDAK PERNAH mencatat nilai rahasia/plaintext.
 */

export type Perintah = 'cek' | 'jalan' | 'verifikasi';

interface TargetDb {
  nama: string;
  tabel: string;
  kolom: string;
  /** Kolom tambahan yang dibaca untuk membentuk AAD. */
  ekstra?: string[];
  aad: (r: Record<string, unknown>) => string;
  /** Kolom versi yang ikut diperbarui (hanya member_profiles). */
  kolomVersi?: string;
}
interface TargetObjek {
  nama: string;
  tabel: string;
  kolomKunci: string;
  filter?: string;
}

export const TARGET_DB: TargetDb[] = [
  { nama: 'NIK member', tabel: 'member_profiles', kolom: 'nik_enc', aad: (r) => `member_profile:${r.id}:nik`, kolomVersi: 'key_version' },
  { nama: 'Rahasia TOTP staf', tabel: 'staff_mfa_factors', kolom: 'secret_enc', ekstra: ['user_id'], aad: (r) => `mfa:${r.user_id}` },
  { nama: 'Payload outbox', tabel: 'notification_outbox', kolom: 'payload_enc', aad: (r) => `outbox:${r.id}` },
];
export const TARGET_OBJEK: TargetObjek[] = [
  { nama: 'Berkas member', tabel: 'member_documents', kolomKunci: 'object_key', filter: "status <> 'DIHAPUS'" },
  { nama: 'Dokumen kontrak', tabel: 'contract_documents', kolomKunci: 'object_key' },
  { nama: 'Selfie absensi', tabel: 'attendance_selfies', kolomKunci: 'storage_key', filter: 'purged_at IS NULL' },
];

export interface HasilTarget {
  nama: string;
  total: number;
  /** Jumlah per versi kunci (kunci = id, 'lama' = format tanpa awalan). */
  perVersi: Record<string, number>;
  diubah: number;
  gagalDekripsi: number;
  berubahSerentak: number;
  hilang: number;
}
export interface Ringkasan {
  perintah: Perintah;
  kunciAktif: number;
  kering: boolean;
  hasil: HasilTarget[];
  /** true bila semua data sudah berversi aktif (untuk verifikasi: terbukti terbaca hanya dengan kunci aktif). */
  bersih: boolean;
}
export interface OpsiRotasi {
  pool: Pool;
  kunci: KunciEnkripsi;
  storage: ObjectStorage;
  perintah: Perintah;
  batas?: number;
  /** Jeda (ms) setelah tiap batch agar rotasi tidak menghabiskan I/O saat aplikasi melayani lalu lintas. Bawaan 0. */
  jedaMs?: number;
  kering?: boolean;
  log?: (pesan: string) => void;
}

export async function pastikanPeranBypass(pool: Pool): Promise<void> {
  const r = (await pool.query(`SELECT rolsuper OR rolbypassrls AS lolos FROM pg_roles WHERE rolname = current_user`)).rows[0];
  if (!r?.lolos) throw new Error('Role basis data rotasi harus superuser atau BYPASSRLS (RLS dipaksa; role aplikasi tidak melihat data lintas perusahaan)');
}

const kosong = (nama: string): HasilTarget => ({ nama, total: 0, perVersi: {}, diubah: 0, gagalDekripsi: 0, berubahSerentak: 0, hilang: 0 });
const tambah = (h: HasilTarget, kunci: string) => { h.perVersi[kunci] = (h.perVersi[kunci] ?? 0) + 1; };
const ident = (s: string) => { if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error('Identifier tidak valid'); return `"${s}"`; };

export async function jalankanRotasi(o: OpsiRotasi): Promise<Ringkasan> {
  await pastikanPeranBypass(o.pool);
  const log = o.log ?? (() => undefined);
  const jeda = () => (o.jedaMs && o.perintah === 'jalan' ? new Promise<void>((r) => setTimeout(r, o.jedaMs)) : Promise.resolve());
  const batas = o.batas ?? 500;
  const aktif = o.kunci.aktif;
  // Verifikasi membuktikan data terbaca HANYA dengan kunci aktif (kunci lama aman dibuang).
  const cincinBaca = o.perintah === 'verifikasi' ? cincinKunci([{ id: aktif, kunci: o.kunci.kunci.get(aktif)! }]) : o.kunci;
  const hasil: HasilTarget[] = [];

  const klasifikasi = (data: Buffer, aad: string, h: HasilTarget): { perlu: boolean; isi?: Buffer } => {
    try {
      const d = dekripsiBerversi(data, cincinBaca, aad);
      tambah(h, d.lama ? 'lama' : String(d.versi));
      return { perlu: d.lama || d.versi !== aktif, isi: d.isi };
    } catch {
      h.gagalDekripsi++;
      return { perlu: false };
    }
  };

  for (const t of TARGET_DB) {
    const h = kosong(t.nama);
    let terakhir = '00000000-0000-0000-0000-000000000000';
    for (;;) {
      const kolomEkstra = (t.ekstra ?? []).map(ident).join(', ');
      const r = await o.pool.query(
        `SELECT id, ${ident(t.kolom)} AS nilai${kolomEkstra ? `, ${kolomEkstra}` : ''} FROM ${ident(t.tabel)} WHERE ${ident(t.kolom)} IS NOT NULL AND id > $1 ORDER BY id LIMIT $2`,
        [terakhir, batas],
      );
      if (!r.rowCount) break;
      for (const row of r.rows) {
        terakhir = row.id as string;
        h.total++;
        const k = klasifikasi(row.nilai as Buffer, t.aad(row), h);
        if (o.perintah === 'jalan' && k.perlu && k.isi) {
          if (o.kering) { h.diubah++; continue; }
          const baru = enkripsi(k.isi, o.kunci, t.aad(row));
          const set = `${ident(t.kolom)} = $2${t.kolomVersi ? `, ${ident(t.kolomVersi)} = $4` : ''}`;
          const u = await o.pool.query(`UPDATE ${ident(t.tabel)} SET ${set} WHERE id = $1 AND ${ident(t.kolom)} = $3`, t.kolomVersi ? [row.id, baru, row.nilai, aktif] : [row.id, baru, row.nilai]);
          if (u.rowCount) h.diubah++; else h.berubahSerentak++;
        }
      }
      log(`${t.nama}: ${h.total} diperiksa, ${h.diubah} diubah`);
      await jeda();
    }
    hasil.push(h);
  }

  for (const t of TARGET_OBJEK) {
    const h = kosong(t.nama);
    let terakhir = '00000000-0000-0000-0000-000000000000';
    for (;;) {
      const r = await o.pool.query(
        `SELECT id, ${ident(t.kolomKunci)} AS kunci FROM ${ident(t.tabel)} WHERE id > $1${t.filter ? ` AND ${t.filter}` : ''} ORDER BY id LIMIT $2`,
        [terakhir, batas],
      );
      if (!r.rowCount) break;
      for (const row of r.rows) {
        terakhir = row.id as string;
        h.total++;
        const kunciObjek = row.kunci as string;
        let data: Buffer;
        try {
          data = await o.storage.baca(kunciObjek);
        } catch (e) {
          if (e instanceof ObjekTidakDitemukan) { h.hilang++; continue; }
          h.gagalDekripsi++; // kunci objek tidak valid/tidak terbaca: butuh perhatian operator, jangan menghentikan seluruh rotasi
          continue;
        }
        const aad = `berkas:${kunciObjek}`;
        const k = klasifikasi(data, aad, h);
        if (o.perintah === 'jalan' && k.perlu && k.isi) {
          if (o.kering) { h.diubah++; continue; }
          try {
            await o.storage.timpa(kunciObjek, enkripsi(k.isi, o.kunci, aad));
            h.diubah++;
          } catch (e) {
            if (e instanceof ObjekTidakDitemukan) h.hilang++; else h.gagalDekripsi++;
          }
        }
      }
      log(`${t.nama}: ${h.total} diperiksa, ${h.diubah} diubah`);
      await jeda();
    }
    hasil.push(h);
  }

  const bersih = hasil.every((h) => h.gagalDekripsi === 0 && Object.keys(h.perVersi).every((v) => v === String(aktif)));
  if (o.perintah === 'jalan' && !o.kering) {
    // Catatan teknis (kategori TEKNIS lewat awalan system.): hanya hitungan, tanpa nilai.
    await o.pool.query(`INSERT INTO audit_logs (action, object_type, detail) VALUES ('system.key_rotation.run', 'encryption_key', $1)`, [
      JSON.stringify({ kunciAktif: aktif, diubah: hasil.reduce((a, h) => a + h.diubah, 0), gagal: hasil.reduce((a, h) => a + h.gagalDekripsi, 0) }),
    ]);
  }
  return { perintah: o.perintah, kunciAktif: aktif, kering: Boolean(o.kering), hasil, bersih };
}
