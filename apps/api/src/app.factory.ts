import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { docsAktif, muatEnv } from './config/env';
import { AllExceptionsFilter } from './common/all-exceptions.filter';

export function buatDokumenOpenApi(app: INestApplication) {
  return SwaggerModule.createDocument(
    app,
    new DocumentBuilder().setTitle('DAMARINDO GROUP HRIS API').setVersion('0.0.0').build(),
  );
}

/** Header keamanan untuk SEMUA respons API (lapis kedua; web juga memasangnya). Endpoint tertentu dapat menimpa Cache-Control. */
export const HEADER_KEAMANAN_API: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

export function konfigurasiApp(app: INestApplication) {
  app.use((_req: unknown, res: { setHeader(k: string, v: string): void }, next: () => void) => {
    for (const [k, v] of Object.entries(HEADER_KEAMANAN_API)) res.setHeader(k, v);
    next();
  });
  app.use(cookieParser());
  app.useGlobalFilters(new AllExceptionsFilter());
  const proxy = muatEnv().TRUST_PROXY;
  if (proxy > 0) app.getHttpAdapter().getInstance().set('trust proxy', proxy);
  app.enableShutdownHooks();
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  // Dokumentasi API dimatikan di produksi (kecuali API_DOCS=on) agar daftar endpoint tidak terbuka untuk umum.
  if (docsAktif(muatEnv())) SwaggerModule.setup('docs', app, buatDokumenOpenApi(app), { jsonDocumentUrl: 'openapi.json' });
}
