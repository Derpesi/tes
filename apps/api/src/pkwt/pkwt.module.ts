import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { NumberingService } from './numbering.service';
import { TemplatesController } from './templates.controller';
import { TemplatesService } from './templates.service';

@Module({
  imports: [AuditModule],
  controllers: [TemplatesController],
  providers: [TemplatesService, NumberingService],
  exports: [TemplatesService, NumberingService],
})
export class PkwtModule {}
