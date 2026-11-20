import { Global, Inject, Injectable, Module, OnApplicationShutdown } from '@nestjs/common';
import { Pool } from 'pg';
import { muatEnv } from '../config/env';

export const POOL = Symbol('PG_POOL');

@Injectable()
class PoolShutdown implements OnApplicationShutdown {
  constructor(@Inject(POOL) private readonly pool: Pool) {}
  async onApplicationShutdown() {
    await this.pool.end();
  }
}

@Global()
@Module({
  providers: [
    { provide: POOL, useFactory: () => new Pool({ connectionString: muatEnv().DATABASE_URL, max: 10 }) },
    PoolShutdown,
  ],
  exports: [POOL],
})
export class DatabaseModule {}
