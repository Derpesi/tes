import { Controller, Get, Req } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { RequestDenganSesi } from '../auth/auth.guard';
import { Sesi } from '../auth/decorators';
import { AksesService } from '../rbac/akses.service';
import { StaffDashboardService } from './staff-dashboard.service';

@ApiTags('Dashboard')
@Controller('dashboard')
export class StaffDashboardController {
  constructor(
    private readonly svc: StaffDashboardService,
    private readonly akses: AksesService,
  ) {}

  /** Setiap staf dengan sesi penuh; isi menyesuaikan izin. Tidak ada dashboard untuk rekanan atau member (member memakai /member/dashboard). */
  @Sesi({ realm: 'staff' })
  @Get('staff')
  @ApiOkResponse({ description: 'Widget dashboard sesuai izin pemanggil (angka agregat, scope perusahaan lewat RLS)' })
  async staf(@Req() req: RequestDenganSesi) {
    return this.svc.ambil(await this.akses.muat(req.sesi!.userId));
  }
}
