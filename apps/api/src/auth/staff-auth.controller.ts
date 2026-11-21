import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe';
import { COOKIE_SESI } from './auth.constants';
import type { RequestDenganSesi } from './auth.guard';
import { Public, Sesi } from './decorators';
import { SessionService, SesiAktif, SesiBaru } from './session.service';
import { Konteks, StaffAuthService } from './staff-auth.service';

const email = z.string({ error: 'Email wajib diisi' }).trim().min(3, 'Email wajib diisi').max(254, 'Email terlalu panjang').email('Format email tidak valid');
const kataSandi = z.string({ error: 'Kata sandi wajib diisi' }).min(1, 'Kata sandi wajib diisi').max(256, 'Kata sandi terlalu panjang');
const kode = z.string({ error: 'Kode wajib diisi' }).trim().min(6, 'Kode terlalu pendek').max(32, 'Kode terlalu panjang');
const token = z.string({ error: 'Token wajib diisi' }).min(20, 'Token tidak valid').max(200, 'Token tidak valid');

const LoginBody = z.object({ email, password: kataSandi });
const KodeBody = z.object({ code: kode });
const TerimaUndanganBody = z.object({ token, password: kataSandi });
const LupaBody = z.object({ email });
const ResetBody = z.object({ token, password: kataSandi });

const BATAS_AUTH = { default: { limit: 10, ttl: 60_000 } };
const SEMUA_STATE = ['PENUH', 'MENUNGGU_MFA', 'MENUNGGU_ENROLL_MFA'] as const;

const ctx = (req: Request): Konteks => ({ ip: req.ip, userAgent: req.header('user-agent') });

@ApiTags('Autentikasi Staff')
@Controller('auth')
export class StaffAuthController {
  constructor(
    private readonly auth: StaffAuthService,
    private readonly sesi: SessionService,
  ) {}

  private setCookie(res: Response, s: SesiBaru) {
    // Awalan __Host- mewajibkan Secure, Path=/, dan tanpa Domain.
    res.cookie(COOKIE_SESI, s.token, { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: s.maxAgeMs });
  }
  private info(s: SesiAktif) {
    return { realm: s.realm, state: s.state, user: { id: s.userId, email: s.email }, csrfToken: this.sesi.csrfToken(s.id), expiresAt: s.expiresAt };
  }

  @Public()
  @Throttle(BATAS_AUTH)
  @Post('staff/invitation/accept')
  @HttpCode(200)
  @ApiBody({ schema: { type: 'object', required: ['token', 'password'], properties: { token: { type: 'string' }, password: { type: 'string' } } } })
  @ApiOkResponse({ description: 'Undangan diterima; lanjutkan pendaftaran verifikasi dua langkah' })
  async terimaUndangan(@Body(new ZodPipe(TerimaUndanganBody)) b: z.infer<typeof TerimaUndanganBody>, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const s = await this.auth.terimaUndangan(b.token, b.password, ctx(req));
    this.setCookie(res, s);
    return { nextStep: 'ENROLL_MFA', csrfToken: s.csrfToken };
  }

  @Public()
  @Throttle(BATAS_AUTH)
  @Post('staff/login')
  @HttpCode(200)
  @ApiBody({ schema: { type: 'object', required: ['email', 'password'], properties: { email: { type: 'string' }, password: { type: 'string' } } } })
  @ApiOkResponse({ description: 'Kata sandi benar; lanjutkan verifikasi dua langkah' })
  async login(@Body(new ZodPipe(LoginBody)) b: z.infer<typeof LoginBody>, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const r = await this.auth.login(b.email, b.password, ctx(req));
    this.setCookie(res, r.sesi);
    return { nextStep: r.nextStep, csrfToken: r.sesi.csrfToken };
  }

