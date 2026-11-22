import { Body, Controller, Get, HttpCode, Post, Query, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { z } from 'zod';
import type { RequestDenganSesi } from '../auth/auth.guard';
import { Sesi } from '../auth/decorators';
import type { BerkasMasuk } from '../common/storage/upload';
import { ZodPipe } from '../common/zod.pipe';
import { MemberAttendanceService, BATAS_SELFIE_UNGGAH_BYTE } from './member-attendance.service';
import { AbsenBody, RiwayatAbsenQuery } from './schemas';

const BATAS = { default: { limit: 20, ttl: 60_000 } };
const uid = (req: RequestDenganSesi) => req.sesi!.userId; // dari sesi di server

/** Absensi member. person_id selalu dari sesi; titik, penempatan, dan lokasi divalidasi di backend (bukan filter UI). */
@ApiTags('Absensi (member)')
@Controller('member/attendance')
export class MemberAttendanceController {
  constructor(private readonly svc: MemberAttendanceService) {}

  @Sesi({ realm: 'member' })
  @Throttle(BATAS)
  @Post()
  @HttpCode(201)
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['code', 'kind', 'latitude', 'longitude', 'deviceId', 'idempotencyKey'],
      properties: {
        code: { type: 'string', format: 'uuid', description: 'Kode titik dari QR' }, kind: { type: 'string', enum: ['MASUK', 'PULANG'] },
        latitude: { type: 'number' }, longitude: { type: 'number' }, accuracy: { type: 'number' }, clientTime: { type: 'string', format: 'date-time' },
        deviceId: { type: 'string' }, idempotencyKey: { type: 'string' }, selfie: { type: 'string', format: 'binary', description: 'JPEG dari kamera, maksimal 300 KB. Wajib hanya bila selfie aktif (ABSENSI_SELFIE=on); bila nonaktif (bawaan) berkas diabaikan' },
      },
    },
  })
  @ApiOkResponse({ description: 'Hasil absen: VALID, PERLU_VERIFIKASI, atau DITOLAK (tercatat). Pengulangan kunci idempotensi mengembalikan hasil awal dengan status 200.' })
  @UseInterceptors(FileInterceptor('selfie', { limits: { fileSize: BATAS_SELFIE_UNGGAH_BYTE, files: 1, fields: 12 } }))
  async absen(@Req() req: RequestDenganSesi, @Res({ passthrough: true }) res: Response, @Body(new ZodPipe(AbsenBody)) b: z.infer<typeof AbsenBody>, @UploadedFile() selfie: BerkasMasuk | undefined) {
    const r = await this.svc.absen(uid(req), b, selfie);
    res.set('Cache-Control', 'no-store');
    if (r.replay) res.status(200);
    return r.hasil;
  }

  @Sesi({ realm: 'member' })
  @Get()
  @ApiOkResponse({ description: 'Riwayat absen milik sendiri; keyset' })
  riwayat(@Req() req: RequestDenganSesi, @Query(new ZodPipe(RiwayatAbsenQuery)) q: z.infer<typeof RiwayatAbsenQuery>) {
    return this.svc.riwayat(uid(req), q);
  }

  @Sesi({ realm: 'member' })
  @Get('today')
  @ApiOkResponse({ description: 'Lokasi penempatan aktif, rekaman 36 jam terakhir, dan selfieAktif (apakah selfie diwajibkan)' })
  hariIni(@Req() req: RequestDenganSesi) {
    return this.svc.hariIni(uid(req));
  }
}
