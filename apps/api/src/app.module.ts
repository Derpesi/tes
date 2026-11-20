import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { AuditModule } from './audit/audit.module';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
        // Jangan mencatat header sensitif atau body (potensi PII).
        redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
        serializers: {
          req: (r) => ({ id: r.id, method: r.method, url: r.url }),
          res: (r) => ({ statusCode: r.statusCode }),
        },
      },
    }),
    DatabaseModule,
    AuditModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
