import { createHash, createHmac } from 'node:crypto';
import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { decodeKursor, encodeKursor } from '../admin/kursor';
import { AuditService } from '../audit/audit.service';
import { enkripsiBerkas } from '../common/crypto/pii';
import { buatKunciObjek, OBJECT_STORAGE, ObjectStorage } from '../common/storage/object-storage';
import type { BerkasMasuk } from '../common/storage/upload';
import { KUNCI, Kunci } from '../config/config.module';
import { selfieAktif } from '../config/env';
import { ScopedDb } from '../database/scoped-db';
import { MemberContextService } from '../member/member-context.service';
import { nilaiAnomali } from './anomali';
import { jarakMeter } from './geo';
import { JAM_ABSENSI, JamAbsensi } from './jam';
import { AbsenBody, RiwayatAbsenQuery } from './schemas';
import { JadwalKerja, liburBerlaku, tanggalWib, tentukanShift } from './shift';

export const BATAS_SELFIE_BYTE = 300 * 1024;
export const BATAS_SELFIE_UNGGAH_BYTE = 400 * 1024;
const STATUS_KARYAWAN = ['KARYAWAN_AKTIF', 'KONTRAK_AKAN_BERAKHIR'];
const konflik = (kode: string, message: string) => new ConflictException({ kode, message });
const dilarang = (kode: string, message: string) => new ForbiddenException({ kode, message });

type Masukan = z.infer<typeof AbsenBody>;
type Baris = Record<string, unknown>;
export type StatusAbsen = 'VALID' | 'PERLU_VERIFIKASI' | 'DITOLAK';

const ALASAN_TOLAK: Record<string, string> = {
  SELFIE_WAJIB: 'Selfie wajib diambil langsung dari kamera.',
  SELFIE_TIDAK_VALID: 'Selfie tidak valid. Gunakan foto JPEG dari kamera.',
  SELFIE_TERLALU_BESAR: 'Ukuran selfie melebihi 300 KB.',
  LUAR_RADIUS: 'Anda berada di luar radius lokasi kerja.',
  DUPLIKAT: 'Absen ini sudah tercatat untuk shift yang sama.',
  PERANGKAT_DITOLAK: 'Perangkat ini ditolak oleh petugas. Hubungi petugas absensi.',
};
const ALASAN_VERIFIKASI: Record<string, string> = {
  GPS_TIDAK_TERSEDIA: 'lokasi GPS tidak tersedia',
  AKURASI_BURUK: 'akurasi GPS rendah',
  LOMPATAN_LOKASI: 'perpindahan lokasi tidak wajar',
  KOORDINAT_IDENTIK_BERULANG: 'koordinat identik berulang',
  WAKTU_KLIEN_MENYIMPANG: 'jam perangkat tidak sesuai',
  BANYAK_AKUN_SATU_PERANGKAT: 'perangkat dipakai banyak akun',
  PERANGKAT_BARU: 'perangkat baru',
  TANPA_JADWAL: 'tidak ada jadwal kerja pada waktu ini',
  HARI_LIBUR: 'hari libur',
  PULANG_TANPA_MASUK: 'absen pulang tanpa absen masuk',
};

const jamWib = (d: Date) => new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', hour12: false }).format(d).replace('.', ':');
const bulat6 = (n: number) => Number(n.toFixed(6));

const peta = (r: Baris, flags: string[]) => ({
  id: r.id, kind: r.kind, status: r.status, rejectReason: r.reject_reason, shiftDate: r.shift_date, occurredAt: r.occurred_at, distanceM: r.distance_m === null ? null : Number(r.distance_m), flags,
  message: pesan(r.kind as string, r.status as StatusAbsen, r.reject_reason as string | null, flags, r.occurred_at as Date),
});
function pesan(kind: string, status: StatusAbsen, tolak: string | null, flags: string[], waktu: Date): string {
  const jenis = kind === 'MASUK' ? 'masuk' : 'pulang';
  if (status === 'DITOLAK') return ALASAN_TOLAK[tolak ?? ''] ?? 'Absen ditolak.';
  if (status === 'VALID') return `Absen ${jenis} tercatat pukul ${jamWib(waktu)} WIB.${flags.includes('TERLAMBAT') ? ' Anda tercatat terlambat.' : ''}${flags.includes('PULANG_CEPAT') ? ' Anda tercatat pulang lebih awal.' : ''}`;
  const alasan = flags.filter((f) => ALASAN_VERIFIKASI[f]).map((f) => ALASAN_VERIFIKASI[f]).join(', ');
  return `Absen ${jenis} tercatat pukul ${jamWib(waktu)} WIB dan menunggu verifikasi petugas (${alasan}).`;
}

