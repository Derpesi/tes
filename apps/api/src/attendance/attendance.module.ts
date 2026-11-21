import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { MemberModule } from '../member/member.module';
import { AttendanceSetupController } from './attendance-setup.controller';
import { JAM_ABSENSI } from './jam';
import { MemberAttendanceController } from './member-attendance.controller';
import { MemberAttendanceService } from './member-attendance.service';
import { PointsService } from './points.service';
import { ScheduleService } from './schedule.service';

@Module({
  imports: [AuditModule, MemberModule],
  controllers: [AttendanceSetupController, MemberAttendanceController],
  providers: [PointsService, ScheduleService, MemberAttendanceService, { provide: JAM_ABSENSI, useValue: () => new Date() }],
  exports: [PointsService, ScheduleService],
})
export class AttendanceModule {}
