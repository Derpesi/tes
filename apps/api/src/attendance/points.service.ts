import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { PoolClient } from 'pg';
import * as QRCode from 'qrcode';
import { z } from 'zod';
import { decodeKursor, encodeKursor } from '../admin/kursor';
import { AuditService } from '../audit/audit.service';
import { ScopedDb } from '../database/scoped-db';
import type { Akses } from '../rbac/akses.service';
import { DaftarTitikQuery } from './schemas';

const TDK = () => new NotFoundException({ kode: 'TITIK_TIDAK_DITEMUKAN', message: 'Titik absensi tidak ditemukan' });
const konflik = (kode: string, message: string) => new ConflictException({ kode, message });
type Baris = Record<string, unknown>;

const KOLOM = `t.id, t.company_id, t.location_id, t.public_code, t.status, t.created_by, t.created_at, t.created_at::text AS created_at_txt, t.updated_at, l.name AS location_name, l.latitude, l.longitude, l.geofence_radius_m`;
const peta = (r: Baris) => ({
  id: r.id, companyId: r.company_id, locationId: r.location_id, locationName: r.location_name, publicCode: r.public_code, status: r.status,
  geofenceRadiusM: r.geofence_radius_m, hasCoordinates: r.latitude !== null, createdAt: r.created_at, updatedAt: r.updated_at,
});

/** Alamat yang dikodekan dalam QR. QR hanya PENGENAL titik (bukan rahasia): keamanan ada pada sesi member, geofence, dan selfie. */
export const urlTitik = (baseUrl: string, kode: string) => `${baseUrl}/absen?t=${kode}`;

/**
 * Titik absensi: satu titik aktif per lokasi rekanan. Kode publik dapat diganti (kode lama langsung tidak berlaku). Scope perusahaan: RLS.
 */
@Injectable()
export class PointsService {
  constructor(
    private readonly sdb: ScopedDb,
    private readonly audit: AuditService,
  ) {}

  private tx<T>(a: Akses, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    return this.sdb.tx({ companyIds: a.companyIds }, fn);
  }
  private async muat(c: PoolClient, id: string, kunci = false): Promise<Baris> {
    const r = await c.query(`SELECT ${KOLOM} FROM attendance_points t JOIN partner_locations l ON l.id = t.location_id WHERE t.id = $1 ${kunci ? 'FOR UPDATE OF t' : ''}`, [id]);
    if (!r.rowCount) throw TDK();
    return r.rows[0];
  }

  async daftar(a: Akses, q: z.infer<typeof DaftarTitikQuery>) {
    const k = decodeKursor(q.cursor);
    return this.tx(a, async (c) => {
      const r = await c.query(
        `SELECT ${KOLOM} FROM attendance_points t JOIN partner_locations l ON l.id = t.location_id
          WHERE ($1::uuid IS NULL OR t.location_id = $1) AND ($2::text IS NULL OR t.status = $2)
            AND ($3::timestamptz IS NULL OR (t.created_at, t.id) < ($3::timestamptz, $4::uuid))
          ORDER BY t.created_at DESC, t.id DESC LIMIT $5`,
        [q.locationId ?? null, q.status ?? null, k?.t ?? null, k?.id ?? null, q.limit + 1],
      );
      const ada = r.rows.length > q.limit;
      const baris = r.rows.slice(0, q.limit);
      return { items: baris.map(peta), nextCursor: ada ? encodeKursor({ t: baris[baris.length - 1].created_at_txt, id: baris[baris.length - 1].id }) : null };
    });
  }

  async detail(a: Akses, id: string) {
    return this.tx(a, async (c) => peta(await this.muat(c, id)));
  }

  async buat(a: Akses, locationId: string) {
    const hasil = await this.tx(a, async (c) => {
      const l = await c.query(`SELECT company_id, latitude, status FROM partner_locations WHERE id = $1`, [locationId]);
      if (!l.rowCount) throw new NotFoundException({ kode: 'LOKASI_TIDAK_DITEMUKAN', message: 'Lokasi tidak ditemukan' });
      if (l.rows[0].status !== 'AKTIF') throw konflik('LOKASI_NONAKTIF', 'Lokasi tidak aktif');
      if (l.rows[0].latitude === null) throw konflik('KOORDINAT_LOKASI_KOSONG', 'Lokasi belum memiliki koordinat; lengkapi koordinat dan radius lokasi lebih dulu');
      try {
        const id = (await c.query(`INSERT INTO attendance_points (company_id, location_id, created_by) VALUES ($1, $2, $3) RETURNING id`, [l.rows[0].company_id, locationId, a.userId])).rows[0].id;
        return await this.muat(c, id);
      } catch (e) {
        if ((e as { constraint?: string }).constraint === 'attendance_points_satu_aktif_per_lokasi') throw konflik('TITIK_SUDAH_ADA', 'Lokasi ini sudah memiliki titik absensi aktif');
        throw e;
      }
    });
    await this.audit.catat({ aksi: 'attendance.point.created', aktorId: a.userId, companyId: hasil.company_id as string, objek: 'attendance_point', objekId: hasil.id as string });
    return peta(hasil);
  }