/**
 * Absen member (online-only). Urutan validasi tetap; WAKTU rekaman = waktu server (jam disuntikkan di tes). Setiap percobaan yang sampai
 * ke tahap penilaian disimpan, termasuk yang DITOLAK (bahan audit dan deteksi anomali). Selfie hanya disimpan terenkripsi; TANPA face recognition.
 * Batas yang dicatat jujur: QR dapat difoto, GPS dapat dipalsukan, dan server tidak dapat membuktikan foto berasal dari kamera.
 */
@Injectable()
export class MemberAttendanceService {
  constructor(
    private readonly sdb: ScopedDb,
    private readonly audit: AuditService,
    private readonly ctx: MemberContextService,
    @Inject(KUNCI) private readonly kunci: Kunci,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(JAM_ABSENSI) private readonly jam: JamAbsensi,
  ) {}

  private hashPerangkat(deviceId: string): string {
    return createHmac('sha256', this.kunci.hmac).update(`device:${deviceId}`).digest('hex');
  }

  private async ambilTerekam(c: PoolClient, personId: string, kunciIdem: string): Promise<ReturnType<typeof peta> | null> {
    const r = await c.query(`SELECT id, kind, status, reject_reason, shift_date::text AS shift_date, occurred_at, distance_m FROM attendance_records WHERE person_id = $1 AND idempotency_key = $2`, [personId, kunciIdem]);
    if (!r.rowCount) return null;
    const f = await c.query(`SELECT code FROM attendance_flags WHERE record_id = $1 ORDER BY score DESC, code`, [r.rows[0].id]);
    return peta(r.rows[0], f.rows.map((x) => x.code as string));
  }

  async absen(userId: string, b: Masukan, selfie: BerkasMasuk | undefined) {
    const personId = await this.ctx.personId(userId);
    return this.proses(personId, b, selfie, false);
  }

