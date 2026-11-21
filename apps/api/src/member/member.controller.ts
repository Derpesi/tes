import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { Sesi } from '../auth/decorators';
import type { RequestDenganSesi } from '../auth/auth.guard';
import { BATAS_UNGGAH_BYTE, BerkasMasuk } from '../common/storage/upload';
import { ZodPipe } from '../common/zod.pipe';
import { MemberDocumentsService } from './member-documents.service';
import { MemberProfileService } from './member-profile.service';
import { BiodataSimpan, DokumenMemberBody, IdParam } from './schemas';

const ascii = (nama: string) => nama.replace(/[^\x20-\x7e]|["\\]/g, '_');
const uid = (req: RequestDenganSesi) => req.sesi!.userId; // dari sesi di server

/** Self-service member. Semua rute @Sesi({realm:'member'}); person_id selalu diturunkan dari sesi, bukan dari input. */
@ApiTags('Member (self-service)')
@Controller('member')
export class MemberController {
  constructor(
    private readonly profil: MemberProfileService,
    private readonly dokumen: MemberDocumentsService,
  ) {}

  @Sesi({ realm: 'member' })
  @Get('profile')
  @ApiOkResponse({ description: 'Profil milik sendiri; NIK ditampilkan tersamar' })
  lihat(@Req() req: RequestDenganSesi) {
    return this.profil.profil(uid(req));
  }

  @Sesi({ realm: 'member' })
  @Put('profile')
  @ApiOkResponse({ description: 'Menyimpan biodata (draf bertahap); perubahan saat menunggu verifikasi mengembalikan status ke PROFIL_BELUM_LENGKAP' })
  simpan(@Req() req: RequestDenganSesi, @Body(new ZodPipe(BiodataSimpan)) b: z.infer<typeof BiodataSimpan>) {
    return this.profil.simpan(uid(req), b);
  }

  @Sesi({ realm: 'member' })
  @Post('profile/submit')
  @HttpCode(200)
  @ApiOkResponse({ description: 'Mengajukan verifikasi HRD setelah biodata dan KTP lengkap' })
  ajukan(@Req() req: RequestDenganSesi) {
    return this.profil.ajukan(uid(req));
  }

  @Sesi({ realm: 'member' })
  @Get('profile/history')
  riwayat(@Req() req: RequestDenganSesi) {
    return this.profil.riwayat(uid(req));
  }

  @Sesi({ realm: 'member' })
  @Get('documents')
  daftarDokumen(@Req() req: RequestDenganSesi) {
    return this.dokumen.daftar(uid(req));
  }

  @Sesi({ realm: 'member' })
  @Post('documents')
  @HttpCode(201)
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', required: ['berkas', 'kind'], properties: { berkas: { type: 'string', format: 'binary' }, kind: { type: 'string', enum: ['KTP', 'FOTO_DIRI', 'IJAZAH', 'LAINNYA'] } } } })
  @UseInterceptors(FileInterceptor('berkas', { limits: { fileSize: BATAS_UNGGAH_BYTE + 1, files: 1, fields: 5 } }))
  unggah(@Req() req: RequestDenganSesi, @Body(new ZodPipe(DokumenMemberBody)) b: z.infer<typeof DokumenMemberBody>, @UploadedFile() berkas: BerkasMasuk | undefined) {
    return this.dokumen.unggah(uid(req), b, berkas);
  }

  @Sesi({ realm: 'member' })
  @Get('documents/:docId/download')
  @ApiOkResponse({ description: 'Berkas milik sendiri dialirkan lewat API setelah didekripsi (tanpa URL publik)' })
  async unduh(@Req() req: RequestDenganSesi, @Param('docId', new ZodPipe(IdParam)) docId: string, @Res() res: Response) {
    const f = await this.dokumen.unduh(uid(req), docId);
    res.set({
      'Content-Type': f.mime,
      'Content-Length': String(f.data.length),
      'Content-Disposition': `attachment; filename="${ascii(f.nama)}"; filename*=UTF-8''${encodeURIComponent(f.nama)}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    });
    res.end(f.data);
  }

  @Sesi({ realm: 'member' })
  @Delete('documents/:docId')
  @HttpCode(204)
  async hapus(@Req() req: RequestDenganSesi, @Param('docId', new ZodPipe(IdParam)) docId: string) {
    await this.dokumen.hapus(uid(req), docId);
  }
}
