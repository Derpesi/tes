import type { PesanEmail } from './templates';

export const EMAIL_CHANNEL = Symbol('EMAIL_CHANNEL');

/** Antarmuka kanal email. Kanal lain (WhatsApp, push) akan menyusul dengan bentuk serupa. */
export interface EmailChannel {
  /** false bila SMTP belum dikonfigurasi (pesan tetap di outbox). */
  tersedia(): boolean;
  kirim(pesan: PesanEmail): Promise<void>;
}