  async nonaktifkan(a: Akses, id: string) {
    const p = await this.tx(a, async (c) => {
      const cur = await this.muat(c, id, true);
      const r = await c.query(`UPDATE attendance_points SET status = 'NONAKTIF', updated_at = now() WHERE id = $1 AND status = 'AKTIF'`, [id]);
      if (!r.rowCount) throw konflik('TRANSISI_TIDAK_VALID', 'Titik sudah nonaktif');
      return cur;
    });
    await this.audit.catat({ aksi: 'attendance.point.deactivated', aktorId: a.userId, companyId: p.company_id as string, objek: 'attendance_point', objekId: id });
    return { status: 'NONAKTIF' };
  }

  /** Mengganti kode publik (mis. QR bocor/rusak). Kode lama seketika tidak dikenali. */
  async gantiKode(a: Akses, id: string) {
    const p = await this.tx(a, async (c) => {
      const cur = await this.muat(c, id, true);
      if (cur.status !== 'AKTIF') throw konflik('TITIK_NONAKTIF', 'Titik nonaktif tidak dapat diganti kodenya');
      await c.query(`UPDATE attendance_points SET public_code = gen_random_uuid(), updated_at = now() WHERE id = $1`, [id]);
      return this.muat(c, id);
    });
    await this.audit.catat({ aksi: 'attendance.point.code_rotated', aktorId: a.userId, companyId: p.company_id as string, objek: 'attendance_point', objekId: id });
    return peta(p);
  }

  /** PDF poster QR (dibangkitkan sesuai permintaan, tidak disimpan); pencetakan diaudit. */
  async qrPdf(a: Akses, id: string, baseUrl: string): Promise<Buffer> {
    const p = await this.tx(a, async (c) => {
      const cur = await this.muat(c, id);
      if (cur.status !== 'AKTIF') throw konflik('TITIK_NONAKTIF', 'Titik nonaktif tidak dapat dicetak');
      return cur;
    });
    const png = await QRCode.toBuffer(urlTitik(baseUrl, p.public_code as string), { errorCorrectionLevel: 'M', margin: 2, width: 600, type: 'png' });
    const pdf = await PDFDocument.create();
    const halaman = pdf.addPage([595.28, 841.89]);
    const tebal = await pdf.embedFont(StandardFonts.HelveticaBold);
    const biasa = await pdf.embedFont(StandardFonts.Helvetica);
    const aman = (t: string) => [...t].map((ch) => (ch.codePointAt(0)! < 256 ? ch : '?')).join('');
    const tengah = (t: string, y: number, f: typeof biasa, ukuran: number) => halaman.drawText(t, { x: (595.28 - f.widthOfTextAtSize(t, ukuran)) / 2, y, size: ukuran, font: f, color: rgb(0.05, 0.12, 0.3) });
    tengah('ABSENSI KARYAWAN', 760, tebal, 26);
    tengah(aman(String(p.location_name)).slice(0, 60), 722, biasa, 16);
    const gambar = await pdf.embedPng(png);
    halaman.drawImage(gambar, { x: (595.28 - 360) / 2, y: 330, width: 360, height: 360 });
    tengah('Pindai dengan kamera ponsel, lalu login sebagai member.', 300, biasa, 12);
    tengah('Hanya karyawan dengan penempatan aktif di lokasi ini yang dapat absen.', 282, biasa, 12);
    tengah(`Kode titik: ${String(p.public_code).slice(0, 8).toUpperCase()}`, 240, biasa, 11);
    tengah('QR ini hanya pengenal titik. Jangan percaya QR yang ditempel orang lain di luar lokasi.', 60, biasa, 9);
    const data = Buffer.from(await pdf.save());
    await this.audit.catat({ aksi: 'attendance.point.qr_printed', aktorId: a.userId, companyId: p.company_id as string, objek: 'attendance_point', objekId: id });
    return data;
  }
}
