import { applyDecorators, createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import { Sesi } from '../auth/decorators';
import type { Akses } from './akses.service';

export const IZIN = 'rbac:izin';

/**
 * Mewajibkan sesi staff PENUH dan permission granular (mis. 'user_role.create'). Izin dihitung dari database
 * pada setiap permintaan. Rute tanpa @Public(), @Sesi(), atau @RequirePermission() ditolak (deny-by-default).
 */
export const RequirePermission = (kode: string) => applyDecorators(SetMetadata(IZIN, kode), Sesi({ realm: 'staff' }));

/** Mengambil hak akses staff yang sudah dihitung guard (hanya pada rute @RequirePermission). */
export const AksesStaff = createParamDecorator((_data: unknown, ctx: ExecutionContext): Akses => ctx.switchToHttp().getRequest().akses);
