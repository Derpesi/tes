import { applyDecorators, createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import { Sesi } from '../auth/decorators';
import type { Akses } from './akses.service';

export const IZIN = 'rbac:izin';
export const IZIN_ALTERNATIF = 'rbac:izin-alternatif';

/**
 * Mewajibkan sesi staff PENUH dan permission granular (mis. 'user_role.create'). Izin dihitung dari database
 * pada setiap permintaan. Izin tambahan (`alternatif`) berarti "salah satu" dari izin yang disebut; dipakai untuk daftar baca yang
 * harus terbuka bagi pelaksana tindakan (mis. antrean tinjauan bagi pemeriksa dan pemutus). Rute tanpa @Public(), @Sesi(), atau @RequirePermission() ditolak (deny-by-default).
 */
export const RequirePermission = (kode: string, ...alternatif: string[]) =>
  applyDecorators(SetMetadata(IZIN, kode), SetMetadata(IZIN_ALTERNATIF, alternatif), Sesi({ realm: 'staff' }));

/** Mengambil hak akses staff yang sudah dihitung guard (hanya pada rute @RequirePermission). */
export const AksesStaff = createParamDecorator((_data: unknown, ctx: ExecutionContext): Akses => ctx.switchToHttp().getRequest().akses);
