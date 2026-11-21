import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { samaAman } from '../common/crypto/crypto';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { Akses, AksesService } from '../rbac/akses.service';
import { IZIN } from '../rbac/rbac.decorators';
import { COOKIE_SESI } from './auth.constants';
import { OPSI_SESI, OpsiSesi, PUBLIK } from './decorators';
import { SesiAktif, SessionService } from './session.service';

export type RequestDenganSesi = Request & { sesi?: SesiAktif; akses?: Akses };

const METHOD_AMAN = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Guard global. Semua rute WAJIB bersesi kecuali ditandai @Public() (deny-by-default).
 * Method tulis: Origin harus sama dengan APP_BASE_URL; rute bersesi juga wajib membawa token CSRF.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly origin: string;
  constructor(
    private readonly reflector: Reflector,
    private readonly sesi: SessionService,
    private readonly akses: AksesService,
    @Inject(ENV) env: Env,
  ) {
    this.origin = new URL(env.APP_BASE_URL).origin;
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<RequestDenganSesi>();
    const tulis = !METHOD_AMAN.has(req.method);
    if (tulis) this.periksaOrigin(req);

    const target = [ctx.getHandler(), ctx.getClass()];
    const publik = this.reflector.getAllAndOverride<boolean>(PUBLIK, target) === true;
    const token = req.cookies?.[COOKIE_SESI] as string | undefined;
    const sesi = token ? await this.sesi.cari(token) : null;

    if (publik) {
      req.sesi = sesi ?? undefined;
      return true;
    }
    if (!sesi) throw new UnauthorizedException({ kode: 'BELUM_MASUK', message: 'Anda belum masuk atau sesi telah berakhir' });

    const opsiMeta = this.reflector.getAllAndOverride<OpsiSesi | undefined>(OPSI_SESI, target);
    // Deny-by-default: rute harus menyatakan @Public(), @Sesi(), atau @RequirePermission() secara eksplisit.
    if (!opsiMeta) throw new ForbiddenException({ kode: 'RUTE_TANPA_IZIN', message: 'Anda tidak memiliki izin untuk tindakan ini' });
    const opsi = opsiMeta;
    if (opsi.realm && sesi.realm !== opsi.realm) {
      throw new ForbiddenException({ kode: 'REALM_TIDAK_SESUAI', message: 'Anda tidak memiliki izin untuk tindakan ini' });
    }
    if (!opsi.states.includes(sesi.state)) {
      if (sesi.state === 'MENUNGGU_MFA') throw new ForbiddenException({ kode: 'MFA_DIPERLUKAN', message: 'Verifikasi dua langkah diperlukan' });
      if (sesi.state === 'MENUNGGU_ENROLL_MFA') throw new ForbiddenException({ kode: 'DAFTAR_MFA_DIPERLUKAN', message: 'Pendaftaran verifikasi dua langkah diperlukan' });
      throw new ForbiddenException({ kode: 'SESI_TIDAK_SESUAI', message: 'Anda tidak memiliki izin untuk tindakan ini' });
    }
    if (tulis) {
      const kirim = req.header('x-csrf-token') ?? '';
      const harapan = this.sesi.csrfToken(sesi.id);
      if (!kirim || !samaAman(Buffer.from(kirim), Buffer.from(harapan))) {
        throw new ForbiddenException({ kode: 'CSRF_TIDAK_VALID', message: 'Token keamanan permintaan tidak valid' });
      }
    }
    req.sesi = sesi;
    const izin = this.reflector.getAllAndOverride<string | undefined>(IZIN, target);
    if (izin) {
      const a = await this.akses.muat(sesi.userId);
      if (!a.permissions.has(izin)) throw new ForbiddenException({ kode: 'IZIN_DITOLAK', message: 'Anda tidak memiliki izin untuk tindakan ini' });
      req.akses = a;
    }
    return true;
  }

  private periksaOrigin(req: Request): void {
    const origin = req.header('origin');
    const referer = req.header('referer');
    const ok = origin ? origin === this.origin : referer ? referer.startsWith(this.origin + '/') : false;
    if (!ok) throw new ForbiddenException({ kode: 'ASAL_TIDAK_VALID', message: 'Asal permintaan tidak valid' });
  }
}
