import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Res } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe';
import type { Akses } from '../rbac/akses.service';
import { AksesStaff, RequirePermission } from '../rbac/rbac.decorators';
import { SEMUA_IZIN_PAYROLL } from './akses';
import { AlurService } from './alur.service';
import { ExportService, FormatEkspor } from './export.service';
import { PayrollService } from './payroll.service';
import { AlasanBody, DaftarPeriodeQuery, GarisManualBuat, GarisUbah, IdParam, KomponenBody, KomponenUbah, KoreksiRekapBody, PeriodeBuat } from './schemas';

const id = (nama: string) => Param(nama, new ZodPipe(IdParam));
const [IZIN_PERTAMA, ...IZIN_LAIN] = SEMUA_IZIN_PAYROLL;
const SUNTING = ['payroll_recap_partner.create', 'payroll_recap_partner.update', 'payroll_recap_internal.create', 'payroll_recap_internal.update'] as const;

/**
 * Rekap payroll TAHAP AWAL (periode, rekap absensi, komponen masukan, alur persetujuan, ekspor). Dilarang di tahap ini: hitung gaji final, PPh 21, BPJS, slip, pembayaran.
 * Izin per jenis rekap diperiksa di layanan (rekanan dan internal dipisah); rute baca terbuka bagi pemegang izin apa pun lalu disaring per jenis. Scope perusahaan: RLS.
 */
@ApiTags('Payroll: rekap')
@Controller('payroll')
export class PayrollController {
  constructor(
    private readonly svc: PayrollService,
    private readonly alur: AlurService,
    private readonly ekspor: ExportService,
  ) {}

  @RequirePermission(IZIN_PERTAMA, ...IZIN_LAIN)
  @Get('periods')
  daftar(@AksesStaff() a: Akses, @Query(new ZodPipe(DaftarPeriodeQuery)) q: z.infer<typeof DaftarPeriodeQuery>) {
    return this.svc.daftarPeriode(a, q);
  }

  @RequirePermission('payroll_recap_partner.create', 'payroll_recap_internal.create')
  @Post('periods')
  @HttpCode(201)
  @ApiOkResponse({ description: 'Membuka periode dan rekap versi 1 (DRAFT); tumpang tindih ditolak (409)' })
  buat(@AksesStaff() a: Akses, @Body(new ZodPipe(PeriodeBuat)) b: z.infer<typeof PeriodeBuat>) {
    return this.svc.buatPeriode(a, b);
  }

  @RequirePermission(IZIN_PERTAMA, ...IZIN_LAIN)
  @Get('periods/:id')
  detailPeriode(@AksesStaff() a: Akses, @id('id') i: string) {
    return this.svc.detailPeriode(a, i);
  }

  @RequirePermission(IZIN_PERTAMA, ...IZIN_LAIN)
  @Get('recaps/:id')
  @ApiOkResponse({ description: 'Rekap lengkap: baris, komponen (nominal sebagai teks desimal), subtotal per jenis. Tidak ada total gaji/neto' })
  detail(@AksesStaff() a: Akses, @id('id') i: string) {
    return this.svc.detailRekap(a, i);
  }

  @RequirePermission(...SUNTING)
  @Post('recaps/:id/pull')
  @HttpCode(200)
  @ApiOkResponse({ description: 'Snapshot absensi (DRAFT, jenis PARTNER, idempoten); komponen dipertahankan' })
  tarik(@AksesStaff() a: Akses, @id('id') i: string) {
    return this.svc.tarikAbsensi(a, i);
  }

  // ----- penyuntingan masukan (DRAFT) -----
  @RequirePermission(...SUNTING)
  @Post('recaps/:id/lines')
  @HttpCode(201)
  @ApiOkResponse({ description: 'Menambah baris manual (rekap internal saja)' })
  tambahGaris(@AksesStaff() a: Akses, @id('id') i: string, @Body(new ZodPipe(GarisManualBuat)) b: z.infer<typeof GarisManualBuat>) {
    return this.alur.tambahGarisManual(a, i, b);
  }

  @RequirePermission(...SUNTING)
  @Put('recaps/:id/lines/:lineId')
  @ApiOkResponse({ description: 'Mengubah masukan manual (cuti, jam lembur, catatan); angka absensi hanya pada baris manual' })
  ubahGaris(@AksesStaff() a: Akses, @id('id') i: string, @id('lineId') l: string, @Body(new ZodPipe(GarisUbah)) b: z.infer<typeof GarisUbah>) {
    return this.alur.ubahGaris(a, i, l, b);
  }

  @RequirePermission(...SUNTING)
  @Delete('recaps/:id/lines/:lineId')
  hapusGaris(@AksesStaff() a: Akses, @id('id') i: string, @id('lineId') l: string) {
    return this.alur.hapusGarisManual(a, i, l);
  }

  @RequirePermission(...SUNTING)
  @Post('recaps/:id/lines/:lineId/components')
  @HttpCode(201)
  @ApiOkResponse({ description: 'Menambah komponen masukan (nominal teks desimal); bukan perhitungan gaji' })
  tambahKomponen(@AksesStaff() a: Akses, @id('id') i: string, @id('lineId') l: string, @Body(new ZodPipe(KomponenBody)) b: z.infer<typeof KomponenBody>) {
    return this.alur.tambahKomponen(a, i, l, b);
  }

