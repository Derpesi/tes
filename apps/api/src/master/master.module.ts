import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { AuditModule } from '../audit/audit.module';
import { CompaniesService } from './companies.service';
import { CompanyDocumentsService } from './company-documents.service';
import { MasterController } from './master.controller';
import { PartnersController } from './partners.controller';
import { PartnersService } from './partners.service';
import { SeedPerusahaanService } from './seed-perusahaan.service';

@Module({
  imports: [AdminModule, AuditModule],
  controllers: [MasterController, PartnersController],
  providers: [CompaniesService, CompanyDocumentsService, PartnersService, SeedPerusahaanService],
  exports: [SeedPerusahaanService],
})
export class MasterModule {}
