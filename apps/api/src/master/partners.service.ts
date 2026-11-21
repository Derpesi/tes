import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { decodeKursor, encodeKursor } from '../admin/kursor';
import { AuditService } from '../audit/audit.service';
import { ScopedDb } from '../database/scoped-db';
import type { Akses } from '../rbac/akses.service';
import { KebutuhanBuat, KontakBuat, KontakUbah, LokasiBuat, LokasiUbah, RekananBuat, RekananUbah } from './schemas';

const TDK_REKANAN = () => new NotFoundException({ kode: 'REKANAN_TIDAK_DITEMUKAN', message: 'Rekanan tidak ditemukan' });
const TDK_KONTAK = () => new NotFoundException({ kode: 'KONTAK_TIDAK_DITEMUKAN', message: 'Kontak tidak ditemukan' });
const TDK_LOKASI = () => new NotFoundException({ kode: 'LOKASI_TIDAK_DITEMUKAN', message: 'Lokasi tidak ditemukan' });

/** Memetakan pelanggaran constraint database ke galat HTTP berpesan Indonesia. */
function petakan(e: unknown, daftar: Record<string, Error>): never {
  const k = (e as { constraint?: string }).constraint;
  if (k && daftar[k]) throw daftar[k];
  throw e;
}
const konflik = (kode: string, message: string) => new ConflictException({ kode, message });

type Nilai = Record<string, unknown>;
/** Menyusun SET dinamis dari bidang yang dikirim (kunci diambil dari daftar tetap, bukan dari input). */
function susunSet(peta: Record<string, string>, b: Nilai, awal: number): { sets: string[]; nilai: unknown[] } {
  const sets: string[] = [];
  const nilai: unknown[] = [];
  for (const [k, kolom] of Object.entries(peta)) {
    if (k in b) {
      nilai.push(b[k] ?? null);
      sets.push(`${kolom} = $${awal + nilai.length - 1}`);
    }
  }
  return { sets, nilai };
}

const KOLOM_REKANAN = `id, company_id, name, legal_name, address, city, province, service_types, status, notes, created_at, created_at::text AS created_at_txt, updated_at`;
const petaRekanan = (r: Nilai) => ({
  id: r.id, companyId: r.company_id, name: r.name, legalName: r.legal_name, address: r.address, city: r.city, province: r.province,
  serviceTypes: r.service_types, status: r.status, notes: r.notes, createdAt: r.created_at, updatedAt: r.updated_at,
});
const petaKontak = (r: Nilai) => ({ id: r.id, partnerId: r.partner_id, name: r.name, roleTitle: r.role_title, phone: r.phone, email: r.email, isPrimary: r.is_primary, status: r.status, createdAt: r.created_at });
const KOLOM_LOKASI = `id, company_id, partner_id, name, address, city, province, latitude::float8 AS latitude, longitude::float8 AS longitude, geofence_radius_m, status, notes, created_at, updated_at`;
const petaLokasi = (r: Nilai) => ({
  id: r.id, partnerId: r.partner_id, name: r.name, address: r.address, city: r.city, province: r.province, latitude: r.latitude, longitude: r.longitude,
  geofenceRadiusM: r.geofence_radius_m, status: r.status, notes: r.notes, createdAt: r.created_at, updatedAt: r.updated_at,
});
const petaKebutuhan = (r: Nilai) => ({ id: r.id, locationId: r.location_id, position: r.position, headcount: r.headcount, validFrom: r.valid_from, validTo: r.valid_to, notes: r.notes, createdAt: r.created_at });

/**
 * Rekanan, kontak (PIC), lokasi kerja, dan kebutuhan tenaga kerja. Rekanan hanyalah master data internal (tanpa akun/login).
 * Isolasi: semua query berjalan di ScopedDb (RLS). company_id anak SELALU diturunkan dari baris induk yang terlihat oleh RLS,
 * sehingga ID perusahaan lain (atau tebakan ID) hanya menghasilkan 404, dan company_id tidak pernah berasal dari input bebas.
 */
@Injectable()
export class PartnersService {
  constructor(
    private readonly sdb: ScopedDb,
    private readonly audit: AuditService,
  ) {}

  private tx<T>(a: Akses, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    return this.sdb.tx({ companyIds: a.companyIds }, fn);
  }

  /** Induk harus terlihat (RLS) dan, bila diminta, AKTIF; mengembalikan company_id turunan. */
  private async induk(c: PoolClient, tabel: 'partners' | 'partner_locations', id: string, galat: () => Error, wajibAktif = false): Promise<string> {
    const r = await c.query(`SELECT company_id, status FROM ${tabel} WHERE id = $1`, [id]);
    if (!r.rowCount) throw galat();
    if (wajibAktif && r.rows[0].status !== 'AKTIF') throw new ConflictException({ kode: 'INDUK_NONAKTIF', message: 'Data induk sudah nonaktif' });
    return r.rows[0].company_id as string;
  }

