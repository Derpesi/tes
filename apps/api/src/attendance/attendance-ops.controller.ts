import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe';
import type { Akses } from '../rbac/akses.service';
import { AksesStaff, RequirePermission } from '../rbac/rbac.decorators';
import { AdjustmentsService } from './adjustments.service';
import { RecapService } from './recap.service';
import { ReviewService } from './review.service';
import { DaftarKoreksiQuery, DaftarTinjauanQuery, HoldBody, IdParam, KoreksiBuat, KoreksiPutusan, KoreksiUbah, PeriksaBody, PutusanBody, RekapEksporQuery, RekapQuery } from './schemas';
import { SelfieService } from './selfie.service';

const id = (nama: string) => Param(nama, new ZodPipe(IdParam));
const LIHAT_TINJAUAN = ['attendance_anomaly.view', 'attendance_anomaly.review', 'attendance_anomaly.approve'] as const;
const LIHAT_KOREKSI = ['attendance_adjustment.view', 'attendance_adjustment.create', 'attendance_adjustment.update', 'attendance_adjustment.approve'] as const;

/** Operasi absensi staf: tinjauan dua langkah, selfie (diaudit), koreksi bernomor, rekap dan ekspor CSV. Scope perusahaan: RLS. */
@ApiTags('Absensi: operasional')
@Controller('attendance')
export class AttendanceOpsController {
  constructor(
    private readonly tinjauan: ReviewService,
    private readonly selfie: SelfieService,
    private readonly koreksi: AdjustmentsService,
    private readonly rekap: RecapService,
  ) {}

  // ----- tinjauan -----
  @RequirePermission(LIHAT_TINJAUAN[0], LIHAT_TINJAUAN[1], LIHAT_TINJAUAN[2])
  @Get('review')
  daftarTinjauan(@AksesStaff() a: Akses, @Query(new ZodPipe(DaftarTinjauanQuery)) q: z.infer<typeof DaftarTinjauanQuery>) {
    return this.tinjauan.daftar(a, q);
  }

  @RequirePermission(LIHAT_TINJAUAN[0], LIHAT_TINJAUAN[1], LIHAT_TINJAUAN[2])
  @Get('review/:id')
  detailTinjauan(@AksesStaff() a: Akses, @id('id') i: string) {
    return this.tinjauan.detail(a, i);
  }

  @RequirePermission('attendance_anomaly.review')
  @Post('review/:id/check')
  @HttpCode(200)
  @ApiOkResponse({ description: 'Langkah 1: pemeriksaan (PayAbs/PayInt)' })
  periksa(@AksesStaff() a: Akses, @id('id') i: string, @Body(new ZodPipe(PeriksaBody)) b: z.infer<typeof PeriksaBody>) {
    return this.tinjauan.periksa(a, i, b);
  }

  @RequirePermission('attendance_anomaly.approve')
  @Post('review/:id/decide')
  @HttpCode(200)
  @ApiOkResponse({ description: 'Langkah 2: putusan (Mgr Ops), orang berbeda dari pemeriksa; rekaman asli tidak diubah' })
  putuskan(@AksesStaff() a: Akses, @id('id') i: string, @Body(new ZodPipe(PutusanBody)) b: z.infer<typeof PutusanBody>) {
    return this.tinjauan.putuskan(a, i, b);
  }

  // ----- selfie -----
  @RequirePermission('selfie.view')
  @Get('records/:id/selfie')
  @ApiOkResponse({ description: 'Isi selfie (JPEG) didekripsi sesuai permintaan; setiap akses diaudit; tanpa cache' })
  async lihatSelfie(@AksesStaff() a: Akses, @id('id') i: string, @Res() res: Response) {
    const data = await this.selfie.lihat(a, i);
    res.set({ 'Content-Type': 'image/jpeg', 'Content-Length': String(data.length), 'Content-Disposition': 'inline; filename="selfie.jpg"', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' });
    res.end(data);
  }

  @RequirePermission('attendance_anomaly.approve')
  @Post('records/:id/selfie/hold')
  @HttpCode(200)
  @ApiOkResponse({ description: 'Menerapkan/mencabut legal hold; selfie yang ditahan tidak dihapus oleh retensi' })
  tahan(@AksesStaff() a: Akses, @id('id') i: string, @Body(new ZodPipe(HoldBody)) b: z.infer<typeof HoldBody>) {
    return this.selfie.tahan(a, i, b);
  }

  // ----- koreksi -----
  @RequirePermission(LIHAT_KOREKSI[0], LIHAT_KOREKSI[1], LIHAT_KOREKSI[2], LIHAT_KOREKSI[3])
  @Get('adjustments')
  daftarKoreksi(@AksesStaff() a: Akses, @Query(new ZodPipe(DaftarKoreksiQuery)) q: z.infer<typeof DaftarKoreksiQuery>) {
    return this.koreksi.daftar(a, q);
  }

  @RequirePermission(LIHAT_KOREKSI[0], LIHAT_KOREKSI[1], LIHAT_KOREKSI[2], LIHAT_KOREKSI[3])
  @Get('adjustments/:id')
  detailKoreksi(@AksesStaff() a: Akses, @id('id') i: string) {
    return this.koreksi.detail(a, i);
  }

  @RequirePermission('attendance_adjustment.create')
  @Post('adjustments')
  @HttpCode(201)
  buatKoreksi(@AksesStaff() a: Akses, @Body(new ZodPipe(KoreksiBuat)) b: z.infer<typeof KoreksiBuat>) {
    return this.koreksi.buat(a, b);
  }

  @RequirePermission('attendance_adjustment.update')
  @Patch('adjustments/:id')
  ubahKoreksi(@AksesStaff() a: Akses, @id('id') i: string, @Body(new ZodPipe(KoreksiUbah)) b: z.infer<typeof KoreksiUbah>) {
    return this.koreksi.ubah(a, i, b);
  }

  @RequirePermission('attendance_adjustment.approve')
  @Post('adjustments/:id/decide')
  @HttpCode(200)
  putuskanKoreksi(@AksesStaff() a: Akses, @id('id') i: string, @Body(new ZodPipe(KoreksiPutusan)) b: z.infer<typeof KoreksiPutusan>) {
    return this.koreksi.putuskan(a, i, b);
  }

  // ----- rekap -----
  @RequirePermission('attendance_recap.view')
  @Get('recap')
  @ApiOkResponse({ description: 'Rekap per orang-hari dari rekaman efektif (putusan tinjauan dan koreksi disetujui); keyset' })
  daftarRekap(@AksesStaff() a: Akses, @Query(new ZodPipe(RekapQuery)) q: z.infer<typeof RekapQuery>) {
    return this.rekap.daftar(a, q);
  }

  @RequirePermission('attendance_recap.export')
  @Get('recap/export.csv')
  @ApiOkResponse({ description: 'Ekspor CSV (maksimal 10.000 baris) dengan perlindungan formula injection; diaudit' })
  async eksporRekap(@AksesStaff() a: Akses, @Query(new ZodPipe(RekapEksporQuery)) q: z.infer<typeof RekapEksporQuery>, @Res() res: Response) {
    const csv = await this.rekap.ekspor(a, q);
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="rekap-absensi.csv"', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' });
    res.end(csv);
  }
}
