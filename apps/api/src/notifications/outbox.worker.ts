import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Pool } from 'pg';
import { dekripsi } from '../common/crypto/crypto';
import { ENV, KUNCI, Kunci } from '../config/config.module';
import type { Env } from '../config/env';
import { POOL } from '../database/tokens';
import { EMAIL_CHANNEL, EmailChannel } from './email.channel';
import { NamaTemplate, renderTemplate } from './templates';

const MAKS_PERCOBAAN = 5;

@Injectable()
export class OutboxWorker implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(OutboxWorker.name);
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(POOL) private readonly pool: Pool,
    @Inject(KUNCI) private readonly kunci: Kunci,
    @Inject(ENV) private readonly env: Env,
    @Inject(EMAIL_CHANNEL) private readonly kanal: EmailChannel,
  ) {}

  onModuleInit() {
    if (this.env.NODE_ENV === 'test') return; // tes memanggil prosesBatch() secara eksplisit
    if (!this.kanal.tersedia()) {
      this.log.warn('SMTP belum dikonfigurasi: email di outbox tidak akan dikirim sampai SMTP_* diisi');
      return;
    }
    this.timer = setInterval(() => void this.prosesBatch().catch((e) => this.log.error(`Outbox gagal: ${(e as Error).message}`)), 5000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Mengirim pesan yang jatuh tempo. Aman dijalankan paralel (FOR UPDATE SKIP LOCKED). Mengembalikan jumlah terkirim. */
  async prosesBatch(batas = 10): Promise<number> {
    if (!this.kanal.tersedia()) return 0;
    const c = await this.pool.connect();
    let terkirim = 0;
    try {
      await c.query('BEGIN');
      const { rows } = await c.query(
        `SELECT id, recipient, template, payload_enc, attempts FROM notification_outbox
          WHERE status = 'MENUNGGU' AND next_attempt_at <= now() ORDER BY created_at
          FOR UPDATE SKIP LOCKED LIMIT $1`,
        [batas],
      );
      for (const r of rows) {
        try {
          const data = JSON.parse(dekripsi(r.payload_enc, this.kunci.enkripsi, `outbox:${r.id}`).toString()) as Record<string, string>;
          await this.kanal.kirim(renderTemplate(r.template as NamaTemplate, r.recipient, data));
          await c.query(`UPDATE notification_outbox SET status = 'TERKIRIM', payload_enc = NULL, sent_at = now(), last_error = NULL WHERE id = $1`, [r.id]);
          terkirim++;
        } catch (e) {
          const percobaan = r.attempts + 1;
          const gagal = percobaan >= MAKS_PERCOBAAN;
          // Hanya simpan jenis error (bukan isi pesan/payload) agar tidak membocorkan token.
          await c.query(
            `UPDATE notification_outbox SET attempts = $2, status = $3, last_error = $4,
                    next_attempt_at = now() + ($5 * interval '1 second') WHERE id = $1`,
            [r.id, percobaan, gagal ? 'GAGAL' : 'MENUNGGU', (e as Error).name.slice(0, 100), 30 * 2 ** percobaan],
          );
        }
      }
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
    return terkirim;
  }
}