  // ---------- rekanan ----------
  async daftarRekanan(a: Akses, q: { companyId?: string; status?: string; cursor?: string; limit: number }) {
    const k = decodeKursor(q.cursor);
    return this.tx(a, async (c) => {
      const r = await c.query(
        `SELECT ${KOLOM_REKANAN} FROM partners
          WHERE ($1::uuid IS NULL OR company_id = $1) AND ($2::text IS NULL OR status = $2)
            AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::uuid))
          ORDER BY created_at DESC, id DESC LIMIT $5`,
        [q.companyId ?? null, q.status ?? null, k?.t ?? null, k?.id ?? null, q.limit + 1],
      );
      const ada = r.rows.length > q.limit;
      const baris = r.rows.slice(0, q.limit);
      return { items: baris.map(petaRekanan), nextCursor: ada ? encodeKursor({ t: baris[baris.length - 1].created_at_txt, id: baris[baris.length - 1].id }) : null };
    });
  }

  async detailRekanan(a: Akses, id: string) {
    return this.tx(a, async (c) => {
      const r = await c.query(`SELECT ${KOLOM_REKANAN} FROM partners WHERE id = $1`, [id]);
      if (!r.rowCount) throw TDK_REKANAN();
      return petaRekanan(r.rows[0]);
    });
  }

  async buatRekanan(a: Akses, b: z.infer<typeof RekananBuat>) {
    // company_id berasal dari scope pengguna: bila tidak dikirim dan scope tepat satu perusahaan, dipakai itu; selain itu wajib salah satu dari scope.
    const companyId = b.companyId ?? (a.companyIds.length === 1 ? a.companyIds[0] : undefined);
    if (!companyId) throw new BadRequestException({ kode: 'PERUSAHAAN_WAJIB', message: 'Pilih perusahaan pengelola rekanan' });
    if (!a.companyIds.includes(companyId)) throw new NotFoundException({ kode: 'PERUSAHAAN_TIDAK_DITEMUKAN', message: 'Perusahaan tidak ditemukan' });
    const hasil = await this.tx(a, async (c) => {
      try {
        const r = await c.query(
          `INSERT INTO partners (company_id, name, legal_name, address, city, province, service_types, notes, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${KOLOM_REKANAN}`,
          [companyId, b.name, b.legalName ?? null, b.address ?? null, b.city ?? null, b.province ?? null, b.serviceTypes ?? [], b.notes ?? null, a.userId],
        );
        return petaRekanan(r.rows[0]);
      } catch (e) {
        return petakan(e, { partners_nama_aktif_unik: konflik('REKANAN_SUDAH_ADA', 'Rekanan aktif dengan nama yang sama sudah ada di perusahaan ini') });
      }
    });
    await this.audit.catat({ aksi: 'master.partner.created', aktorId: a.userId, companyId, objek: 'partner', objekId: hasil.id as string });
    return hasil;
  }

  async ubahRekanan(a: Akses, id: string, b: z.infer<typeof RekananUbah>) {
    const { sets, nilai } = susunSet({ name: 'name', legalName: 'legal_name', address: 'address', city: 'city', province: 'province', serviceTypes: 'service_types', notes: 'notes' }, b, 2);
    const hasil = await this.tx(a, async (c) => {
      try {
        const r = await c.query(`UPDATE partners SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING ${KOLOM_REKANAN}`, [id, ...nilai]);
        if (!r.rowCount) throw TDK_REKANAN();
        return petaRekanan(r.rows[0]);
      } catch (e) {
        return petakan(e, { partners_nama_aktif_unik: konflik('REKANAN_SUDAH_ADA', 'Rekanan aktif dengan nama yang sama sudah ada di perusahaan ini') });
      }
    });
    await this.audit.catat({ aksi: 'master.partner.updated', aktorId: a.userId, companyId: hasil.companyId as string, objek: 'partner', objekId: id, detail: { bidang: Object.keys(b) } });
    return hasil;
  }

  /** Nonaktif tidak menghapus riwayat: kontak, lokasi, kontrak tetap ada. */
  async nonaktifkanRekanan(a: Akses, id: string) {
    const companyId = await this.tx(a, async (c) => {
      const r = await c.query(`UPDATE partners SET status = 'NONAKTIF', updated_at = now() WHERE id = $1 AND status = 'AKTIF' RETURNING company_id`, [id]);
      if (r.rowCount) return r.rows[0].company_id as string;
      if (!(await c.query(`SELECT 1 FROM partners WHERE id = $1`, [id])).rowCount) throw TDK_REKANAN();
      throw konflik('REKANAN_SUDAH_NONAKTIF', 'Rekanan sudah nonaktif');
    });
    await this.audit.catat({ aksi: 'master.partner.deactivated', aktorId: a.userId, companyId, objek: 'partner', objekId: id });
  }

