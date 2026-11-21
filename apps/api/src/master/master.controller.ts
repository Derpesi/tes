import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { BATAS_UNGGAH_BYTE, BerkasMasuk } from '../common/storage/upload';
import { ZodPipe } from '../common/zod.pipe';
import type { Akses } from '../rbac/akses.service';
import { AksesStaff, RequirePermission } from '../rbac/rbac.decorators';
import { CompaniesService } from './companies.service';
import { CompanyDocumentsService } from './company-documents.service';
import { DaftarQuery, DokumenPerusahaanBody, IdParam, PerusahaanBuat, PerusahaanUbah } from './schemas';

const ascii = (nama: string) => nama.replace(/[^\x20-\x7e]|["\\]/g, '_');

@ApiTags('Master Perusahaan')
@Controller('companies')
export class MasterController {
  constructor(
    private readonly companies: CompaniesService,
    private readonly dokumen: CompanyDocumentsService,
  ) {}

  @RequirePermission('company.view')
  @Get()
  @ApiOkResponse({ description: 'Perusahaan dalam scope pengguna (dan perusahaan pending buatannya); keyset pagination' })
  daftar(@AksesStaff() a: Akses, @Query(new ZodPipe(DaftarQuery)) q: z.infer<typeof DaftarQuery>) {
    return this.companies.daftar(a, q.cursor, q.limit);
  }

  @RequirePermission('company.view')
  @Get(':id')
  detail(@AksesStaff() a: Akses, @Param('id', new ZodPipe(IdParam)) id: string) {
    return this.companies.detail(a, id);
  }

  @RequirePermission('company.create')
  @Post()
  @HttpCode(201)
  @ApiOkResponse({ description: 'Perusahaan dibuat NONAKTIF; aktif setelah Direktur menyetujui permintaan aktivasi' })
  buat(@AksesStaff() a: Akses, @Body(new ZodPipe(PerusahaanBuat)) b: z.infer<typeof PerusahaanBuat>) {
    return this.companies.buat(a, b);
  }

  @RequirePermission('company.update')
  @Patch(':id')
  ubah(@AksesStaff() a: Akses, @Param('id', new ZodPipe(IdParam)) id: string, @Body(new ZodPipe(PerusahaanUbah)) b: z.infer<typeof PerusahaanUbah>) {
    return this.companies.ubah(a, id, b);
  }

  @RequirePermission('company.approve')
  @Post(':id/deactivate')
  @HttpCode(204)
  async nonaktifkan(@AksesStaff() a: Akses, @Param('id', new ZodPipe(IdParam)) id: string) {
    await this.companies.nonaktifkan(a, id);
  }

  // ----- dokumen legalitas -----
  @RequirePermission('company_document.view')
  @Get(':id/documents')
  daftarDokumen(@AksesStaff() a: Akses, @Param('id', new ZodPipe(IdParam)) id: string) {
    return this.dokumen.daftar(a, id);
  }

  @RequirePermission('company_document.create')
  @Post(':id/documents')
  @HttpCode(201)
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', required: ['berkas', 'kind', 'title'], properties: { berkas: { type: 'string', format: 'binary' }, kind: { type: 'string' }, title: { type: 'string' }, validUntil: { type: 'string' } } } })
  @UseInterceptors(FileInterceptor('berkas', { limits: { fileSize: BATAS_UNGGAH_BYTE + 1, files: 1, fields: 10 } }))
  unggah(@AksesStaff() a: Akses, @Param('id', new ZodPipe(IdParam)) id: string, @Body(new ZodPipe(DokumenPerusahaanBody)) b: z.infer<typeof DokumenPerusahaanBody>, @UploadedFile() berkas: BerkasMasuk | undefined) {
    return this.dokumen.unggah(a, id, b, berkas);
  }

  @RequirePermission('company_document.view')
  @Get(':id/documents/:docId/download')
  @ApiOkResponse({ description: 'Berkas dialirkan lewat API (tanpa URL publik); setiap unduhan diaudit' })
  async unduh(@AksesStaff() a: Akses, @Param('id', new ZodPipe(IdParam)) id: string, @Param('docId', new ZodPipe(IdParam)) docId: string, @Res() res: Response) {
    const d = await this.dokumen.unduh(a, id, docId);
    res.set({
      'Content-Type': d.mime,
      'Content-Length': String(d.data.length),
      'Content-Disposition': `attachment; filename="${ascii(d.nama)}"; filename*=UTF-8''${encodeURIComponent(d.nama)}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    });
    res.end(d.data);
  }

  @RequirePermission('company_document.update')
  @Delete(':id/documents/:docId')
  @HttpCode(204)
  async hapusDokumen(@AksesStaff() a: Akses, @Param('id', new ZodPipe(IdParam)) id: string, @Param('docId', new ZodPipe(IdParam)) docId: string) {
    await this.dokumen.hapus(a, id, docId);
  }
}
