import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AttendanceSetupController } from './attendance-setup.controller';
import { PointsService } from './points.service';
import { ScheduleService } from './schedule.service';

@Module({
  imports: [AuditModule],
  controllers: [AttendanceSetupController],
  providers: [PointsService, ScheduleService],
  exports: [PointsService, ScheduleService],
})
export class AttendanceModule {}
