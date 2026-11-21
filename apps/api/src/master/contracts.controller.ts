import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { BATAS_UNGGAH_BYTE, BerkasMasuk } from '../common/storage/upload';
import { ZodPipe } from '../common/zod.pipe';
import type { Akses } from '../rbac/akses.service';
import { AksesStaff, RequirePermission } from '../rbac/rbac.decorators';
import { ContractsService } from './contracts.service';
import { DaftarKontrakQuery, IdParam, KontrakBuat, KontrakUbah, LampiranKontrakBody } from './schemas';

const id = (nama: string) => Param(nama, new ZodPipe(IdParam));
const ascii = (nama: string) => nama.replace(/[^\x20-\x7e]|["\\]/g, '_');

@ApiTags('Kontrak Layanan Rekanan')
@Controller('partner-contracts')
export class ContractsController {
  constructor(private readonly svc: ContractsService) {}

  @RequirePermission('partner_contract.view')
  @Get()
  daftar(@AksesStaff() a: Akses, @Query(new ZodPipe(DaftarKontrakQuery)) q: z.infer<typeof DaftarKontrakQuery>) {
    return this.svc.daftar(a, q);
  }

  @RequirePermission('partner_contract.view')
  @Get(':id')
  detail(@AksesStaff() a: Akses, @id('id') i: string) {
    return this.svc.detail(a, i);
  }

  @RequirePermission('partner_contract.create')
  @Post()
  @HttpCode(201)
  @ApiOkResponse({ description: 'Kontrak dibuat berstatus DRAFT' })
  buat(@AksesStaff() a: Akses, @Body(new ZodPipe(KontrakBuat)) b: z.infer<typeof KontrakBuat>) {
    return this.svc.buat(a, b);
  }

  @RequirePermission('partner_contract.update')
  @Patch(':id')
  @ApiOkResponse({ description: 'Hanya kontrak DRAFT yang dapat diubah' })
  ubah(@AksesStaff() a: Akses, @id('id') i: string, @Body(new ZodPipe(KontrakUbah)) b: z.infer<typeof KontrakUbah>) {
    return this.svc.ubah(a, i, b);
  }

  @RequirePermission('partner_contract.approve')
  @Post(':id/activate')
  @HttpCode(200)
  @ApiOkResponse({ description: 'DRAFT -> AKTIF oleh penyetuju yang bukan pembuat' })
  aktifkan(@AksesStaff() a: Akses, @id('id') i: string) {
    return this.svc.aktifkan(a, i);
  }

  @RequirePermission('partner_contract.approve')
  @Post(':id/end')
  @HttpCode(200)
  akhiri(@AksesStaff() a: Akses, @id('id') i: string) {
    return this.svc.akhiri(a, i);
  }

  @RequirePermission('partner_contract.update')
  @Post(':id/cancel')
  @HttpCode(200)
  batalkan(@AksesStaff() a: Akses, @id('id') i: string) {
    return this.svc.batalkan(a, i);
  }

  // ----- lampiran -----
  @RequirePermission('partner_contract.view')
  @Get(':id/documents')
  daftarLampiran(@AksesStaff() a: Akses, @id('id') i: string) {
    return this.svc.daftarLampiran(a, i);
  }

  @RequirePermission('partner_contract.update')
  @Post(':id/documents')
  @HttpCode(201)
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', required: ['berkas', 'title'], properties: { berkas: { type: 'string', format: 'binary' }, title: { type: 'string' } } } })
  @UseInterceptors(FileInterceptor('berkas', { limits: { fileSize: BATAS_UNGGAH_BYTE + 1, files: 1, fields: 10 } }))
  unggah(@AksesStaff() a: Akses, @id('id') i: string, @Body(new ZodPipe(LampiranKontrakBody)) b: z.infer<typeof LampiranKontrakBody>, @UploadedFile() berkas: BerkasMasuk | undefined) {
    return this.svc.unggah(a, i, b, berkas);
  }

  @RequirePermission('partner_contract.view')
  @Get(':id/documents/:docId/download')
  @ApiOkResponse({ description: 'Berkas dialirkan lewat API (tanpa URL publik); setiap unduhan diaudit' })
  async unduh(@AksesStaff() a: Akses, @id('id') i: string, @id('docId') d: string, @Res() res: Response) {
    const f = await this.svc.unduh(a, i, d);
    res.set({
      'Content-Type': f.mime,
      'Content-Length': String(f.data.length),
      'Content-Disposition': `attachment; filename="${ascii(f.nama)}"; filename*=UTF-8''${encodeURIComponent(f.nama)}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    });
    res.end(f.data);
  }

  @RequirePermission('partner_contract.update')
  @Delete(':id/documents/:docId')
  @HttpCode(204)
  async hapusLampiran(@AksesStaff() a: Akses, @id('id') i: string, @id('docId') d: string) {
    await this.svc.hapusLampiran(a, i, d);
  }
}
