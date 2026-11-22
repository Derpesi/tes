import { Controller, Get, Param, Query, Res, UseInterceptors } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { LaporanBeratInterceptor } from '../common/batas-konkurensi';
import { ZodPipe } from '../common/zod.pipe';
import type { Akses } from '../rbac/akses.service';
import { AksesStaff, RequirePermission } from '../rbac/rbac.decorators';
import { ReportsService } from './reports.service';
import { LaporanQuery, NamaLaporan, NamaParam } from './schemas';

/** Laporan konsolidasi (hanya baca). Bagian laporan mensyaratkan izin domain tambahan; bagian tanpa izin dihilangkan. Tidak ada laporan untuk rekanan atau member. */
@ApiTags('Laporan')
@Controller('reports')
export class ReportsController {
  constructor(private readonly svc: ReportsService) {}

  @RequirePermission('report_consolidated.view')
  @UseInterceptors(LaporanBeratInterceptor)
  @Get(':nama')
  @ApiOkResponse({ description: 'Laporan agregat per perusahaan dalam scope (RLS); rentang maksimal 366 hari; tanpa data pribadi' })
  ambil(@AksesStaff() a: Akses, @Param('nama', new ZodPipe(NamaParam)) nama: NamaLaporan, @Query(new ZodPipe(LaporanQuery)) q: z.infer<typeof LaporanQuery>) {
    return this.svc.ambil(a, nama, q);
  }

  @RequirePermission('report_consolidated.export')
  @UseInterceptors(LaporanBeratInterceptor)
  @Get(':nama/export.csv')
  @ApiOkResponse({ description: 'Ekspor CSV (BOM UTF-8; sel berawalan = + - @ dinetralkan; maksimal 5.000 baris); diaudit' })
  async csv(@AksesStaff() a: Akses, @Param('nama', new ZodPipe(NamaParam)) nama: NamaLaporan, @Query(new ZodPipe(LaporanQuery)) q: z.infer<typeof LaporanQuery>, @Res() res: Response) {
    const isi = await this.svc.ekspor(a, nama, q);
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="laporan-${nama}-${q.from}_${q.to}.csv"`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' });
    res.end(isi);
  }
}
