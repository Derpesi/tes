import { Injectable } from '@nestjs/common';
import { generateSecret, generateURI, verifySync } from 'otplib';
import { ISSUER_TOTP } from './auth.constants';

export type HasilTotp = { valid: false } | { valid: true; timeStep: number };

@Injectable()
export class TotpService {
  buatSecret(): string {
    return generateSecret();
  }

  uri(email: string, secret: string): string {
    return generateURI({ issuer: ISSUER_TOTP, label: email, secret });
  }

  /**
   * Memverifikasi kode 6 digit dengan toleransi ±30 detik. `afterTimeStep` = time-step terakhir yang
   * pernah dipakai; kode dengan time-step <= nilai itu ditolak (proteksi pakai-ulang).
   */
  verifikasi(secret: string, kode: string, afterTimeStep?: number): HasilTotp {
    if (!/^\d{6}$/.test(kode)) return { valid: false };
    const r = verifySync({ secret, token: kode, epochTolerance: 30, ...(afterTimeStep !== undefined ? { afterTimeStep } : {}) });
    return r.valid && 'timeStep' in r ? { valid: true, timeStep: r.timeStep } : { valid: false };
  }
}
