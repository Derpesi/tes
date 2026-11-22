import { BeforeApplicationShutdown, Controller, Get, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Pool } from 'pg';
import { POOL } from '../database/database.module';
import { Public } from '../auth/decorators';

/** Menandai proses sedang berhenti agar /ready segera gagal dan load balancer berhenti mengirim lalu lintas baru (graceful shutdown). */
@Injectable()
export class StatusProses implements BeforeApplicationShutdown {
  berhenti = false;
  beforeApplicationShutdown() {
    this.berhenti = true;
  }
}

@ApiTags('Kesehatan')
@Controller()
export class HealthController {
  constructor(
    @Inject(POOL) private readonly pool: Pool,
    private readonly status: StatusProses,
  ) {}

  /** Liveness: proses hidup dan database terjangkau. */
  @Public()
  @Get('health')
  @ApiOkResponse({ description: 'Layanan dan database sehat' })
  async cek() {
    try {
      await this.pool.query('SELECT 1');
    } catch {
      throw new ServiceUnavailableException({ kode: 'DATABASE_TIDAK_TERJANGKAU', message: 'Database tidak dapat dihubungi' });
    }
    return { status: 'ok', database: 'ok' };
  }

  /** Readiness: siap menerima lalu lintas (database terjangkau, migrasi sudah diterapkan, proses tidak sedang berhenti). */
  @Public()
  @Get('ready')
  @ApiOkResponse({ description: 'Siap menerima lalu lintas' })
  async siap() {
    if (this.status.berhenti) throw new ServiceUnavailableException({ kode: 'LAYANAN_BERHENTI', message: 'Layanan sedang berhenti' });
    try {
      const r = await this.pool.query('SELECT count(*)::int AS n FROM schema_migrations');
      if (r.rows[0].n < 1) throw new Error('migrasi belum diterapkan');
    } catch {
      throw new ServiceUnavailableException({ kode: 'BELUM_SIAP', message: 'Belum siap: database atau migrasi belum tersedia' });
    }
    return { status: 'siap' };
  }
}
