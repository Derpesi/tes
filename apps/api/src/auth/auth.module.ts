import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuditModule } from '../audit/audit.module';
import { AuthGuard } from './auth.guard';
import { InvitationService } from './invitation.service';
import { MemberAuthController } from './member-auth.controller';
import { MemberAuthService } from './member-auth.service';
import { OidcService } from './oidc.service';
import { PasswordService } from './password.service';
import { SessionService } from './session.service';
import { StaffAuthController } from './staff-auth.controller';
import { StaffAuthService } from './staff-auth.service';
import { TotpService } from './totp.service';

@Module({
  imports: [AuditModule],
  controllers: [StaffAuthController, MemberAuthController],
  providers: [
    SessionService,
    PasswordService,
    TotpService,
    InvitationService,
    StaffAuthService,
    OidcService,
    MemberAuthService,
    // Guard global: semua rute wajib bersesi kecuali @Public() (deny-by-default).
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [SessionService, InvitationService, PasswordService],
})
export class AuthModule {}
