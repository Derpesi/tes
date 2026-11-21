import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { RequestDenganSesi } from '../auth/auth.guard';
import { Sesi } from '../auth/decorators';
import { ZodPipe } from '../common/zod.pipe';
import { MemberRecruitmentService } from './member-recruitment.service';
import { DaftarMemberLowonganQuery, IdParam, MelamarBody } from './schemas';

const uid = (req: RequestDenganSesi) => req.sesi!.userId; // dari sesi di server
const id = (nama: string) => Param(nama, new ZodPipe(IdParam));

/** Lowongan dan lamaran untuk member. Backend menegakkan CanApply (403 untuk karyawan aktif); person_id dari sesi. */
@ApiTags('Lowongan dan Lamaran (member)')
@Controller('member')
export class MemberRecruitmentController {
  constructor(private readonly svc: MemberRecruitmentService) {}

  @Sesi({ realm: 'member' })
  @Get('eligibility')
  @ApiOkResponse({ description: 'Apakah member boleh melamar (aturan yang sama dengan penegakan di backend)' })
  eligibility(@Req() req: RequestDenganSesi) {
    return this.svc.eligibility(uid(req));
  }

  @Sesi({ realm: 'member' })
  @Get('vacancies')
  @ApiOkResponse({ description: 'Lowongan DIBUKA semua perusahaan Group; tanpa catatan internal' })
  daftarLowongan(@Query(new ZodPipe(DaftarMemberLowonganQuery)) q: z.infer<typeof DaftarMemberLowonganQuery>) {
    return this.svc.daftarLowongan(q);
  }

  @Sesi({ realm: 'member' })
  @Get('vacancies/:id')
  detailLowongan(@id('id') i: string) {
    return this.svc.detailLowongan(i);
  }

  @Sesi({ realm: 'member' })
  @Post('applications')
  @HttpCode(201)
  @ApiOkResponse({ description: 'Melamar (CanApply: karyawan aktif ditolak 403)' })
  melamar(@Req() req: RequestDenganSesi, @Body(new ZodPipe(MelamarBody)) b: z.infer<typeof MelamarBody>) {
    return this.svc.melamar(uid(req), b);
  }

  @Sesi({ realm: 'member' })
  @Get('applications')
  daftarLamaran(@Req() req: RequestDenganSesi, @Query(new ZodPipe(DaftarMemberLowonganQuery)) q: z.infer<typeof DaftarMemberLowonganQuery>) {
    return this.svc.daftarLamaran(uid(req), q);
  }

  @Sesi({ realm: 'member' })
  @Post('applications/:id/withdraw')
  @HttpCode(200)
  tarik(@Req() req: RequestDenganSesi, @id('id') i: string) {
    return this.svc.tarik(uid(req), i);
  }
}
