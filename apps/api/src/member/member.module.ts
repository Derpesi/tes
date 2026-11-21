import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { MemberContextService } from './member-context.service';
import { MemberController } from './member.controller';
import { MemberDocumentsService } from './member-documents.service';
import { MemberProfileService } from './member-profile.service';
import { MembersAdminService } from './members-admin.service';
import { MembersController } from './members.controller';

@Module({
  imports: [AuditModule],
  controllers: [MemberController, MembersController],
  providers: [MemberContextService, MemberProfileService, MemberDocumentsService, MembersAdminService],
  exports: [MemberContextService, MemberProfileService, MemberDocumentsService],
})
export class MemberModule {}
