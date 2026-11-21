import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { enkripsi } from '../common/crypto/crypto';
import { KUNCI, Kunci } from '../config/config.module';
import { POOL } from '../database/tokens';
import type { NamaTemplate } from './templates';

/**
 * Menaruh pesan di outbox. Payload (berisi tautan bertoken) dienkripsi dengan AAD terikat id baris
 * dan dikosongkan setelah terkirim. Pengiriman sebenarnya dilakukan OutboxWorker.
 */
@Injectable()
export class NotificationService {
  constructor(
    @Inject(POOL) private readonly pool: Pool,
    @Inject(KUNCI) private readonly kunci: Kunci,
  ) {}

  async enqueueEmail(p: { to: string; template: NamaTemplate; data: Record<string, string> }, c?: Pool | PoolClient): Promise<string> {
    const id = randomUUID();
    const payload = enkripsi(JSON.stringify(p.data), this.kunci.enkripsi, `outbox:${id}`);
    await (c ?? this.pool).query(
      `INSERT INTO notification_outbox (id, channel, recipient, template, payload_enc) VALUES ($1, 'email', $2, $3, $4)`,
      [id, p.to, p.template, payload],
    );
    return id;
  }
}