  private async proses(personId: string, b: Masukan, selfie: BerkasMasuk | undefined, paksaDuplikat: boolean): Promise<{ replay: boolean; hasil: ReturnType<typeof peta>; companyId?: string; pointId?: string }> {
    const sekarang = this.jam();
    let kunciObjekSelfie: string | null = null;
    try {
      const keluar = await this.sdb.tx({ companyIds: [], memberPersonId: personId }, async (c) => {
        // 1. Idempotensi: pengulangan kunci yang sama mengembalikan hasil awal tanpa rekaman ganda.
        const ada = await this.ambilTerekam(c, personId, b.idempotencyKey);
        if (ada) return { replay: true, hasil: ada };

        // 2. Hanya karyawan aktif.
        const m = await c.query(`SELECT status FROM member_profiles WHERE person_id = $1`, [personId]);
        if (!STATUS_KARYAWAN.includes(m.rows[0]?.status as string)) throw dilarang('BUKAN_KARYAWAN_AKTIF', 'Absensi hanya untuk karyawan dengan kontrak aktif');

        // 3. Titik.
        await c.query(`SELECT set_config('app.titik_kode', $1, true)`, [b.code]); // dibaca kebijakan RLS titik_baca_kode (hanya kode yang sama persis)
        const t = await c.query(`SELECT id, company_id, location_id, status FROM attendance_points WHERE public_code = $1`, [b.code]);
        if (!t.rowCount) throw new NotFoundException({ kode: 'TITIK_TIDAK_DITEMUKAN', message: 'Titik absensi tidak dikenal. Pindai ulang QR di lokasi kerja' });
        const titik = t.rows[0];
        if (titik.status !== 'AKTIF') throw konflik('TITIK_NONAKTIF', 'Titik absensi ini sudah tidak aktif. Minta QR terbaru kepada petugas');

        // 4. Penempatan aktif di lokasi titik dan kontrak aktif.
        const hari = tanggalWib(sekarang);
        const p = await c.query(
          `SELECT p.id FROM placements p JOIN employment_contracts k ON k.id = p.contract_id
            WHERE p.person_id = $1 AND p.location_id = $2 AND p.company_id = $3 AND p.status = 'AKTIF' AND k.status = 'AKTIF'
              AND p.start_date <= $4::date AND (p.end_date IS NULL OR p.end_date >= $5::date)`,
          [personId, titik.location_id, titik.company_id, hari, tanggalWib(sekarang, -1)],
        );
        if (!p.rowCount) throw dilarang('TIDAK_DITEMPATKAN_DI_LOKASI_INI', 'Anda tidak memiliki penempatan aktif di lokasi ini');
        const placementId = p.rows[0].id as string;

        const lok = (await c.query(`SELECT latitude, longitude, geofence_radius_m, attendance_late_tolerance_min AS terlambat, attendance_early_tolerance_min AS awal FROM partner_locations WHERE id = $1`, [titik.location_id])).rows[0];
        if (!lok || lok.latitude === null) throw konflik('KOORDINAT_LOKASI_KOSONG', 'Lokasi kerja belum memiliki koordinat. Hubungi petugas');

        // 5. Jadwal, hari libur, dan tanggal-shift.
        const j = await c.query(
          `SELECT w.work_days, w.valid_from::text AS valid_from, w.valid_to::text AS valid_to, s.id, s.kind, to_char(s.start_time, 'HH24:MI') AS mulai, to_char(s.end_time, 'HH24:MI') AS selesai,
                  s.crosses_midnight, s.late_tolerance_min, s.early_tolerance_min
             FROM work_schedules w JOIN shift_patterns s ON s.id = w.shift_id WHERE w.placement_id = $1 AND s.status = 'AKTIF'`,
          [placementId],
        );
        const jadwal: JadwalKerja[] = j.rows.map((r) => ({
          shift: { id: r.id, mulai: r.mulai, selesai: r.selesai, menyeberangTengahMalam: r.crosses_midnight, toleransiTerlambatMenit: r.late_tolerance_min, toleransiAwalMenit: r.early_tolerance_min, fleksibel: r.kind === 'FLEXIBLE' },
          hariKerja: (r.work_days as number[]).map(Number), berlakuDari: r.valid_from, berlakuSampai: r.valid_to,
        }));
        const hs = tentukanShift(sekarang, b.kind, jadwal, { terlambat: lok.terlambat, awal: lok.awal });
        const tanggalShift = hs?.tanggalShift ?? hari;
        const flags = new Map<string, number>(); // kode -> skor
        for (const f of hs?.bendera ?? []) flags.set(f, 0);
        if (!hs) flags.set('TANPA_JADWAL', 20);
        const libur = await c.query(`SELECT holiday_date::text AS tanggal, scope, location_id, name FROM holidays WHERE company_id = $1 AND holiday_date = $2::date`, [titik.company_id, tanggalShift]);
        if (liburBerlaku(tanggalShift, libur.rows.map((r) => ({ tanggal: r.tanggal, cakupan: r.scope, lokasiId: r.location_id, nama: r.name })), titik.location_id)) flags.set('HARI_LIBUR', 20);
        if (b.kind === 'PULANG') {
          const masuk = await c.query(`SELECT 1 FROM attendance_records WHERE person_id = $1 AND kind = 'MASUK' AND shift_date = $2::date AND status <> 'DITOLAK' LIMIT 1`, [personId, tanggalShift]);
          if (!masuk.rowCount) flags.set('PULANG_TANPA_MASUK', 20);
        }

        // 6. Penilaian: urutan tetap. Penolakan pertama yang cocok menang.
        const lat = bulat6(b.latitude);
        const lng = bulat6(b.longitude);
        const jarak = jarakMeter(lat, lng, Number(lok.latitude), Number(lok.longitude));
        let tolak: string | null = null;
        // Selfie ditiadakan sementara (ABSENSI_SELFIE=off, bawaan): berkas yang terkirim diabaikan, tidak divalidasi maupun disimpan.
        const pakaiSelfie = selfieAktif();
        const foto = pakaiSelfie ? selfie?.buffer : undefined;
        if (pakaiSelfie && (!foto || foto.length === 0)) tolak = 'SELFIE_WAJIB';
        else if (foto && foto.length > BATAS_SELFIE_BYTE) tolak = 'SELFIE_TERLALU_BESAR';
        else if (foto && !(foto.length >= 3 && foto[0] === 0xff && foto[1] === 0xd8 && foto[2] === 0xff)) tolak = 'SELFIE_TIDAK_VALID';
        else if (jarak > Number(lok.geofence_radius_m)) tolak = 'LUAR_RADIUS';
        if (!tolak) {
          const dup = paksaDuplikat || (await c.query(`SELECT 1 FROM attendance_records WHERE person_id = $1 AND point_id = $2 AND kind = $3 AND shift_date = $4::date AND status <> 'DITOLAK'`, [personId, titik.id, b.kind, tanggalShift])).rowCount;
          if (dup) tolak = 'DUPLIKAT';
        }

        // 7. Perangkat (id acak klien disimpan sebagai HMAC). Perangkat pertama otomatis disetujui; tambahan perlu verifikasi.
        const hash = this.hashPerangkat(b.deviceId);
        const punya = await c.query(`SELECT 1 FROM device_registrations WHERE person_id = $1 AND company_id = $2 LIMIT 1`, [personId, titik.company_id]);
        const dv = await c.query(
          `INSERT INTO device_registrations (company_id, person_id, device_hash, status) VALUES ($1, $2, $3, $4)
           ON CONFLICT (company_id, person_id, device_hash) DO UPDATE SET last_seen_at = now() RETURNING id, status`,
          [titik.company_id, personId, hash, punya.rowCount ? 'PERLU_VERIFIKASI' : 'DISETUJUI'],
        );
        const perangkatId = dv.rows[0].id as string;
        const perangkatBaru = dv.rows[0].status === 'PERLU_VERIFIKASI';
        if (dv.rows[0].status === 'DITOLAK' && !tolak) tolak = 'PERANGKAT_DITOLAK';

        // 8. Anomali (hanya bila tidak ditolak).
        if (!tolak) {
          const sebelum = (await c.query(`SELECT latitude, longitude, occurred_at FROM attendance_records WHERE person_id = $1 AND status <> 'DITOLAK' AND latitude IS NOT NULL ORDER BY occurred_at DESC LIMIT 1`, [personId])).rows[0];
          const sama = (await c.query(`SELECT count(*)::int AS n FROM attendance_records WHERE person_id = $1 AND status <> 'DITOLAK' AND latitude = $2 AND longitude = $3`, [personId, lat, lng])).rows[0].n as number;
          await c.query(`SELECT set_config('app.perangkat_hash', $1, true)`, [hash]); // dibaca kebijakan RLS perangkat_baca_hash (hanya untuk menghitung akun)
          const akun = (await c.query(`SELECT count(DISTINCT person_id)::int AS n FROM device_registrations WHERE device_hash = $1`, [hash])).rows[0].n as number;
          const n = nilaiAnomali({
            sekarang: { lat, lng, akurasi: b.accuracy ?? null, waktu: sekarang },
            sebelumnya: sebelum ? { lat: Number(sebelum.latitude), lng: Number(sebelum.longitude), waktu: sebelum.occurred_at } : null,
            waktuKlien: b.clientTime ? new Date(b.clientTime) : null,
            koordinatIdentikSebelumnya: sama,
            akunPerPerangkat: akun,
            perangkatBaru,
          });
          for (const x of n.bendera) flags.set(x.kode, x.skor);
        }
        const perluVerifikasi = [...flags.values()].some((s) => s > 0);
        const status: StatusAbsen = tolak ? 'DITOLAK' : perluVerifikasi ? 'PERLU_VERIFIKASI' : 'VALID';
        const kodeFlag = tolak ? [] : [...flags.keys()];

        // 9. Simpan. Pelanggaran keunikan = balapan dengan permintaan serentak (ditangani di luar transaksi).
        const skor = tolak ? 0 : [...flags.values()].reduce((s, x) => s + x, 0);
        const rec = await c.query(
          `INSERT INTO attendance_records (company_id, person_id, placement_id, point_id, location_id, shift_id, device_id, kind, status, reject_reason, shift_date, occurred_at, client_time, latitude, longitude, accuracy_m, distance_m, anomaly_score, idempotency_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::date, $12, $13, $14, $15, $16, $17, $18, $19)
           RETURNING id, kind, status, reject_reason, shift_date::text AS shift_date, occurred_at, distance_m`,
          [titik.company_id, personId, placementId, titik.id, titik.location_id, hs?.shift.id ?? null, perangkatId, b.kind, status, tolak, tanggalShift, sekarang, b.clientTime ?? null, lat, lng, b.accuracy ?? null, Math.round(jarak * 10) / 10, skor, b.idempotencyKey],
        );
        const id = rec.rows[0].id as string;
        for (const kode of kodeFlag) await c.query(`INSERT INTO attendance_flags (company_id, record_id, code, score) VALUES ($1, $2, $3, $4)`, [titik.company_id, id, kode, flags.get(kode)]);
        if (foto && !tolak) {
          const kunciObjek = buatKunciObjek(titik.company_id);
          const retensi = (await c.query(`SELECT retensi_selfie_hari($1) AS hari`, [titik.company_id])).rows[0].hari as number;
          await this.storage.simpan(kunciObjek, enkripsiBerkas(foto, this.kunci.enkripsi, kunciObjek));
          kunciObjekSelfie = kunciObjek;
          await c.query(`INSERT INTO attendance_selfies (company_id, record_id, storage_key, sha256, size_bytes, purge_after) VALUES ($1, $2, $3, $4, $5, $6)`, [titik.company_id, id, kunciObjek, createHash('sha256').update(foto).digest('hex'), foto.length, new Date(sekarang.getTime() + retensi * 86400000)]);
        }
        return { replay: false, hasil: peta(rec.rows[0], kodeFlag), companyId: titik.company_id as string, pointId: titik.id as string };
      });
      if (!keluar.replay) {
        await this.audit.catat({
          aksi: 'attendance.recorded', aktorId: null, companyId: keluar.companyId, objek: 'attendance_record', objekId: keluar.hasil.id as string,
          detail: { jenis: keluar.hasil.kind, status: keluar.hasil.status, alasanTolak: keluar.hasil.rejectReason, bendera: keluar.hasil.flags },
        });
      }
      return keluar;
    } catch (e) {
      if (kunciObjekSelfie) await this.storage.hapus(kunciObjekSelfie).catch(() => undefined);
      const k = (e as { constraint?: string }).constraint;
      if (k === 'attendance_records_idempotensi_unik') {
        // Permintaan serentak dengan kunci sama: kembalikan rekaman pemenang.
        const ulang = await this.sdb.tx({ companyIds: [], memberPersonId: personId }, (c) => this.ambilTerekam(c, personId, b.idempotencyKey));
        if (ulang) return { replay: true, hasil: ulang };
      }
      if (k === 'attendance_records_tanpa_duplikat' && !paksaDuplikat) return this.proses(personId, b, selfie, true);
      throw e;
    }
  }

