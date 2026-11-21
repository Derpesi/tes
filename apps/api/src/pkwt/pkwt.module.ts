import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { ContractLifecycleService } from './lifecycle.service';
import { MemberStatusService } from './member-status.service';
import { NumberingService } from './numbering.service';
import { PkwtController } from './pkwt.controller';
import { PkwtService } from './pkwt.service';
import { TemplatesController } from './templates.controller';
import { TemplatesService } from './templates.service';

@Module({
  imports: [AuditModule],
  controllers: [TemplatesController, PkwtController],
  providers: [TemplatesService, NumberingService, PkwtService, MemberStatusService, ContractLifecycleService],
  exports: [TemplatesService, NumberingService, PkwtService, MemberStatusService, ContractLifecycleService],
})
export class PkwtModule {}
