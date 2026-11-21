import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { ZodPipe } from '../common/zod.pipe';
import type { Akses } from '../rbac/akses.service';
import { AksesStaff, RequirePermission } from '../rbac/rbac.decorators';
import { PointsService } from './points.service';
import { ScheduleService } from './schedule.service';
import { DaftarJadwalQuery, DaftarLiburQuery, DaftarShiftQuery, DaftarTitikQuery, IdParam, JadwalBuat, LiburBuat, ShiftBuat, ShiftUbah, TitikBuat } from './schemas';

const id = (nama: string) => Param(nama, new ZodPipe(IdParam));

/** Titik absensi (QR), shift, jadwal kerja, dan hari libur. Rekanan = master data internal; tidak ada akun rekanan. */
@ApiTags('Absensi: pengaturan')
@Controller('attendance')
export class AttendanceSetupController {
  constructor(
    private readonly titik: PointsService,
    private readonly jadwal: ScheduleService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @RequirePermission('attendance_point.view')
  @Get('points')
  daftarTitik(@AksesStaff() a: Akses, @Query(new ZodPipe(DaftarTitikQuery)) q: z.infer<typeof DaftarTitikQuery>) {
    return this.titik.daftar(a, q);
  }

  @RequirePermission('attendance_point.view')
  @Get('points/:id')
  detailTitik(@AksesStaff() a: Akses, @id('id') i: string) {
    return this.titik.detail(a, i);
  }

  @RequirePermission('attendance_point.create')
  @Post('points')
  @HttpCode(201)
  buatTitik(@AksesStaff() a: Akses, @Body(new ZodPipe(TitikBuat)) b: z.infer<typeof TitikBuat>) {
    return this.titik.buat(a, b.locationId);
  }

  @RequirePermission('attendance_point.deactivate')
  @Post('points/:id/deactivate')
  @HttpCode(200)
  nonaktifkanTitik(@AksesStaff() a: Akses, @id('id') i: string) {
    return this.titik.nonaktifkan(a, i);
  }

  @RequirePermission('attendance_point.update')
  @Post('points/:id/rotate-code')
  @HttpCode(200)
  @ApiOkResponse({ description: 'Mengganti kode publik QR; kode lama langsung tidak berlaku' })
  gantiKode(@AksesStaff() a: Akses, @id('id') i: string) {
    return this.titik.gantiKode(a, i);
  }

  @RequirePermission('attendance_point.export')
  @Get('points/:id/qr.pdf')
  @ApiOkResponse({ description: 'Poster QR (PDF) dibangkitkan sesuai permintaan; pencetakan diaudit' })
  async qrPdf(@AksesStaff() a: Akses, @id('id') i: string, @Res() res: Response) {
    const data = await this.titik.qrPdf(a, i, this.env.APP_BASE_URL);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Length': String(data.length), 'Content-Disposition': 'attachment; filename="titik-absensi.pdf"', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' });
    res.end(data);
  }

  @RequirePermission('placement.view')
  @Get('shifts')
  daftarShift(@AksesStaff() a: Akses, @Query(new ZodPipe(DaftarShiftQuery)) q: z.infer<typeof DaftarShiftQuery>) {
    return this.jadwal.daftarShift(a, q);
  }

  @RequirePermission('placement.create')
  @Post('shifts')
  @HttpCode(201)
  buatShift(@AksesStaff() a: Akses, @Body(new ZodPipe(ShiftBuat)) b: z.infer<typeof ShiftBuat>) {
    return this.jadwal.buatShift(a, b);
  }

  @RequirePermission('placement.update')
  @Patch('shifts/:id')
  ubahShift(@AksesStaff() a: Akses, @id('id') i: string, @Body(new ZodPipe(ShiftUbah)) b: z.infer<typeof ShiftUbah>) {
    return this.jadwal.ubahShift(a, i, b);
  }

  @RequirePermission('placement.view')
  @Get('schedules')
  daftarJadwal(@AksesStaff() a: Akses, @Query(new ZodPipe(DaftarJadwalQuery)) q: z.infer<typeof DaftarJadwalQuery>) {
    return this.jadwal.daftarJadwal(a, q);
  }

  @RequirePermission('placement.update')
  @Post('schedules')
  @HttpCode(201)
  buatJadwal(@AksesStaff() a: Akses, @Body(new ZodPipe(JadwalBuat)) b: z.infer<typeof JadwalBuat>) {
    return this.jadwal.buatJadwal(a, b);
  }

  @RequirePermission('placement.update')
  @Delete('schedules/:id')
  @HttpCode(204)
  hapusJadwal(@AksesStaff() a: Akses, @id('id') i: string) {
    return this.jadwal.hapusJadwal(a, i);
  }

  @RequirePermission('placement.view')
  @Get('holidays')
  daftarLibur(@AksesStaff() a: Akses, @Query(new ZodPipe(DaftarLiburQuery)) q: z.infer<typeof DaftarLiburQuery>) {
    return this.jadwal.daftarLibur(a, q);
  }

  @RequirePermission('placement.update')
  @Post('holidays')
  @HttpCode(201)
  buatLibur(@AksesStaff() a: Akses, @Body(new ZodPipe(LiburBuat)) b: z.infer<typeof LiburBuat>) {
    return this.jadwal.buatLibur(a, b);
  }

  @RequirePermission('placement.update')
  @Delete('holidays/:id')
  @HttpCode(204)
  hapusLibur(@AksesStaff() a: Akses, @id('id') i: string) {
    return this.jadwal.hapusLibur(a, i);
  }
}
