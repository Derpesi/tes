import { Global, Module } from '@nestjs/common';
import { createTransport } from 'nodemailer';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { EMAIL_CHANNEL, EmailChannel } from './email.channel';
import { NotificationService } from './notification.service';
import { OutboxWorker } from './outbox.worker';

/** Kanal SMTP. Tanpa SMTP_* kanal tidak tersedia dan pesan tetap menunggu di outbox. Tidak ada layanan berbayar. */
function buatKanalSmtp(env: Env): EmailChannel {
  if (!env.SMTP_HOST || !env.SMTP_PORT || !env.SMTP_FROM) {
    return { tersedia: () => false, kirim: async () => { throw new Error('SMTP belum dikonfigurasi'); } };
  }
  const transport = createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    ...(env.SMTP_USER && env.SMTP_PASSWORD ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } } : {}),
  });
  return {
    tersedia: () => true,
    kirim: async (p) => {
      await transport.sendMail({ from: env.SMTP_FROM, to: p.to, subject: p.subject, text: p.text });
    },
  };
}

@Global()
@Module({
  providers: [{ provide: EMAIL_CHANNEL, inject: [ENV], useFactory: buatKanalSmtp }, NotificationService, OutboxWorker],
  exports: [NotificationService, OutboxWorker, EMAIL_CHANNEL],
})
export class NotificationsModule {}
