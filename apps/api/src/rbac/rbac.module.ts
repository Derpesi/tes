import { Module } from '@nestjs/common';
import { AksesService } from './akses.service';

@Module({ providers: [AksesService], exports: [AksesService] })
export class RbacModule {}
