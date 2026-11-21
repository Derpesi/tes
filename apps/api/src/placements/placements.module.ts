import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PkwtModule } from '../pkwt/pkwt.module';
import { PlacementsController } from './placements.controller';
import { PlacementsService } from './placements.service';

@Module({
  imports: [AuditModule, PkwtModule],
  controllers: [PlacementsController],
  providers: [PlacementsService],
})
export class PlacementsModule {}
