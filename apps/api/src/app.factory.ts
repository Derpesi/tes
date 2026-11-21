import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { muatEnv } from './config/env';
import { AllExceptionsFilter } from './common/all-exceptions.filter';

export function buatDokumenOpenApi(app: INestApplication) {
  return SwaggerModule.createDocument(
    app,
    new DocumentBuilder().setTitle('DAMARINDO GROUP HRIS API').setVersion('0.0.0').build(),
  );
}

export function konfigurasiApp(app: INestApplication) {
  app.use(cookieParser());
  app.useGlobalFilters(new AllExceptionsFilter());
  const proxy = muatEnv().TRUST_PROXY;
  if (proxy > 0) app.getHttpAdapter().getInstance().set('trust proxy', proxy);
  app.enableShutdownHooks();
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  SwaggerModule.setup('docs', app, buatDokumenOpenApi(app), { jsonDocumentUrl: 'openapi.json' });
}
