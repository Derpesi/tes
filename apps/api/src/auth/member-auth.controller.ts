import { Controller, Get, Query, Req, Res, ServiceUnavailableException } from '@nestjs/common';
import { ApiOkResponse, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { z } from 'zod';
import { COOKIE_OIDC, COOKIE_SESI, TTL } from './auth.constants';
import type { RequestDenganSesi } from './auth.guard';
import { Public, Sesi } from './decorators';
import { MemberAuthService } from './member-auth.service';
import { SessionService } from './session.service';

const BATAS = { default: { limit: 20, ttl: 60_000 } };

const QueryCallback = z.object({
  code: z.string().max(2048).optional(),
  state: z.string().max(256).optional(),
  error: z.string().max(100).optional(),
});

const OPSI_COOKIE = { httpOnly: true, secure: true, sameSite: 'lax' as const, path: '/' };

@ApiTags('Autentikasi Member')
@Controller('auth/member')
export class MemberAuthController {
  constructor(
    private readonly member: MemberAuthService,
    private readonly sesi: SessionService,
  ) {}

  /** URL berisi code/state tidak boleh bocor lewat header Referer atau cache. */
  private lindungi(res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
  }

  @Public()
  @Throttle(BATAS)
  @Get('google/start')
  @ApiQuery({ name: 'returnTo', required: false, description: 'Jalur relatif tujuan setelah masuk (mis. /lowongan)' })
  @ApiResponse({ status: 302, description: 'Mengalihkan ke Google' })
  @ApiResponse({ status: 503, description: 'Masuk dengan Google belum dikonfigurasi' })
  async mulai(@Query('returnTo') returnTo: string | undefined, @Res() res: Response) {
    if (!this.member.tersedia()) {
      throw new ServiceUnavailableException({ kode: 'GOOGLE_BELUM_DIKONFIGURASI', message: 'Masuk dengan Google belum tersedia' });
    }
    const { url, bindingToken } = await this.member.mulai(returnTo);
    this.lindungi(res);
    res.cookie(COOKIE_OIDC, bindingToken, { ...OPSI_COOKIE, maxAge: TTL.oidcTransaksiMs });
    res.redirect(302, url);
  }

  @Public()
  @Throttle(BATAS)
  @Get('google/callback')
  @ApiResponse({ status: 302, description: 'Mengalihkan ke aplikasi (sukses) atau ke halaman masuk dengan kode galat' })
  async callback(@Query() q: Record<string, unknown>, @Req() req: RequestDenganSesi, @Res() res: Response) {
    this.lindungi(res);
    const bindingToken = req.cookies?.[COOKIE_OIDC] as string | undefined;
    res.clearCookie(COOKIE_OIDC, OPSI_COOKIE);
    const galat = (kode: string) => res.redirect(302, `${this.member.urlMasuk}?galat=${encodeURIComponent(kode)}`);

    const parsed = QueryCallback.safeParse(q);
    if (!parsed.success) return galat('gagal');
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(parsed.data)) if (v !== undefined) query.set(k, v);

    const hasil = await this.member.selesai({ query, bindingToken, sesiLama: req.sesi, userAgent: req.header('user-agent') });
    if (!hasil.ok) return galat(hasil.galat);
    res.cookie(COOKIE_SESI, hasil.sesi.token, { ...OPSI_COOKIE, maxAge: hasil.sesi.maxAgeMs });
    res.redirect(302, `${this.member.urlAplikasi}${hasil.returnTo}`);
  }

  @Sesi({ realm: 'member' })
  @Get('me')
  @ApiOkResponse({ description: 'Informasi sesi member (hanya realm member)' })
  saya(@Req() req: RequestDenganSesi) {
    const s = req.sesi!;
    return { realm: s.realm, state: s.state, user: { id: s.userId, email: s.email }, csrfToken: this.sesi.csrfToken(s.id), expiresAt: s.expiresAt };
  }
}
