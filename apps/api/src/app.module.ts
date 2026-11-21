import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { AdminModule } from './admin/admin.module';
import { AuditModule } from './audit/audit.module';
import { MasterModule } from './master/master.module';
import { MemberModule } from './member/member.module';
import { PkwtModule } from './pkwt/pkwt.module';
import { AttendanceModule } from './attendance/attendance.module';
import { PayrollModule } from './payroll/payroll.module';
import { PlacementsModule } from './placements/placements.module';
import { RecruitmentModule } from './recruitment/recruitment.module';
import { AuthModule } from './auth/auth.module';
import { opsiPinoHttp } from './common/log';
import { StorageModule } from './common/storage/storage.module';
import { ConfigModule } from './config/config.module';
import { NotificationsModule } from './notifications/notifications.module';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    LoggerModule.forRoot({ pinoHttp: opsiPinoHttp(process.env.NODE_ENV) }),
    // Pembatas laju bawaan per IP (memori, instance tunggal; keterbatasan dicatat di docs/security.md).
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 120 }]),
    ConfigModule,
    StorageModule,
    DatabaseModule,
    AuditModule,
    NotificationsModule,
    AuthModule,
    AdminModule,
    MasterModule,
    MemberModule,
    PkwtModule,
    PlacementsModule,
    AttendanceModule,
    PayrollModule,
    RecruitmentModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
