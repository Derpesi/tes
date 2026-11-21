import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { ScopedDb } from '../database/scoped-db';
import { POOL } from '../database/tokens';
import { NotificationService } from '../notifications/notification.service';
import { tanggalPanjang } from './pdf';
import { MemberStatusService } from './member-status.service';

/** Tanggal kalender Asia/Jakarta (YYYY-MM-DD) dari sebuah instan waktu. Jam disuntikkan agar siklus dapat diuji deterministik. */
export function hariIni(sekarang: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(sekarang);
}

export interface RingkasanSiklus { kontrakAktif: number; kontrakBerakhir: number; penempatanAktif: number; penempatanSelesai: number; statusMemberDiubah: number; notifikasiDiantre: number }
const kosong = (): RingkasanSiklus => ({ kontrakAktif: 0, kontrakBerakhir: 0, penempatanAktif: 0, penempatanSelesai: 0, statusMemberDiubah: 0, notifikasiDiantre: 0 });
const tambah = (a: RingkasanSiklus, b: RingkasanSiklus) => { for (const k of Object.keys(a) as (keyof RingkasanSiklus)[]) a[k] += b[k]; };

/**
 * Siklus hidup kontrak dan penempatan berdasarkan tanggal (idempoten): DITANDATANGANI -> AKTIF saat tanggal mulai tiba; penempatan
 * MENUNGGU_KONTRAK -> AKTIF; kontrak AKTIF -> BERAKHIR lewat tanggal akhir; penempatan -> SELESAI/DIPINDAHKAN; lalu status member disinkronkan.
 * Satu transaksi per orang (urutan: aktivasi dulu, baru berakhir) sehingga perpanjangan tidak menimbulkan celah status. Berjalan sebagai
 * SISTEM dengan scope seluruh perusahaan (diturunkan server, bukan input). Pemicu: worker interval, dan setelah kejadian tertentu (verifikasi scan, dst.).
 */