  // ---------- kontak ----------
  async daftarKontak(a: Akses, partnerId: string) {
    return this.tx(a, async (c) => {
      await this.induk(c, 'partners', partnerId, TDK_REKANAN);
      const r = await c.query(`SELECT id, partner_id, name, role_title, phone, email, is_primary, status, created_at FROM partner_contacts WHERE partner_id = $1 ORDER BY created_at DESC, id DESC LIMIT 200`, [partnerId]);
      return { items: r.rows.map(petaKontak) };
    });
  }

  async buatKontak(a: Akses, partnerId: string, b: z.infer<typeof KontakBuat>) {
    const { companyId, hasil } = await this.tx(a, async (c) => {
      const companyId = await this.induk(c, 'partners', partnerId, TDK_REKANAN, true);
      if (b.isPrimary) await c.query(`UPDATE partner_contacts SET is_primary = false WHERE partner_id = $1 AND is_primary`, [partnerId]);
      const r = await c.query(
        `INSERT INTO partner_contacts (company_id, partner_id, name, role_title, phone, email, is_primary) VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, partner_id, name, role_title, phone, email, is_primary, status, created_at`,
        [companyId, partnerId, b.name, b.roleTitle ?? null, b.phone ?? null, b.email ?? null, b.isPrimary ?? false],
      );
      return { companyId, hasil: petaKontak(r.rows[0]) };
    });
    await this.audit.catat({ aksi: 'master.partner_contact.created', aktorId: a.userId, companyId, objek: 'partner_contact', objekId: hasil.id as string });
    return hasil;
  }

  async ubahKontak(a: Akses, partnerId: string, kontakId: string, b: z.infer<typeof KontakUbah>) {
    const { sets, nilai } = susunSet({ name: 'name', roleTitle: 'role_title', phone: 'phone', email: 'email', isPrimary: 'is_primary' }, b, 3);
    const { companyId, hasil } = await this.tx(a, async (c) => {
      if (b.isPrimary) await c.query(`UPDATE partner_contacts SET is_primary = false WHERE partner_id = $1 AND is_primary AND id <> $2`, [partnerId, kontakId]);
      const r = await c.query(
        `UPDATE partner_contacts SET ${sets.join(', ')} WHERE id = $1 AND partner_id = $2 RETURNING company_id, id, partner_id, name, role_title, phone, email, is_primary, status, created_at`,
        [kontakId, partnerId, ...nilai],
      );
      if (!r.rowCount) throw TDK_KONTAK();
      return { companyId: r.rows[0].company_id as string, hasil: petaKontak(r.rows[0]) };
    });
    await this.audit.catat({ aksi: 'master.partner_contact.updated', aktorId: a.userId, companyId, objek: 'partner_contact', objekId: kontakId, detail: { bidang: Object.keys(b) } });
    return hasil;
  }

  async nonaktifkanKontak(a: Akses, partnerId: string, kontakId: string) {
    const companyId = await this.tx(a, async (c) => {
      const r = await c.query(`UPDATE partner_contacts SET status = 'NONAKTIF', is_primary = false WHERE id = $1 AND partner_id = $2 AND status = 'AKTIF' RETURNING company_id`, [kontakId, partnerId]);
      if (!r.rowCount) throw TDK_KONTAK();
      return r.rows[0].company_id as string;
    });
    await this.audit.catat({ aksi: 'master.partner_contact.deactivated', aktorId: a.userId, companyId, objek: 'partner_contact', objekId: kontakId });
  }

  // ---------- lokasi ----------
  async daftarLokasi(a: Akses, partnerId: string) {
    return this.tx(a, async (c) => {
      await this.induk(c, 'partners', partnerId, TDK_REKANAN);
      const r = await c.query(`SELECT ${KOLOM_LOKASI} FROM partner_locations WHERE partner_id = $1 ORDER BY created_at DESC, id DESC LIMIT 200`, [partnerId]);
      return { items: r.rows.map(petaLokasi) };
    });
  }

  async detailLokasi(a: Akses, lokasiId: string) {
    return this.tx(a, async (c) => {
      const r = await c.query(`SELECT ${KOLOM_LOKASI} FROM partner_locations WHERE id = $1`, [lokasiId]);
      if (!r.rowCount) throw TDK_LOKASI();
      return petaLokasi(r.rows[0]);
    });
  }

