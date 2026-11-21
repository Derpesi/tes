import { Global, Module } from '@nestjs/common';
import { join } from 'node:path';
import { ENV } from '../../config/config.module';
import type { Env } from '../../config/env';
import { LocalObjectStorage } from './local-storage';
import { OBJECT_STORAGE } from './object-storage';

/** Driver lokal (dev/tes). Di produksi atur STORAGE_DIR ke volume privat; driver S3 menyusul setelah hosting dipilih. */
@Global()
@Module({
  providers: [{ provide: OBJECT_STORAGE, inject: [ENV], useFactory: (env: Env) => new LocalObjectStorage(env.STORAGE_DIR ?? join(process.cwd(), '.penyimpanan')) }],
  exports: [OBJECT_STORAGE],
})
export class StorageModule {}
