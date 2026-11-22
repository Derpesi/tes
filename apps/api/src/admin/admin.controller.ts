import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe';
import type { Akses } from '../rbac/akses.service';
import { AksesStaff, RequirePermission } from '../rbac/rbac.decorators';
import { ApprovalService } from './approval.service';
import { AuditViewerService } from './audit-viewer.service';
import { ApprovalQuery, AuditQuery, BeriPeranBody, BeriScopeBody, DaftarQuery, IdParam, KeputusanBody, KodePeranParam, UndangBody } from './schemas';
import { StaffAdminService } from './staff-admin.service';

@ApiTags('Administrasi Staff')
@Controller()
export class AdminController {
  constructor(
    private readonly staff: StaffAdminService,
    private readonly approvals: ApprovalService,
    private readonly auditViewer: AuditViewerService,
  ) {}

  // ----- peran & staff -----
  @RequirePermission('user_role.view')
  @Get('roles')
  @ApiOkResponse({ description: 'Daftar peran beserta permission-nya' })
  roles() {
    return this.staff.daftarPeran();
  }

  @RequirePermission('user_role.view')
  @Get('staff')
  @ApiOkResponse({ description: 'Daftar staff (keyset pagination)' })
  daftar(@Query(new ZodPipe(DaftarQuery)) q: z.infer<typeof DaftarQuery>) {
    return this.staff.daftarStaff(q.cursor, q.limit);
  }

  @RequirePermission('user_role.create')
  @Post('staff/invitations')
  @HttpCode(201)
  @ApiOkResponse({ description: 'Undangan dikirim lewat email; token tidak pernah dikembalikan. Peran berhak tinggi menunggu persetujuan.' })
  undang(@AksesStaff() a: Akses, @Body(new ZodPipe(UndangBody)) b: z.infer<typeof UndangBody>) {
    return this.staff.undang(a, b);
  }

  @RequirePermission('user_role.create')
  @Post('staff/:id/roles')
  @HttpCode(200)
  beriPeran(@AksesStaff() a: Akses, @Param('id', new ZodPipe(IdParam)) id: string, @Body(new ZodPipe(BeriPeranBody)) b: z.infer<typeof BeriPeranBody>) {
    return this.staff.beriPeran(a, id, b.roleCode, b.expiresAt ? new Date(b.expiresAt) : null);
  }

  @RequirePermission('user_role.deactivate')
  @Delete('staff/:id/roles/:roleCode')
  @HttpCode(204)
  async cabutPeran(@AksesStaff() a: Akses, @Param('id', new ZodPipe(IdParam)) id: string, @Param('roleCode', new ZodPipe(KodePeranParam)) roleCode: string) {
    await this.staff.cabutPeran(a, id, roleCode);
  }

  @RequirePermission('user_role.update')
  @Post('staff/:id/companies')
  @HttpCode(204)
  async beriScope(@AksesStaff() a: Akses, @Param('id', new ZodPipe(IdParam)) id: string, @Body(new ZodPipe(BeriScopeBody)) b: z.infer<typeof BeriScopeBody>) {
    await this.staff.beriScope(a, id, b.companyId);
  }

  @RequirePermission('user_role.update')
  @Delete('staff/:id/companies/:companyId')
  @HttpCode(204)
  async cabutScope(@AksesStaff() a: Akses, @Param('id', new ZodPipe(IdParam)) id: string, @Param('companyId', new ZodPipe(IdParam)) companyId: string) {
    await this.staff.cabutScope(a, id, companyId);
  }

  @RequirePermission('user_role.update')
  @Post('staff/:id/all-companies')
  @HttpCode(202)
  @ApiOkResponse({ description: 'Akses seluruh perusahaan memerlukan persetujuan Direktur' })
  mintaSemuaPerusahaan(@AksesStaff() a: Akses, @Param('id', new ZodPipe(IdParam)) id: string) {
    return this.approvals.mintaAksesSemuaPerusahaan(a, id);
  }

  @RequirePermission('user_role.update')
  @Delete('staff/:id/all-companies')
  @HttpCode(204)
  async cabutSemua(@AksesStaff() a: Akses, @Param('id', new ZodPipe(IdParam)) id: string) {
    await this.staff.cabutSemuaPerusahaan(a, id);
  }

  @RequirePermission('user_role.deactivate')
  @Post('staff/:id/deactivate')
  @HttpCode(204)
  async nonaktifkan(@AksesStaff() a: Akses, @Param('id', new ZodPipe(IdParam)) id: string) {
    await this.staff.nonaktifkan(a, id);
  }

  @RequirePermission('user_role.update')
  @Post('staff/:id/mfa-reset')
  @HttpCode(202)
  @ApiOkResponse({ description: 'Reset MFA memerlukan persetujuan Direktur; setelah disetujui akun kembali ke undangan' })
  mintaResetMfa(@AksesStaff() a: Akses, @Param('id', new ZodPipe(IdParam)) id: string) {
    return this.approvals.mintaResetMfa(a, id);
  }

  // ----- persetujuan -----
  @RequirePermission('user_role.view')
  @Get('approvals')
  daftarApproval(@Query(new ZodPipe(ApprovalQuery)) q: z.infer<typeof ApprovalQuery>) {
    return this.approvals.daftar(q.status);
  }

  @RequirePermission('user_role.approve')
  @Post('approvals/:id/approve')
  @HttpCode(200)
  setujui(@AksesStaff() a: Akses, @Param('id', new ZodPipe(IdParam)) id: string, @Body(new ZodPipe(KeputusanBody)) b: z.infer<typeof KeputusanBody>) {
    return this.approvals.putuskan(a, id, true, b.note);
  }

  @RequirePermission('user_role.approve')
  @Post('approvals/:id/reject')
  @HttpCode(200)
  tolak(@AksesStaff() a: Akses, @Param('id', new ZodPipe(IdParam)) id: string, @Body(new ZodPipe(KeputusanBody)) b: z.infer<typeof KeputusanBody>) {
    return this.approvals.putuskan(a, id, false, b.note);
  }

  // ----- audit -----
  @RequirePermission('audit_log.view')
  @Get('audit-logs')
  @ApiOkResponse({ description: 'Audit log terbatas scope (RLS) dan kategori menurut peran (IT: teknis tanpa detail; Keuangan: transaksi); keyset pagination' })
  audit(@AksesStaff() a: Akses, @Query(new ZodPipe(AuditQuery)) q: z.infer<typeof AuditQuery>) {
    return this.auditViewer.baca(a, { action: q.action, kategori: q.kategori, objectType: q.objectType, objectId: q.objectId, actorId: q.actorId, companyId: q.companyId, from: q.from ? new Date(q.from) : undefined, to: q.to ? new Date(q.to) : undefined, cursor: q.cursor, limit: q.limit });
  }
}