  async buatLokasi(a: Akses, partnerId: string, b: z.infer<typeof LokasiBuat>) {
    const { companyId, hasil } = await this.tx(a, async (c) => {
      const companyId = await this.induk(c, 'partners', partnerId, TDK_REKANAN, true);
      try {
        const r = await c.query(
          `INSERT INTO partner_locations (company_id, partner_id, name, address, city, province, latitude, longitude, geofence_radius_m, notes, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, 100), $10, $11) RETURNING ${KOLOM_LOKASI}`,
          [companyId, partnerId, b.name, b.address ?? null, b.city ?? null, b.province ?? null, b.latitude ?? null, b.longitude ?? null, b.geofenceRadiusM ?? null, b.notes ?? null, a.userId],
        );
        return { companyId, hasil: petaLokasi(r.rows[0]) };
      } catch (e) {
        return petakan(e, { partner_locations_nama_aktif_unik: konflik('LOKASI_SUDAH_ADA', 'Lokasi aktif dengan nama yang sama sudah ada pada rekanan ini') });
      }
    });
    await this.audit.catat({ aksi: 'master.partner_location.created', aktorId: a.userId, companyId, objek: 'partner_location', objekId: hasil.id as string });
    return hasil;
  }

  async ubahLokasi(a: Akses, lokasiId: string, b: z.infer<typeof LokasiUbah>) {
    const { sets, nilai } = susunSet({ name: 'name', address: 'address', city: 'city', province: 'province', latitude: 'latitude', longitude: 'longitude', geofenceRadiusM: 'geofence_radius_m', notes: 'notes' }, b, 2);
    const hasil = await this.tx(a, async (c) => {
      try {
        const r = await c.query(`UPDATE partner_locations SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING ${KOLOM_LOKASI}`, [lokasiId, ...nilai]);
        if (!r.rowCount) throw TDK_LOKASI();
        return r.rows[0];
      } catch (e) {
        return petakan(e, { partner_locations_nama_aktif_unik: konflik('LOKASI_SUDAH_ADA', 'Lokasi aktif dengan nama yang sama sudah ada pada rekanan ini') });
      }
    });
    await this.audit.catat({ aksi: 'master.partner_location.updated', aktorId: a.userId, companyId: hasil.company_id, objek: 'partner_location', objekId: lokasiId, detail: { bidang: Object.keys(b) } });
    return petaLokasi(hasil);
  }

  async nonaktifkanLokasi(a: Akses, lokasiId: string) {
    const companyId = await this.tx(a, async (c) => {
      const r = await c.query(`UPDATE partner_locations SET status = 'NONAKTIF', updated_at = now() WHERE id = $1 AND status = 'AKTIF' RETURNING company_id`, [lokasiId]);
      if (r.rowCount) return r.rows[0].company_id as string;
      if (!(await c.query(`SELECT 1 FROM partner_locations WHERE id = $1`, [lokasiId])).rowCount) throw TDK_LOKASI();
      throw konflik('LOKASI_SUDAH_NONAKTIF', 'Lokasi sudah nonaktif');
    });
    await this.audit.catat({ aksi: 'master.partner_location.deactivated', aktorId: a.userId, companyId, objek: 'partner_location', objekId: lokasiId });
  }

  // ---------- kebutuhan tenaga kerja ----------
  async daftarKebutuhan(a: Akses, lokasiId: string) {
    return this.tx(a, async (c) => {
      await this.induk(c, 'partner_locations', lokasiId, TDK_LOKASI);
      const r = await c.query(`SELECT id, location_id, position, headcount, valid_from::text AS valid_from, valid_to::text AS valid_to, notes, created_at FROM manpower_requirements WHERE location_id = $1 ORDER BY valid_from DESC, id DESC LIMIT 200`, [lokasiId]);
      return { items: r.rows.map(petaKebutuhan) };
    });
  }

  async buatKebutuhan(a: Akses, lokasiId: string, b: z.infer<typeof KebutuhanBuat>) {
    const { companyId, hasil } = await this.tx(a, async (c) => {
      const companyId = await this.induk(c, 'partner_locations', lokasiId, TDK_LOKASI, true);
      const r = await c.query(
        `INSERT INTO manpower_requirements (company_id, location_id, position, headcount, valid_from, valid_to, notes, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, location_id, position, headcount, valid_from::text AS valid_from, valid_to::text AS valid_to, notes, created_at`,
        [companyId, lokasiId, b.position, b.headcount, b.validFrom, b.validTo ?? null, b.notes ?? null, a.userId],
      );
      return { companyId, hasil: petaKebutuhan(r.rows[0]) };
    });
    await this.audit.catat({ aksi: 'master.manpower_requirement.created', aktorId: a.userId, companyId, objek: 'manpower_requirement', objekId: hasil.id as string });
    return hasil;
  }
}
