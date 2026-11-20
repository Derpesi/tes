import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { konfigurasiApp } from './app.factory';
import { muatEnv } from './config/env';

async function bootstrap() {
  const env = muatEnv(); // gagal cepat bila konfigurasi tidak valid
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  konfigurasiApp(app);
  await app.listen(env.PORT);
}
bootstrap();
