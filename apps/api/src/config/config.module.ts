import { Global, Module } from '@nestjs/common';
import { Env, muatEnv } from './env';

export const ENV = Symbol('ENV');
export const KUNCI = Symbol('KUNCI');

export interface Kunci {
  /** Kunci HMAC untuk menyamarkan email/IP, token CSRF, dan hash kode pemulihan. */
  hmac: Buffer;
  /** Kunci AES-256-GCM untuk secret MFA dan payload outbox. */
  enkripsi: Buffer;
}

@Global()
@Module({
  providers: [
    { provide: ENV, useFactory: (): Env => muatEnv() },
    {
      provide: KUNCI,
      inject: [ENV],
      useFactory: (env: Env): Kunci => ({
        hmac: Buffer.from(env.AUTH_HMAC_KEY, 'base64'),
        enkripsi: Buffer.from(env.APP_ENCRYPTION_KEY, 'base64'),
      }),
    },
  ],
  exports: [ENV, KUNCI],
})
export class ConfigModule {}
