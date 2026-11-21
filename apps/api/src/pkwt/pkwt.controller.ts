import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { BATAS_UNGGAH_BYTE, BerkasMasuk } from '../common/storage/upload';
import { ZodPipe } from '../common/zod.pipe';
import type { Akses } from '../rbac/akses.service';
import { AksesStaff, RequirePermission } from '../rbac/rbac.decorators';
import { PkwtService } from './pkwt.service';
import { AlasanBody, DaftarKontrakQuery, IdParam, KontrakBuat, KontrakUbah } from './schemas';

const id = (nama: string) => Param(nama, new ZodPipe(IdParam));
const ascii = (nama: string) => nama.replace(/[^\x20-\x7e]|["\\]/g, '_');

/**
 * Kontrak PKWT. "Setuju" di sistem BUKAN tanda tangan sah: kontrak sah setelah scan bertanda tangan basah diverifikasi HRD.
 * Izin: pkwt.* dan pkwt_document.review sesuai docs/rbac.md; scope perusahaan ditegakkan RLS.
 */
@ApiTags('Kontrak PKWT')
@Controller('pkwt')
export class PkwtController {
  constructor(private readonly svc: PkwtService) {}

  @RequirePermission('pkwt.view')
  @Get()
  daftar(@AksesStaff() a: Akses, @Query(new ZodPipe(DaftarKontrakQuery)) q: z.infer<typeof DaftarKontrakQuery>) {
    return this.svc.daftar(a, q);
  }

  @RequirePermission('pkwt.view')
  @Get(':id')
  detail(@AksesStaff() a: Akses, @id('id') i: string) {
    return this.svc.detail(a, i);
  }

  @RequirePermission('pkwt.create')
  @Post()
  @HttpCode(201)
  @ApiOkResponse({ description: 'Membuat kontrak DRAFT dari lamaran MENUNGGU_PKWT; nomor otomatis; versi 1' })
  buat(@AksesStaff() a: Akses, @Body(new ZodPipe(KontrakBuat)) b: z.infer<typeof KontrakBuat>) {
    return this.svc.buat(a, b);
  }

  @RequirePermission('pkwt.update')
  @Patch(':id')
  @ApiOkResponse({ description: 'Hanya DRAFT; setiap perubahan membuat versi baru' })
  ubah(@AksesStaff() a: Akses, @id('id') i: string, @Body(new ZodPipe(KontrakUbah)) b: z.infer<typeof KontrakUbah>) {
    return this.svc.ubah(a, i, b);
  }

  @RequirePermission('pkwt.update')
  @Post(':id/submit')
  @HttpCode(200)
  ajukan(@AksesStaff() a: Akses, @id('id') i: string) {
    return this.svc.ajukanReview(a, i);
  }

  @RequirePermission('pkwt.review')
  @Post(':id/review')
  @HttpCode(200)
  @ApiOkResponse({ description: 'REVIEW -> PERSETUJUAN (pemeriksa bukan pembuat; template wajib terverifikasi)' })
  periksa(@AksesStaff() a: Akses, @id('id') i: string) {
    return this.svc.periksa(a, i);
  }

  @RequirePermission('pkwt.review')
  @Post(':id/review/reject')
  @HttpCode(200)
  tolakReview(@AksesStaff() a: Akses, @id('id') i: string, @Body(new ZodPipe(AlasanBody)) b: z.infer<typeof AlasanBody>) {
    return this.svc.tolakReview(a, i, b);
  }

  @RequirePermission('pkwt.approve')
  @Post(':id/approve')
  @HttpCode(200)
  @ApiOkResponse({ description: 'PERSETUJUAN -> PENANDATANGANAN (penyetuju bukan pembuat/pemeriksa). BUKAN tanda tangan sah' })
  setujui(@AksesStaff() a: Akses, @id('id') i: string) {
    return this.svc.setujui(a, i);
  }

  @RequirePermission('pkwt.approve')
  @Post(':id/approve/reject')
  @HttpCode(200)
  tolakPersetujuan(@AksesStaff() a: Akses, @id('id') i: string, @Body(new ZodPipe(AlasanBody)) b: z.infer<typeof AlasanBody>) {
    return this.svc.tolakPersetujuan(a, i, b);
  }

  @RequirePermission('pkwt.update')
  @Post(':id/cancel')
  @HttpCode(200)
  batalkan(@AksesStaff() a: Akses, @id('id') i: string, @Body(new ZodPipe(AlasanBody)) b: z.infer<typeof AlasanBody>) {
    return this.svc.batalkan(a, i, b);
  }

  @RequirePermission('pkwt.export')
  @Get(':id/pdf')
  @ApiOkResponse({ description: 'PDF dibangkitkan sesuai permintaan (tidak disimpan); setiap pencetakan diaudit' })
  async pdf(@AksesStaff() a: Akses, @id('id') i: string, @Res() res: Response) {
    const data = await this.svc.pdf(a, i);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Length': String(data.length), 'Content-Disposition': 'attachment; filename="pkwt.pdf"', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' });
    res.end(data);
  }

  // ----- scan bertanda tangan -----
  @RequirePermission('pkwt.view')
  @Get(':id/documents')
  daftarDokumen(@AksesStaff() a: Akses, @id('id') i: string) {
    return this.svc.daftarDokumen(a, i);
  }

  @RequirePermission('pkwt.update')
  @Post(':id/documents')
  @HttpCode(201)
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', required: ['berkas'], properties: { berkas: { type: 'string', format: 'binary' } } } })
  @UseInterceptors(FileInterceptor('berkas', { limits: { fileSize: BATAS_UNGGAH_BYTE + 1, files: 1, fields: 5 } }))
  unggah(@AksesStaff() a: Akses, @id('id') i: string, @UploadedFile() berkas: BerkasMasuk | undefined) {
    return this.svc.unggah(a, i, berkas);
  }

  @RequirePermission('pkwt_document.review')
  @Get(':id/documents/:docId/download')
  @ApiOkResponse({ description: 'Scan didekripsi dan dialirkan lewat API; setiap unduhan diaudit' })
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

  @RequirePermission('pkwt_document.review')
  @Post(':id/documents/:docId/verify')
  @HttpCode(200)
  @ApiOkResponse({ description: 'Verifikasi scan (pemverifikasi bukan pengunggah): MENUNGGU_VERIFIKASI_DOKUMEN -> DITANDATANGANI' })
  verifikasi(@AksesStaff() a: Akses, @id('id') i: string, @id('docId') d: string) {
    return this.svc.verifikasiDokumen(a, i, d);
  }

  @RequirePermission('pkwt_document.review')
  @Post(':id/documents/:docId/reject')
  @HttpCode(200)
  tolakDokumen(@AksesStaff() a: Akses, @id('id') i: string, @id('docId') d: string, @Body(new ZodPipe(AlasanBody)) b: z.infer<typeof AlasanBody>) {
    return this.svc.tolakDokumen(a, i, d, b);
  }
}
