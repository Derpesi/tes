import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Pool } from 'pg';
import { POOL } from '../database/database.module';

@ApiTags('Kesehatan')
@Controller('health')
export class HealthController {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  @Get()
  @ApiOkResponse({ description: 'Layanan dan database sehat' })
  async cek() {
    try {
      await this.pool.query('SELECT 1');
    } catch {
      throw new ServiceUnavailableException('Database tidak dapat dihubungi');
    }
    return { status: 'ok', database: 'ok' };
  }
}
