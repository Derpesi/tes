import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Pembatas laju yang membedakan pemakai: permintaan dengan sesi SAH (diisi AuthGuard di `req.sesi`) dihitung per PENGGUNA, selain itu per IP.
 * Alasan: banyak karyawan di satu lokasi rekanan atau kantor berbagi satu IP (NAT); pembatas per-IP murni akan saling memblokir saat puncak absensi
 * (A-05). Pembatas per-IP tetap berlaku untuk rute tanpa sesi (login, reset, callback) sehingga serangan tebak kata sandi tidak melonggar.
 * Penyerang tidak dapat memalsukan kunci pengguna (berasal dari sesi yang sudah divalidasi server), dan cookie acak tidak membuat ember baru.
 */
@Injectable()
export class ThrottlerSesiGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const sesi = req.sesi as { userId?: string } | undefined;
    return sesi?.userId ? `u:${sesi.userId}` : String(req.ip ?? 'tanpa-ip');
  }
}
