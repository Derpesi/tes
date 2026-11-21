import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { MemberModule } from '../member/member.module';
import { PkwtModule } from '../pkwt/pkwt.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { PlacementsController } from './placements.controller';
import { PlacementsService } from './placements.service';

@Module({
  imports: [AuditModule, PkwtModule, MemberModule],
  controllers: [PlacementsController, DashboardController],
  providers: [PlacementsService, DashboardService],
})
export class PlacementsModule {}
