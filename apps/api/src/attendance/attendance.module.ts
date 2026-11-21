import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { MemberModule } from '../member/member.module';
import { AdjustmentsService } from './adjustments.service';
import { AttendanceOpsController } from './attendance-ops.controller';
import { AttendanceSetupController } from './attendance-setup.controller';
import { JAM_ABSENSI } from './jam';
import { MemberAttendanceController } from './member-attendance.controller';
import { MemberAttendanceService } from './member-attendance.service';
import { PointsService } from './points.service';
import { RecapService } from './recap.service';
import { ReviewService } from './review.service';
import { ScheduleService } from './schedule.service';
import { SelfieService } from './selfie.service';

@Module({
  imports: [AuditModule, MemberModule],
  controllers: [AttendanceSetupController, AttendanceOpsController, MemberAttendanceController],
  providers: [PointsService, ScheduleService, MemberAttendanceService, ReviewService, SelfieService, AdjustmentsService, RecapService, { provide: JAM_ABSENSI, useValue: () => new Date() }],
  exports: [PointsService, ScheduleService, SelfieService, RecapService],
})
export class AttendanceModule {}