  async riwayat(userId: string, q: z.infer<typeof RiwayatAbsenQuery>) {
    const personId = await this.ctx.personId(userId);
    const k = decodeKursor(q.cursor);
    return this.sdb.tx({ companyIds: [], memberPersonId: personId }, async (c) => {
      const r = await c.query(
        `SELECT r.id, r.kind, r.status, r.reject_reason, r.shift_date::text AS shift_date, r.occurred_at, r.occurred_at::text AS occurred_txt, r.distance_m, l.name AS location_name,
                COALESCE((SELECT array_agg(f.code ORDER BY f.score DESC, f.code) FROM attendance_flags f WHERE f.record_id = r.id), '{}') AS flags
           FROM attendance_records r LEFT JOIN partner_locations l ON l.id = r.location_id
          WHERE r.person_id = $1 AND ($2::timestamptz IS NULL OR (r.occurred_at, r.id) < ($2::timestamptz, $3::uuid))
          ORDER BY r.occurred_at DESC, r.id DESC LIMIT $4`,
        [personId, k?.t ?? null, k?.id ?? null, q.limit + 1],
      );
      const ada = r.rows.length > q.limit;
      const baris = r.rows.slice(0, q.limit);
      return {
        items: baris.map((x) => ({ ...peta(x, x.flags as string[]), locationName: x.location_name })),
        nextCursor: ada ? encodeKursor({ t: baris[baris.length - 1].occurred_txt, id: baris[baris.length - 1].id }) : null,
      };
    });
  }

