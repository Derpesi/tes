import { Global, Module } from '@nestjs/common';
import { cincinKunci, type KunciEnkripsi } from '../common/crypto/crypto';
import { daftarKunciEnkripsi, Env, muatEnv } from './env';

export const ENV = Symbol('ENV');
export const KUNCI = Symbol('KUNCI');

export interface Kunci {
  /** Kunci HMAC untuk menyamarkan email/IP, token CSRF, dan hash kode pemulihan. */
  hmac: Buffer;
  /** Cincin kunci AES-256-GCM berversi (secret MFA, outbox, NIK, berkas). Penulisan baru memakai kunci aktif (id tertinggi). */
  enkripsi: KunciEnkripsi;
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
        enkripsi: cincinKunci(daftarKunciEnkripsi(env).map((k) => ({ id: k.id, kunci: Buffer.from(k.b64, 'base64') }))),
      }),
    },
  ],
  exports: [ENV, KUNCI],
})
export class ConfigModule {}
