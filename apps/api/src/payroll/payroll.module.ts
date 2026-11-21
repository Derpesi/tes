import { Module } from '@nestjs/common';
import { AttendanceModule } from '../attendance/attendance.module';
import { AuditModule } from '../audit/audit.module';
import { AlurService } from './alur.service';
import { ExportService } from './export.service';
import { PayrollController } from './payroll.controller';
import { PayrollService } from './payroll.service';

@Module({
  imports: [AuditModule, AttendanceModule],
  controllers: [PayrollController],
  providers: [PayrollService, AlurService, ExportService],
  exports: [PayrollService],
})
export class PayrollModule {}
