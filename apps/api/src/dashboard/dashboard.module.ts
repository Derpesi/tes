import { Module } from '@nestjs/common';
import { AttendanceModule } from '../attendance/attendance.module';
import { RbacModule } from '../rbac/rbac.module';
import { StaffDashboardController } from './staff-dashboard.controller';
import { StaffDashboardService } from './staff-dashboard.service';

@Module({ imports: [AttendanceModule, RbacModule], controllers: [StaffDashboardController], providers: [StaffDashboardService] })
export class DashboardModule {}