  /** Ringkasan untuk layar absen: lokasi penempatan aktif dan rekaman 36 jam terakhir (mencakup shift malam yang melewati tengah malam). */
  async hariIni(userId: string) {
    const personId = await this.ctx.personId(userId);
    const sekarang = this.jam();
    return this.sdb.tx({ companyIds: [], memberPersonId: personId }, async (c) => {
      const p = await c.query(
        `SELECT p.id, p.location_id, l.name AS location_name FROM placements p JOIN partner_locations l ON l.id = p.location_id WHERE p.person_id = $1 AND p.status = 'AKTIF' ORDER BY p.start_date DESC LIMIT 5`,
        [personId],
      );
      const r = await c.query(
        `SELECT r.id, r.kind, r.status, r.reject_reason, r.shift_date::text AS shift_date, r.occurred_at, r.distance_m,
                COALESCE((SELECT array_agg(f.code ORDER BY f.score DESC, f.code) FROM attendance_flags f WHERE f.record_id = r.id), '{}') AS flags
           FROM attendance_records r WHERE r.person_id = $1 AND r.occurred_at >= $2 ORDER BY r.occurred_at DESC, r.id DESC LIMIT 20`,
        [personId, new Date(sekarang.getTime() - 36 * 3600000)],
      );
      return { today: tanggalWib(sekarang), selfieAktif: selfieAktif(), placements: p.rows.map((x) => ({ placementId: x.id, locationId: x.location_id, locationName: x.location_name })), records: r.rows.map((x) => peta(x, x.flags as string[])) };
    });
  }
}
