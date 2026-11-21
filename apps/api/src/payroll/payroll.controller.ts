import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe';
import type { Akses } from '../rbac/akses.service';
import { AksesStaff, RequirePermission } from '../rbac/rbac.decorators';
import { SEMUA_IZIN_PAYROLL } from './akses';
import { PayrollService } from './payroll.service';
import { DaftarPeriodeQuery, IdParam, PeriodeBuat } from './schemas';

const id = (nama: string) => Param(nama, new ZodPipe(IdParam));
const [IZIN_PERTAMA, ...IZIN_LAIN] = SEMUA_IZIN_PAYROLL;

/**
 * Rekap payroll TAHAP AWAL (periode, rekap absensi, komponen masukan, alur persetujuan, ekspor). Dilarang di tahap ini: hitung gaji final, PPh 21, BPJS, slip, pembayaran.
 * Izin per jenis rekap diperiksa di layanan (rekanan dan internal dipisah); rute baca terbuka bagi pemegang izin apa pun lalu disaring per jenis. Scope perusahaan: RLS.
 */
@ApiTags('Payroll: rekap')
@Controller('payroll')
export class PayrollController {
  constructor(private readonly svc: PayrollService) {}

  @RequirePermission(IZIN_PERTAMA, ...IZIN_LAIN)
  @Get('periods')
  daftar(@AksesStaff() a: Akses, @Query(new ZodPipe(DaftarPeriodeQuery)) q: z.infer<typeof DaftarPeriodeQuery>) {
    return this.svc.daftarPeriode(a, q);
  }

  @RequirePermission('payroll_recap_partner.create', 'payroll_recap_internal.create')
  @Post('periods')
  @HttpCode(201)
  @ApiOkResponse({ description: 'Membuka periode dan rekap versi 1 (DRAFT); tumpang tindih ditolak (409)' })
  buat(@AksesStaff() a: Akses, @Body(new ZodPipe(PeriodeBuat)) b: z.infer<typeof PeriodeBuat>) {
    return this.svc.buatPeriode(a, b);
  }

  @RequirePermission(IZIN_PERTAMA, ...IZIN_LAIN)
  @Get('periods/:id')
  detailPeriode(@AksesStaff() a: Akses, @id('id') i: string) {
    return this.svc.detailPeriode(a, i);
  }

  @RequirePermission(IZIN_PERTAMA, ...IZIN_LAIN)
  @Get('recaps/:id')
  @ApiOkResponse({ description: 'Rekap lengkap: baris, komponen (nominal sebagai teks desimal), subtotal per jenis. Tidak ada total gaji/neto' })
  detail(@AksesStaff() a: Akses, @id('id') i: string) {
    return this.svc.detailRekap(a, i);
  }

  @RequirePermission('payroll_recap_partner.create', 'payroll_recap_partner.update', 'payroll_recap_internal.create', 'payroll_recap_internal.update')
  @Post('recaps/:id/pull')
  @HttpCode(200)
  @ApiOkResponse({ description: 'Snapshot absensi (DRAFT, jenis PARTNER, idempoten); komponen dipertahankan' })
  tarik(@AksesStaff() a: Akses, @id('id') i: string) {
    return this.svc.tarikAbsensi(a, i);
  }
}