@Injectable()
export class ContractLifecycleService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(ContractLifecycleService.name);
  private timer?: NodeJS.Timeout;
  constructor(
    @Inject(POOL) private readonly pool: Pool,
    @Inject(ENV) private readonly env: Env,
    private readonly sdb: ScopedDb,
    private readonly status: MemberStatusService,
    private readonly notif: NotificationService,
  ) {}

  onModuleInit() {
    if (this.env.NODE_ENV === 'test') return; // tes memanggil jalankan()/prosesOrang() dengan jam yang disuntikkan
    this.timer = setInterval(() => void this.jalankan().catch((e) => this.log.error(`Siklus kontrak gagal: ${(e as Error).message}`)), 5 * 60 * 1000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async semuaPerusahaan(): Promise<string[]> {
    return (await this.pool.query(`SELECT id FROM companies`)).rows.map((r) => r.id as string);
  }

  /** Memproses semua orang yang punya pekerjaan jatuh tempo. Aman dijalankan berulang. */
  async jalankan(sekarang: Date = new Date()): Promise<RingkasanSiklus> {
    const hari = hariIni(sekarang);
    const ids = await this.semuaPerusahaan();
    const orang = await this.sdb.tx({ companyIds: ids }, async (c) => {
      const r = await c.query(
        `SELECT person_id FROM employment_contracts WHERE (status = 'DITANDATANGANI' AND start_date <= $1::date) OR (status = 'AKTIF' AND end_date - $1::date <= 30)
         UNION SELECT person_id FROM placements WHERE (status = 'MENUNGGU_KONTRAK' AND start_date <= $1::date) OR (status IN ('AKTIF', 'DITANGGUHKAN') AND end_date < $1::date)
         UNION SELECT person_id FROM member_profiles WHERE status IN ('KARYAWAN_AKTIF', 'KONTRAK_AKAN_BERAKHIR')`,
        [hari],
      );
      return r.rows.map((x) => x.person_id as string);
    });
    const total = kosong();
    for (const p of orang) {
      try {
        tambah(total, await this.prosesOrang(p, sekarang));
      } catch (e) {
        this.log.error(`Siklus kontrak gagal untuk satu orang: ${(e as Error).message}`);
      }
    }
    return total;
  }

  async prosesOrang(personId: string, sekarang: Date = new Date()): Promise<RingkasanSiklus> {
    const hari = hariIni(sekarang);
    const ids = await this.semuaPerusahaan();
    return this.sdb.tx({ companyIds: ids }, async (c) => {
      const r = kosong();
      await c.query(`SELECT 1 FROM member_profiles WHERE person_id = $1 FOR UPDATE`, [personId]); // kunci yang sama dengan canApply/sinkronkan
      await this.aktivasiKontrak(c, personId, hari, r);
      await this.aktivasiPenempatan(c, personId, hari, r);
      await this.akhiriKontrakDanPenempatan(c, personId, hari, r);
      if (await this.status.sinkronkan(c, personId, hari)) r.statusMemberDiubah++;
      await this.pengingatKontrakAkanBerakhir(c, personId, hari, r);
      return r;
    });
  }

  /**
   * Pengingat sekali per kontrak ke HRD perusahaan terkait (email lewat outbox, dalam transaksi yang sama dengan penandaan
   * expiry_notified_at sehingga tepat satu kali). Tidak dikirim bila sudah ada kontrak lanjutan yang ditandatangani.
   */
  private async pengingatKontrakAkanBerakhir(c: PoolClient, personId: string, hari: string, r: RingkasanSiklus) {
    const kontrak = (await c.query(
      `SELECT k.id, k.company_id, k.contract_number, k.position, k.end_date::text AS end_date, (k.end_date - $2::date) AS sisa, m.full_name, co.name AS perusahaan
         FROM employment_contracts k JOIN companies co ON co.id = k.company_id LEFT JOIN member_profiles m ON m.person_id = k.person_id
        WHERE k.person_id = $1 AND k.status = 'AKTIF' AND k.expiry_notified_at IS NULL AND k.end_date >= $2::date AND k.end_date - $2::date <= 30
          AND NOT EXISTS (SELECT 1 FROM employment_contracts n WHERE n.extends_contract_id = k.id AND n.status IN ('DITANDATANGANI', 'AKTIF'))`,
      [personId, hari],
    )).rows;
    for (const k of kontrak) {
      const penerima = (await c.query(
        `SELECT DISTINCT u.email FROM users u JOIN user_roles ur ON ur.user_id = u.id AND ur.role_code = 'HRD' AND ur.revoked_at IS NULL AND (ur.expires_at IS NULL OR ur.expires_at > now())
           LEFT JOIN user_company_scopes s ON s.user_id = u.id AND s.revoked_at IS NULL
          WHERE u.realm = 'staff' AND u.status = 'AKTIF' AND (u.all_companies OR s.scope_company_id = $1)`,
        [k.company_id],
      )).rows.map((x) => x.email as string);
      if (!penerima.length) continue; // belum ada HRD: dicoba lagi pada siklus berikutnya
      for (const to of penerima) {
        await this.notif.enqueueEmail({ to, template: 'kontrak_akan_berakhir', data: { nomor: k.contract_number, nama: k.full_name ?? '-', jabatan: k.position, perusahaan: k.perusahaan, tanggal_akhir: tanggalPanjang(k.end_date), sisa_hari: String(k.sisa) } }, c);
      }
      await c.query(`UPDATE employment_contracts SET expiry_notified_at = now() WHERE id = $1 AND expiry_notified_at IS NULL`, [k.id]);
      r.notifikasiDiantre += penerima.length;
    }
  }

  private async catatKontrak(c: PoolClient, k: { id: string; company_id: string }, dari: string, ke: string, alasan: string) {
    await c.query(`INSERT INTO contract_status_histories (company_id, contract_id, from_status, to_status, actor_user_id, reason) VALUES ($1, $2, $3, $4, NULL, $5)`, [k.company_id, k.id, dari, ke, alasan]);
  }
  private async catatPenempatan(c: PoolClient, p: { id: string; company_id: string }, dari: string, ke: string, alasan: string) {
    await c.query(`INSERT INTO placement_status_histories (company_id, placement_id, from_status, to_status, actor_user_id, reason) VALUES ($1, $2, $3, $4, NULL, $5)`, [p.company_id, p.id, dari, ke, alasan]);
  }

  /** DITANDATANGANI dan tanggal mulai tiba -> AKTIF (atau BERAKHIR bila periodenya sudah lewat). */
  private async aktivasiKontrak(c: PoolClient, personId: string, hari: string, r: RingkasanSiklus) {
    const rows = (await c.query(`SELECT id, company_id, end_date::text AS end_date FROM employment_contracts WHERE person_id = $1 AND status = 'DITANDATANGANI' AND start_date <= $2::date`, [personId, hari])).rows;
    for (const k of rows) {
      const lewat = k.end_date < hari;
      const ke = lewat ? 'BERAKHIR' : 'AKTIF';
      const u = await c.query(`UPDATE employment_contracts SET status = $2, activated_at = now(), ended_at = CASE WHEN $2 = 'BERAKHIR' THEN now() ELSE NULL END, updated_at = now() WHERE id = $1 AND status = 'DITANDATANGANI'`, [k.id, ke]);
      if (!u.rowCount) continue;
      await this.catatKontrak(c, k, 'DITANDATANGANI', ke, lewat ? 'Otomatis: periode kontrak sudah lewat' : 'Otomatis: tanggal mulai tiba');
      if (lewat) r.kontrakBerakhir++;
      else r.kontrakAktif++;
    }
  }

  /** Penempatan yang sudah disetujui menjadi AKTIF ketika kontraknya AKTIF dan tanggal mulai tiba. */
  private async aktivasiPenempatan(c: PoolClient, personId: string, hari: string, r: RingkasanSiklus) {
    const rows = (await c.query(
      `SELECT p.id, p.company_id, p.end_date::text AS end_date FROM placements p JOIN employment_contracts k ON k.id = p.contract_id
        WHERE p.person_id = $1 AND p.status = 'MENUNGGU_KONTRAK' AND k.status = 'AKTIF' AND p.start_date <= $2::date`,
      [personId, hari],
    )).rows;
    for (const p of rows) {
      const lewat = p.end_date !== null && p.end_date < hari;
      const ke = lewat ? 'SELESAI' : 'AKTIF';
      const u = await c.query(`UPDATE placements SET status = $2, updated_at = now() WHERE id = $1 AND status = 'MENUNGGU_KONTRAK'`, [p.id, ke]);
      if (!u.rowCount) continue;
      await this.catatPenempatan(c, p, 'MENUNGGU_KONTRAK', ke, lewat ? 'Otomatis: periode penempatan sudah lewat' : 'Otomatis: kontrak aktif dan tanggal mulai tiba');
      if (lewat) r.penempatanSelesai++;
      else r.penempatanAktif++;
    }
  }

  /** Kontrak AKTIF lewat tanggal akhir -> BERAKHIR; penempatan terkait/lewat periode -> SELESAI (atau DIPINDAHKAN). */
  private async akhiriKontrakDanPenempatan(c: PoolClient, personId: string, hari: string, r: RingkasanSiklus) {
    const kontrak = (await c.query(`SELECT id, company_id FROM employment_contracts WHERE person_id = $1 AND status = 'AKTIF' AND end_date < $2::date`, [personId, hari])).rows;
    for (const k of kontrak) {
      const u = await c.query(`UPDATE employment_contracts SET status = 'BERAKHIR', ended_at = now(), updated_at = now() WHERE id = $1 AND status = 'AKTIF'`, [k.id]);
      if (!u.rowCount) continue;
      await this.catatKontrak(c, k, 'AKTIF', 'BERAKHIR', 'Otomatis: tanggal akhir kontrak lewat');
      r.kontrakBerakhir++;
    }
    const pen = (await c.query(
      `SELECT p.id, p.company_id, p.status, p.replaced_by_id FROM placements p LEFT JOIN employment_contracts k ON k.id = p.contract_id
        WHERE p.person_id = $1 AND p.status IN ('AKTIF', 'DITANGGUHKAN') AND (p.end_date < $2::date OR k.status IN ('BERAKHIR', 'DIAKHIRI_LEBIH_AWAL'))`,
      [personId, hari],
    )).rows;
    for (const p of pen) {
      const ke = p.replaced_by_id ? 'DIPINDAHKAN' : 'SELESAI';
      const u = await c.query(`UPDATE placements SET status = $2, updated_at = now() WHERE id = $1 AND status = $3`, [p.id, ke, p.status]);
      if (!u.rowCount) continue;
      await this.catatPenempatan(c, p, p.status, ke, ke === 'DIPINDAHKAN' ? 'Otomatis: dipindahkan ke penempatan baru' : 'Otomatis: periode penempatan atau kontrak berakhir');
      r.penempatanSelesai++;
    }
  }
}