  @RequirePermission(...SUNTING)
  @Put('recaps/:id/lines/:lineId/components/:componentId')
  ubahKomponen(@AksesStaff() a: Akses, @id('id') i: string, @id('lineId') l: string, @id('componentId') k: string, @Body(new ZodPipe(KomponenUbah)) b: z.infer<typeof KomponenUbah>) {
    return this.alur.ubahKomponen(a, i, l, k, b);
  }

  @RequirePermission(...SUNTING)
  @Delete('recaps/:id/lines/:lineId/components/:componentId')
  hapusKomponen(@AksesStaff() a: Akses, @id('id') i: string, @id('lineId') l: string, @id('componentId') k: string) {
    return this.alur.hapusKomponen(a, i, l, k);
  }

  // ----- alur status: pembuat, pemeriksa, penyetuju, finalisator harus orang berbeda -----
  @RequirePermission('payroll_recap_partner.review', 'payroll_recap_internal.review')
  @Post('recaps/:id/verify')
  @HttpCode(200)
  @ApiOkResponse({ description: 'DRAFT -> DIVERIFIKASI; ditolak bila ada rekaman absensi menunggu verifikasi atau pemeriksa = pembuat/penyunting' })
  verifikasi(@AksesStaff() a: Akses, @id('id') i: string) {
    return this.alur.verifikasi(a, i);
  }

  @RequirePermission('payroll_recap_partner.review', 'payroll_recap_internal.review')
  @Post('recaps/:id/return')
  @HttpCode(200)
  kembalikan(@AksesStaff() a: Akses, @id('id') i: string, @Body(new ZodPipe(AlasanBody)) b: z.infer<typeof AlasanBody>) {
    return this.alur.kembalikan(a, i, b.reason);
  }

  @RequirePermission('payroll_approval.approve')
  @Post('recaps/:id/approve')
  @HttpCode(200)
  @ApiOkResponse({ description: 'DIVERIFIKASI -> DISETUJUI (hash isi disimpan); penyetuju bukan pembuat/pemeriksa' })
  setujui(@AksesStaff() a: Akses, @id('id') i: string) {
    return this.alur.setujui(a, i);
  }

  @RequirePermission('payroll_approval.finalize')
  @Post('recaps/:id/finalize')
  @HttpCode(200)
  @ApiOkResponse({ description: 'DISETUJUI -> DIFINALISASI; finalisator berbeda dari pembuat, pemeriksa, penyetuju; integritas isi diperiksa' })
  finalisasi(@AksesStaff() a: Akses, @id('id') i: string) {
    return this.alur.finalisasi(a, i);
  }

  @RequirePermission('payroll_recap_partner.create', 'payroll_recap_internal.create')
  @Post('recaps/:id/correct')
  @HttpCode(201)
  @ApiOkResponse({ description: 'Koreksi resmi: versi baru bernomor (KRP/<tahun>/<urut>) sebagai salinan DRAFT; versi lama tetap utuh' })
  koreksi(@AksesStaff() a: Akses, @id('id') i: string, @Body(new ZodPipe(KoreksiRekapBody)) b: z.infer<typeof KoreksiRekapBody>) {
    return this.alur.koreksi(a, i, b.reason);
  }

  // ----- ekspor (hanya rekap DISETUJUI/DIFINALISASI; diaudit) -----
  private async kirim(a: Akses, i: string, format: FormatEkspor, res: Response) {
    const h = await this.ekspor.ekspor(a, i, format);
    res.set({ 'Content-Type': h.mime, 'Content-Length': String(h.data.length), 'Content-Disposition': `attachment; filename="${h.namaBerkas}"`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' });
    res.end(h.data);
  }

  @RequirePermission('payroll_recap_partner.export', 'payroll_recap_internal.export')
  @Get('recaps/:id/export.csv')
  @ApiOkResponse({ description: 'Ekspor CSV (BOM UTF-8; sel berawalan = + - @ dinetralkan); dicatat di payroll_exports dan audit' })
  async csv(@AksesStaff() a: Akses, @id('id') i: string, @Res() res: Response) {
    return this.kirim(a, i, 'CSV', res);
  }

  @RequirePermission('payroll_recap_partner.export', 'payroll_recap_internal.export')
  @Get('recaps/:id/export.xlsx')
  @ApiOkResponse({ description: 'Ekspor xlsx (lembar Rekap, Komponen, Info); dicatat di payroll_exports dan audit' })
  async xlsx(@AksesStaff() a: Akses, @id('id') i: string, @Res() res: Response) {
    return this.kirim(a, i, 'XLSX', res);
  }

  @RequirePermission('payroll_recap_partner.export', 'payroll_recap_internal.export')
  @Get('recaps/:id/export.pdf')
  @ApiOkResponse({ description: 'Ekspor PDF (bukan slip gaji); dicatat di payroll_exports dan audit' })
  async pdf(@AksesStaff() a: Akses, @id('id') i: string, @Res() res: Response) {
    return this.kirim(a, i, 'PDF', res);
  }

  @RequirePermission(IZIN_PERTAMA, ...IZIN_LAIN)
  @Get('recaps/:id/exports')
  @ApiOkResponse({ description: 'Riwayat ekspor rekap (siapa, format, jumlah baris, SHA-256, waktu)' })
  riwayatEkspor(@AksesStaff() a: Akses, @id('id') i: string) {
    return this.ekspor.riwayat(a, i);
  }
}
