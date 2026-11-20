import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AllExceptionsFilter } from './common/all-exceptions.filter';

export function buatDokumenOpenApi(app: INestApplication) {
  return SwaggerModule.createDocument(
    app,
    new DocumentBuilder().setTitle('DAMARINDO GROUP HRIS API').setVersion('0.0.0').build(),
  );
}

export function konfigurasiApp(app: INestApplication) {
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  SwaggerModule.setup('docs', app, buatDokumenOpenApi(app), { jsonDocumentUrl: 'openapi.json' });
}
