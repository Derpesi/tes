import { Controller, Get, Query, Req } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { RequestDenganSesi } from '../auth/auth.guard';
import { Sesi } from '../auth/decorators';
import { ZodPipe } from '../common/zod.pipe';
import type { Akses } from '../rbac/akses.service';
import { AksesStaff, RequirePermission } from '../rbac/rbac.decorators';
import { DashboardService } from './dashboard.service';
import { DaftarKaryawanQuery } from './schemas';

@ApiTags('Dashboard')
@Controller()
export class DashboardController {
  constructor(private readonly svc: DashboardService) {}

  @Sesi({ realm: 'member' })
  @Get('member/dashboard')
  @ApiOkResponse({ description: 'Dashboard member: status, kontrak, penempatan; hanya data miliknya' })
  member(@Req() req: RequestDenganSesi) {
    return this.svc.member(req.sesi!.userId);
  }

  @RequirePermission('placement.view')
  @Get('employees')
  @ApiOkResponse({ description: 'Karyawan aktif dalam scope perusahaan (tanpa NIK/kontak); keyset' })
  karyawan(@AksesStaff() a: Akses, @Query(new ZodPipe(DaftarKaryawanQuery)) q: z.infer<typeof DaftarKaryawanQuery>) {
    return this.svc.karyawan(a, q);
  }

  @RequirePermission('placement.view')
  @Get('employees/summary')
  @ApiOkResponse({ description: 'Ringkasan karyawan aktif, ditangguhkan, kontrak akan berakhir, dan per lokasi' })
  ringkasan(@AksesStaff() a: Akses) {
    return this.svc.ringkasan(a);
  }
}
