import { Body, Controller, Get, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe';
import type { Akses } from '../rbac/akses.service';
import { AksesStaff, RequirePermission } from '../rbac/rbac.decorators';
import { MembersAdminService } from './members-admin.service';
import { DaftarMemberQuery, IdParam, KembalikanBody } from './schemas';

const id = (nama: string) => Param(nama, new ZodPipe(IdParam));
const ascii = (nama: string) => nama.replace(/[^\x20-\x7e]|["\\]/g, '_');

/** Database member untuk staff (verifikasi HRD). Izin: member.* sesuai docs/rbac.md; scope perusahaan tidak berlaku (member lintas Group). */
@ApiTags('Database Member (staff)')
@Controller('members')
export class MembersController {
  constructor(private readonly svc: MembersAdminService) {}

  @RequirePermission('member.view')
  @Get()
  @ApiOkResponse({ description: 'Daftar member (keyset). NIK tersamar' })
  daftar(@Query(new ZodPipe(DaftarMemberQuery)) q: z.infer<typeof DaftarMemberQuery>) {
    return this.svc.daftar(q);
  }

  @RequirePermission('member.view_summary')
  @Get('summary')
  @ApiOkResponse({ description: 'Hitungan member per status, tanpa data pribadi' })
  ringkasan() {
    return this.svc.ringkasan();
  }

  @RequirePermission('member.view')
  @Get(':id')
  detail(@id('id') i: string) {
    return this.svc.detail(i);
  }

  @RequirePermission('member.review')
  @Get(':id/nik')
  @ApiOkResponse({ description: 'NIK penuh; setiap akses diaudit' })
  nik(@AksesStaff() a: Akses, @id('id') i: string, @Res({ passthrough: true }) res: Response) {
    res.set('Cache-Control', 'private, no-store');
    return this.svc.bukaNik(a, i);
  }

  @RequirePermission('member.review')
  @Get(':id/documents/:docId/download')
  @ApiOkResponse({ description: 'Dokumen identitas dialirkan setelah didekripsi; setiap unduhan diaudit' })
  async unduh(@AksesStaff() a: Akses, @id('id') i: string, @id('docId') d: string, @Res() res: Response) {
    const f = await this.svc.unduhDokumen(a, i, d);
    res.set({
      'Content-Type': f.mime,
      'Content-Length': String(f.data.length),
      'Content-Disposition': `attachment; filename="${ascii(f.nama)}"; filename*=UTF-8''${encodeURIComponent(f.nama)}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    });
    res.end(f.data);
  }

  @RequirePermission('member.review')
  @Post(':id/return')
  @HttpCode(200)
  @ApiOkResponse({ description: 'Mengembalikan untuk revisi (alasan wajib)' })
  kembalikan(@AksesStaff() a: Akses, @id('id') i: string, @Body(new ZodPipe(KembalikanBody)) b: z.infer<typeof KembalikanBody>) {
    return this.svc.kembalikan(a, i, b);
  }

  @RequirePermission('member.approve')
  @Post(':id/approve')
  @HttpCode(200)
  @ApiOkResponse({ description: 'Menyetujui verifikasi: TERVERIFIKASI -> BELUM_DITEMPATKAN' })
  setujui(@AksesStaff() a: Akses, @id('id') i: string) {
    return this.svc.setujui(a, i);
  }
}
