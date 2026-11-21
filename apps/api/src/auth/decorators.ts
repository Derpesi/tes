import { SetMetadata } from '@nestjs/common';
import type { Realm, StateSesi } from './auth.constants';

export const PUBLIK = 'auth:publik';
/** Endpoint tanpa sesi (mis. login). Tetap dikenai pemeriksaan Origin untuk method tulis. */
export const Public = () => SetMetadata(PUBLIK, true);

export const OPSI_SESI = 'auth:opsi-sesi';
export interface OpsiSesi {
  realm?: Realm;
  /** State sesi yang diterima. Bawaan: hanya PENUH. */
  states: StateSesi[];
}
export const Sesi = (opsi: Partial<OpsiSesi> = {}) => SetMetadata(OPSI_SESI, { states: ['PENUH'], ...opsi });
