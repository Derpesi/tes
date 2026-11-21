import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe';
import type { Akses } from '../rbac/akses.service';
import { AksesStaff, RequirePermission } from '../rbac/rbac.decorators';
import { DaftarTemplateQuery, IdParam, TemplateBuat, TemplateUbah, VerifikasiTemplateBody } from './schemas';
import { TemplatesService } from './templates.service';
import { VARIABEL_TEMPLATE } from './variabel';

const id = (nama: string) => Param(nama, new ZodPipe(IdParam));

/** Template PKWT. Sistem tidak membawa teks hukum bawaan; isi disediakan pengguna dan diverifikasi ahli hukum di luar sistem. */
@ApiTags('Template PKWT')
@Controller('pkwt/templates')
export class TemplatesController {
  constructor(private readonly svc: TemplatesService) {}

  @RequirePermission('pkwt.view')
  @Get('variabel')
  @ApiOkResponse({ description: 'Variabel yang boleh dipakai di isi template' })
  variabel() {
    return { items: [...VARIABEL_TEMPLATE] };
  }

  @RequirePermission('pkwt.view')
  @Get()
  daftar(@AksesStaff() a: Akses, @Query(new ZodPipe(DaftarTemplateQuery)) q: z.infer<typeof DaftarTemplateQuery>) {
    return this.svc.daftar(a, q);
  }

  @RequirePermission('pkwt.view')
  @Get(':id')
  detail(@AksesStaff() a: Akses, @id('id') i: string) {
    return this.svc.detail(a, i);
  }

  @RequirePermission('pkwt.update')
  @Post()
  @HttpCode(201)
  @ApiOkResponse({ description: 'Membuat versi baru template (BELUM_DIVERIFIKASI); tidak dapat dipakai untuk kontrak sebelum diverifikasi' })
  buat(@AksesStaff() a: Akses, @Body(new ZodPipe(TemplateBuat)) b: z.infer<typeof TemplateBuat>) {
    return this.svc.buat(a, b);
  }

  @RequirePermission('pkwt.update')
  @Patch(':id')
  ubah(@AksesStaff() a: Akses, @id('id') i: string, @Body(new ZodPipe(TemplateUbah)) b: z.infer<typeof TemplateUbah>) {
    return this.svc.ubah(a, i, b);
  }

  @RequirePermission('pkwt.approve')
  @Post(':id/verify')
  @HttpCode(200)
  @ApiOkResponse({ description: 'Mencatat verifikasi hukum template (pemverifikasi bukan pembuat)' })
  verifikasi(@AksesStaff() a: Akses, @id('id') i: string, @Body(new ZodPipe(VerifikasiTemplateBody)) b: z.infer<typeof VerifikasiTemplateBody>) {
    return this.svc.verifikasi(a, i, b);
  }

  @RequirePermission('pkwt.update')
  @Post(':id/archive')
  @HttpCode(200)
  arsipkan(@AksesStaff() a: Akses, @id('id') i: string) {
    return this.svc.arsipkan(a, i);
  }
}
