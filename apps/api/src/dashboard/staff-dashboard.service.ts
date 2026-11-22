import { Inject, Injectable } from '@nestjs/common';
import { JAM_ABSENSI, JamAbsensi } from '../attendance/jam';
import { tanggalWib } from '../attendance/shift';
import { ScopedDb } from '../database/scoped-db';
import type { Akses } from '../rbac/akses.service';
import { jenisTerlihat } from '../payroll/akses';
import { WIDGET } from './widgets';

/** Dashboard staf berbasis widget dan izin: hanya widget yang boleh dilihat pemanggil, hanya angka agregat, di bawah RLS scope-nya. */
@Injectable()
export class StaffDashboardService {
  constructor(
    private readonly sdb: ScopedDb,
    @Inject(JAM_ABSENSI) private readonly jam: JamAbsensi,
  ) {}

  async ambil(a: Akses) {
    const hari = tanggalWib(this.jam());
    const boleh = WIDGET.filter((w) => w.izin.some((i) => a.permissions.has(i)));
    const jenisPayroll = jenisTerlihat(a);
    const widgets = await this.sdb.tx({ companyIds: a.companyIds }, async (c) => {
      const keluar = [];
      for (const w of boleh) {
        if (w.id === 'payroll' && !jenisPayroll.length) continue;
        keluar.push({ id: w.id, title: w.title, link: w.link, items: await w.hitung(c, { hari, jenisPayroll }) });
      }
      return keluar;
    });
    return { today: hari, widgets };
  }
}