  @Sesi({ realm: 'staff', states: ['MENUNGGU_MFA'] })
  @Throttle(BATAS_AUTH)
  @Post('staff/mfa/verify')
  @HttpCode(200)
  @ApiBody({ schema: { type: 'object', required: ['code'], properties: { code: { type: 'string', description: 'Kode TOTP 6 digit atau kode pemulihan' } } } })
  async verifikasiMfa(@Body(new ZodPipe(KodeBody)) b: z.infer<typeof KodeBody>, @Req() req: RequestDenganSesi, @Res({ passthrough: true }) res: Response) {
    const s = await this.auth.verifikasiMfa(req.sesi!, b.code, ctx(req));
    this.setCookie(res, s);
    return { csrfToken: s.csrfToken };
  }

  @Sesi({ realm: 'staff', states: ['MENUNGGU_ENROLL_MFA'] })
  @Post('staff/mfa/enroll/start')
  @HttpCode(200)
  async mulaiDaftarMfa(@Req() req: RequestDenganSesi) {
    return this.auth.mulaiDaftarMfa(req.sesi!);
  }

  @Sesi({ realm: 'staff', states: ['MENUNGGU_ENROLL_MFA'] })
  @Throttle(BATAS_AUTH)
  @Post('staff/mfa/enroll/confirm')
  @HttpCode(200)
  @ApiBody({ schema: { type: 'object', required: ['code'], properties: { code: { type: 'string' } } } })
  @ApiOkResponse({ description: 'Kode pemulihan ditampilkan SEKALI; simpan di tempat aman' })
  async konfirmasiDaftarMfa(@Body(new ZodPipe(KodeBody)) b: z.infer<typeof KodeBody>, @Req() req: RequestDenganSesi, @Res({ passthrough: true }) res: Response) {
    const r = await this.auth.konfirmasiDaftarMfa(req.sesi!, b.code, ctx(req));
    this.setCookie(res, r.sesi);
    return { recoveryCodes: r.recoveryCodes, csrfToken: r.sesi.csrfToken };
  }

  @Public()
  @Throttle(BATAS_AUTH)
  @Post('staff/password/forgot')
  @HttpCode(202)
  @ApiBody({ schema: { type: 'object', required: ['email'], properties: { email: { type: 'string' } } } })
  async lupaPassword(@Body(new ZodPipe(LupaBody)) b: z.infer<typeof LupaBody>) {
    await this.auth.lupaPassword(b.email);
    return { pesan: 'Jika email terdaftar, tautan atur ulang kata sandi telah dikirim.' };
  }

  @Public()
  @Throttle(BATAS_AUTH)
  @Post('staff/password/reset')
  @HttpCode(200)
  @ApiBody({ schema: { type: 'object', required: ['token', 'password'], properties: { token: { type: 'string' }, password: { type: 'string' } } } })
  async resetPassword(@Body(new ZodPipe(ResetBody)) b: z.infer<typeof ResetBody>, @Res({ passthrough: true }) res: Response) {
    await this.auth.resetPassword(b.token, b.password);
    res.clearCookie(COOKIE_SESI, { path: '/', secure: true, httpOnly: true, sameSite: 'lax' });
    return { pesan: 'Kata sandi berhasil diubah. Silakan masuk kembali.' };
  }

  @Sesi({ states: [...SEMUA_STATE] })
  @Post('logout')
  @HttpCode(200)
  async logout(@Req() req: RequestDenganSesi, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req.sesi!);
    res.clearCookie(COOKIE_SESI, { path: '/', secure: true, httpOnly: true, sameSite: 'lax' });
    return { pesan: 'Anda telah keluar.' };
  }

  @Sesi({ states: [...SEMUA_STATE] })
  @Get('session')
  @ApiOkResponse({ description: 'Informasi sesi saat ini, termasuk token CSRF' })
  sesiSaatIni(@Req() req: RequestDenganSesi) {
    return this.info(req.sesi!);
  }

  @Sesi({ realm: 'staff' })
  @Get('me')
  @ApiOkResponse({ description: 'Hanya dapat diakses sesi penuh (setelah verifikasi dua langkah)' })
  saya(@Req() req: RequestDenganSesi) {
    return this.info(req.sesi!);
  }
}
