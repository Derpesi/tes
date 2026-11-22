import { Global, Inject, Injectable, Module, OnApplicationShutdown } from '@nestjs/common';
import { Pool } from 'pg';
import { muatEnv } from '../config/env';
import { ScopedDb } from './scoped-db';
import { POOL } from './tokens';

export { POOL };

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
    { provide: POOL, useFactory: () => new Pool({ connectionString: muatEnv().DATABASE_URL, max: muatEnv().DB_POOL_MAX }) },
    PoolShutdown,
    ScopedDb,
  ],
  exports: [POOL, ScopedDb],
})
export class DatabaseModule {}
