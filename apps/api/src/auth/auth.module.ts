import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuditModule } from '../audit/audit.module';
import { RbacModule } from '../rbac/rbac.module';
import { ThrottlerSesiGuard } from '../common/throttler-sesi.guard';
import { AuthGuard } from './auth.guard';
import { BootstrapService } from './bootstrap.service';
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
  imports: [AuditModule, RbacModule],
  controllers: [StaffAuthController, MemberAuthController],
  providers: [
    SessionService,
    PasswordService,
    TotpService,
    InvitationService,
    BootstrapService,
    StaffAuthService,
    OidcService,
    MemberAuthService,
    // Guard global: semua rute wajib bersesi kecuali @Public() (deny-by-default).
    { provide: APP_GUARD, useClass: AuthGuard },
    // Pembatas laju SETELAH AuthGuard: sesi sah dihitung per pengguna (NAT/lokasi kerja tidak saling memblokir), selain itu per IP.
    { provide: APP_GUARD, useClass: ThrottlerSesiGuard },
  ],
  exports: [SessionService, InvitationService, PasswordService, BootstrapService],
})
export class AuthModule {}
