import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AllExceptionsFilter } from './common/all-exceptions.filter';

export function konfigurasiApp(app: INestApplication) {
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  const dokumen = SwaggerModule.createDocument(
    app,
    new DocumentBuilder().setTitle('DAMARINDO GROUP HRIS API').setVersion('0.0.0').build(),
  );
  SwaggerModule.setup('docs', app, dokumen, { jsonDocumentUrl: 'openapi.json' });
}
