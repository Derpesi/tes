import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe';
import type { Akses } from '../rbac/akses.service';
import { AksesStaff, RequirePermission } from '../rbac/rbac.decorators';
import { PartnersService } from './partners.service';
import { DaftarRekananQuery, IdParam, KebutuhanBuat, KontakBuat, KontakUbah, LokasiBuat, LokasiUbah, RekananBuat, RekananUbah } from './schemas';

const id = (nama: string) => Param(nama, new ZodPipe(IdParam));

/** Rekanan = master data internal. TIDAK ADA rute login/akun/portal rekanan (diuji otomatis). */
@ApiTags('Rekanan dan Lokasi')
@Controller()
export class PartnersController {
  constructor(private readonly svc: PartnersService) {}

  @RequirePermission('partner.view')
  @Get('partners')
  @ApiOkResponse({ description: 'Rekanan dalam scope pengguna; keyset pagination' })
  daftar(@AksesStaff() a: Akses, @Query(new ZodPipe(DaftarRekananQuery)) q: z.infer<typeof DaftarRekananQuery>) {
    return this.svc.daftarRekanan(a, q);
  }

  @RequirePermission('partner.view')
  @Get('partners/:id')
  detail(@AksesStaff() a: Akses, @id('id') i: string) {
    return this.svc.detailRekanan(a, i);
  }

  @RequirePermission('partner.create')
  @Post('partners')
  @HttpCode(201)
  buat(@AksesStaff() a: Akses, @Body(new ZodPipe(RekananBuat)) b: z.infer<typeof RekananBuat>) {
    return this.svc.buatRekanan(a, b);
  }

  @RequirePermission('partner.update')
  @Patch('partners/:id')
  ubah(@AksesStaff() a: Akses, @id('id') i: string, @Body(new ZodPipe(RekananUbah)) b: z.infer<typeof RekananUbah>) {
    return this.svc.ubahRekanan(a, i, b);
  }

  @RequirePermission('partner.deactivate')
  @Post('partners/:id/deactivate')
  @HttpCode(204)
  async nonaktifkan(@AksesStaff() a: Akses, @id('id') i: string) {
    await this.svc.nonaktifkanRekanan(a, i);
  }

  // ----- kontak -----
  @RequirePermission('partner.view')
  @Get('partners/:id/contacts')
  daftarKontak(@AksesStaff() a: Akses, @id('id') i: string) {
    return this.svc.daftarKontak(a, i);
  }

  @RequirePermission('partner.create')
  @Post('partners/:id/contacts')
  @HttpCode(201)
  buatKontak(@AksesStaff() a: Akses, @id('id') i: string, @Body(new ZodPipe(KontakBuat)) b: z.infer<typeof KontakBuat>) {
    return this.svc.buatKontak(a, i, b);
  }

  @RequirePermission('partner.update')
  @Patch('partners/:id/contacts/:kontakId')
  ubahKontak(@AksesStaff() a: Akses, @id('id') i: string, @id('kontakId') k: string, @Body(new ZodPipe(KontakUbah)) b: z.infer<typeof KontakUbah>) {
    return this.svc.ubahKontak(a, i, k, b);
  }

  @RequirePermission('partner.deactivate')
  @Post('partners/:id/contacts/:kontakId/deactivate')
  @HttpCode(204)
  async nonaktifkanKontak(@AksesStaff() a: Akses, @id('id') i: string, @id('kontakId') k: string) {
    await this.svc.nonaktifkanKontak(a, i, k);
  }

  // ----- lokasi -----
  @RequirePermission('partner.view')
  @Get('partners/:id/locations')
  daftarLokasi(@AksesStaff() a: Akses, @id('id') i: string) {
    return this.svc.daftarLokasi(a, i);
  }

  @RequirePermission('partner.create')
  @Post('partners/:id/locations')
  @HttpCode(201)
  buatLokasi(@AksesStaff() a: Akses, @id('id') i: string, @Body(new ZodPipe(LokasiBuat)) b: z.infer<typeof LokasiBuat>) {
    return this.svc.buatLokasi(a, i, b);
  }

  @RequirePermission('partner.view')
  @Get('locations/:lokasiId')
  detailLokasi(@AksesStaff() a: Akses, @id('lokasiId') l: string) {
    return this.svc.detailLokasi(a, l);
  }

  @RequirePermission('partner.update')
  @Patch('locations/:lokasiId')
  ubahLokasi(@AksesStaff() a: Akses, @id('lokasiId') l: string, @Body(new ZodPipe(LokasiUbah)) b: z.infer<typeof LokasiUbah>) {
    return this.svc.ubahLokasi(a, l, b);
  }

  @RequirePermission('partner.deactivate')
  @Post('locations/:lokasiId/deactivate')
  @HttpCode(204)
  async nonaktifkanLokasi(@AksesStaff() a: Akses, @id('lokasiId') l: string) {
    await this.svc.nonaktifkanLokasi(a, l);
  }

  // ----- kebutuhan tenaga kerja -----
  @RequirePermission('partner.view')
  @Get('locations/:lokasiId/manpower')
  daftarKebutuhan(@AksesStaff() a: Akses, @id('lokasiId') l: string) {
    return this.svc.daftarKebutuhan(a, l);
  }

  @RequirePermission('partner.update')
  @Post('locations/:lokasiId/manpower')
  @HttpCode(201)
  buatKebutuhan(@AksesStaff() a: Akses, @id('lokasiId') l: string, @Body(new ZodPipe(KebutuhanBuat)) b: z.infer<typeof KebutuhanBuat>) {
    return this.svc.buatKebutuhan(a, l, b);
  }
}
