import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { RbacModule } from '../rbac/rbac.module';
import { AdminController } from './admin.controller';
import { ApprovalService } from './approval.service';
import { AuditViewerService } from './audit-viewer.service';
import { StaffAdminService } from './staff-admin.service';

@Module({
  imports: [AuthModule, AuditModule, RbacModule],
  controllers: [AdminController],
  providers: [StaffAdminService, ApprovalService, AuditViewerService],
})
export class AdminModule {}
