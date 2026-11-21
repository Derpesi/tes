import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe';
import type { Akses } from '../rbac/akses.service';
import { AksesStaff, RequirePermission } from '../rbac/rbac.decorators';
import { ApplicationsService } from './applications.service';
import { DaftarLamaranQuery, DaftarLowonganQuery, IdParam, LowonganBuat, LowonganUbah, TahapBody, TerimaBody, TolakBody } from './schemas';
import { VacanciesService } from './vacancies.service';

const id = (nama: string) => Param(nama, new ZodPipe(IdParam));

/** Lowongan dan seleksi lamaran untuk staff, dibatasi scope perusahaan (RLS). Izin: vacancy_application.* sesuai docs/rbac.md. */
@ApiTags('Lowongan dan Lamaran (staff)')
@Controller()
export class RecruitmentController {
  constructor(
    private readonly lowongan: VacanciesService,
    private readonly lamaran: ApplicationsService,
  ) {}

  @RequirePermission('vacancy_application.view')
  @Get('vacancies')
  daftarLowongan(@AksesStaff() a: Akses, @Query(new ZodPipe(DaftarLowonganQuery)) q: z.infer<typeof DaftarLowonganQuery>) {
    return this.lowongan.daftar(a, q);
  }

  @RequirePermission('vacancy_application.view')
  @Get('vacancies/:id')
  detailLowongan(@AksesStaff() a: Akses, @id('id') i: string) {
    return this.lowongan.detail(a, i);
  }

  @RequirePermission('vacancy_application.create')
  @Post('vacancies')
  @HttpCode(201)
  @ApiOkResponse({ description: 'Lowongan dibuat berstatus DRAFT (tidak terlihat member)' })
  buatLowongan(@AksesStaff() a: Akses, @Body(new ZodPipe(LowonganBuat)) b: z.infer<typeof LowonganBuat>) {
    return this.lowongan.buat(a, b);
  }

  @RequirePermission('vacancy_application.update')
  @Patch('vacancies/:id')
  ubahLowongan(@AksesStaff() a: Akses, @id('id') i: string, @Body(new ZodPipe(LowonganUbah)) b: z.infer<typeof LowonganUbah>) {
    return this.lowongan.ubah(a, i, b);
  }

  @RequirePermission('vacancy_application.update')
  @Post('vacancies/:id/open')
  @HttpCode(200)
  bukaLowongan(@AksesStaff() a: Akses, @id('id') i: string) {
    return this.lowongan.buka(a, i);
  }

  @RequirePermission('vacancy_application.update')
  @Post('vacancies/:id/close')
  @HttpCode(200)
  tutupLowongan(@AksesStaff() a: Akses, @id('id') i: string) {
    return this.lowongan.tutup(a, i);
  }

  @RequirePermission('vacancy_application.view')
  @Get('applications')
  daftarLamaran(@AksesStaff() a: Akses, @Query(new ZodPipe(DaftarLamaranQuery)) q: z.infer<typeof DaftarLamaranQuery>) {
    return this.lamaran.daftar(a, q);
  }

  @RequirePermission('vacancy_application.view')
  @Get('applications/:id')
  @ApiOkResponse({ description: 'Detail lamaran dengan profil ringkas pelamar tanpa NIK dan tanpa kontak' })
  detailLamaran(@AksesStaff() a: Akses, @id('id') i: string) {
    return this.lamaran.detail(a, i);
  }

  @RequirePermission('vacancy_application.review')
  @Post('applications/:id/stage')
  @HttpCode(200)
  tahap(@AksesStaff() a: Akses, @id('id') i: string, @Body(new ZodPipe(TahapBody)) b: z.infer<typeof TahapBody>) {
    return this.lamaran.tahap(a, i, b);
  }

  @RequirePermission('vacancy_application.approve')
  @Post('applications/:id/accept')
  @HttpCode(200)
  @ApiOkResponse({ description: 'INTERVIEW -> DITERIMA -> MENUNGGU_PKWT (PKWT di Fase 6)' })
  terima(@AksesStaff() a: Akses, @id('id') i: string, @Body(new ZodPipe(TerimaBody)) b: z.infer<typeof TerimaBody>) {
    return this.lamaran.terima(a, i, b);
  }

  @RequirePermission('vacancy_application.review')
  @Post('applications/:id/reject')
  @HttpCode(200)
  tolak(@AksesStaff() a: Akses, @id('id') i: string, @Body(new ZodPipe(TolakBody)) b: z.infer<typeof TolakBody>) {
    return this.lamaran.tolak(a, i, b);
  }
}
