import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { MemberModule } from '../member/member.module';
import { ApplicationsService } from './applications.service';
import { MemberRecruitmentController } from './member-recruitment.controller';
import { MemberRecruitmentService } from './member-recruitment.service';
import { RecruitmentController } from './recruitment.controller';
import { VacanciesService } from './vacancies.service';

@Module({
  imports: [AuditModule, MemberModule],
  controllers: [RecruitmentController, MemberRecruitmentController],
  providers: [VacanciesService, ApplicationsService, MemberRecruitmentService],
})
export class RecruitmentModule {}
