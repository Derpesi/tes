import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { MemberContextService } from './member-context.service';
import { MemberController } from './member.controller';
import { MemberDocumentsService } from './member-documents.service';
import { MemberProfileService } from './member-profile.service';

@Module({
  imports: [AuditModule],
  controllers: [MemberController],
  providers: [MemberContextService, MemberProfileService, MemberDocumentsService],
  exports: [MemberContextService, MemberProfileService, MemberDocumentsService],
})
export class MemberModule {}
