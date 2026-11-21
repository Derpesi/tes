import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe';
import type { Akses } from '../rbac/akses.service';
import { AksesStaff, RequirePermission } from '../rbac/rbac.decorators';
import { PlacementsService } from './placements.service';
import { AlasanBody, DaftarPenempatanQuery, IdParam, PenempatanBuat, PindahBody } from './schemas';

const id = (nama: string) => Param(nama, new ZodPipe(IdParam));

/** Penempatan. Izin: placement.* sesuai docs/rbac.md; scope perusahaan ditegakkan RLS. Rekanan adalah master data, bukan pengguna. */
@ApiTags('Penempatan')
@Controller('placements')
export class PlacementsController {
  constructor(private readonly svc: PlacementsService) {}

  @RequirePermission('placement.view')
  @Get()
  daftar(@AksesStaff() a: Akses, @Query(new ZodPipe(DaftarPenempatanQuery)) q: z.infer<typeof DaftarPenempatanQuery>) {
    return this.svc.daftar(a, q);
  }

  @RequirePermission('placement.view')
  @Get(':id')
  detail(@AksesStaff() a: Akses, @id('id') i: string) {
    return this.svc.detail(a, i);
  }

  @RequirePermission('placement.create')
  @Post()
  @HttpCode(201)
  @ApiOkResponse({ description: 'Merencanakan penempatan (DIRENCANAKAN); tumpang tindih ditolak database' })
  buat(@AksesStaff() a: Akses, @Body(new ZodPipe(PenempatanBuat)) b: z.infer<typeof PenempatanBuat>) {
    return this.svc.buat(a, b);
  }

  @RequirePermission('placement.approve')
  @Post(':id/approve')
  @HttpCode(200)
  @ApiOkResponse({ description: 'DIRENCANAKAN -> MENUNGGU_KONTRAK (penyetuju bukan pembuat); aktif otomatis bila kontrak aktif dan tanggal mulai tiba' })
  setujui(@AksesStaff() a: Akses, @id('id') i: string) {
    return this.svc.setujui(a, i);
  }

  @RequirePermission('placement.update')
  @Post(':id/suspend')
  @HttpCode(200)
  tangguhkan(@AksesStaff() a: Akses, @id('id') i: string, @Body(new ZodPipe(AlasanBody)) b: z.infer<typeof AlasanBody>) {
    return this.svc.tangguhkan(a, i, b);
  }

  @RequirePermission('placement.update')
  @Post(':id/resume')
  @HttpCode(200)
  lanjutkan(@AksesStaff() a: Akses, @id('id') i: string) {
    return this.svc.lanjutkan(a, i);
  }

  @RequirePermission('placement.update')
  @Post(':id/complete')
  @HttpCode(200)
  selesaikan(@AksesStaff() a: Akses, @id('id') i: string, @Body(new ZodPipe(AlasanBody)) b: z.infer<typeof AlasanBody>) {
    return this.svc.selesaikan(a, i, b);
  }

  @RequirePermission('placement.update')
  @Post(':id/cancel')
  @HttpCode(200)
  batalkan(@AksesStaff() a: Akses, @id('id') i: string, @Body(new ZodPipe(AlasanBody)) b: z.infer<typeof AlasanBody>) {
    return this.svc.batalkan(a, i, b);
  }

  @RequirePermission('placement.update')
  @Post(':id/move')
  @HttpCode(200)
  @ApiOkResponse({ description: 'Memindahkan pekerja ke lokasi lain mulai tanggal pindah; penempatan baru memerlukan persetujuan' })
  pindahkan(@AksesStaff() a: Akses, @id('id') i: string, @Body(new ZodPipe(PindahBody)) b: z.infer<typeof PindahBody>) {
    return this.svc.pindahkan(a, i, b);
  }
}
