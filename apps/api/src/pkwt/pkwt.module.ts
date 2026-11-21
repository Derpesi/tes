import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { NumberingService } from './numbering.service';
import { PkwtController } from './pkwt.controller';
import { PkwtService } from './pkwt.service';
import { TemplatesController } from './templates.controller';
import { TemplatesService } from './templates.service';

@Module({
  imports: [AuditModule],
  controllers: [TemplatesController, PkwtController],
  providers: [TemplatesService, NumberingService, PkwtService],
  exports: [TemplatesService, NumberingService, PkwtService],
})
export class PkwtModule {}
