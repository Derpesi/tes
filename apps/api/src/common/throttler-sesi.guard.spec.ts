import { ThrottlerSesiGuard } from './throttler-sesi.guard';

describe('ThrottlerSesiGuard.getTracker', () => {
  const g = Object.create(ThrottlerSesiGuard.prototype) as { getTracker(req: Record<string, unknown>): Promise<string> };
  it('sesi sah -> per pengguna (bukan per IP)', async () => {
    expect(await g.getTracker({ ip: '1.2.3.4', sesi: { userId: 'u-1' } })).toBe('u:u-1');
    expect(await g.getTracker({ ip: '5.6.7.8', sesi: { userId: 'u-1' } })).toBe('u:u-1');
  });
  it('tanpa sesi sah -> per IP; cookie palsu tidak mengubah kunci', async () => {
    expect(await g.getTracker({ ip: '1.2.3.4' })).toBe('1.2.3.4');
    expect(await g.getTracker({ ip: '1.2.3.4', sesi: undefined, cookies: { '__Host-sid': 'palsu' } })).toBe('1.2.3.4');
    expect(await g.getTracker({ ip: '1.2.3.4', sesi: {} })).toBe('1.2.3.4');
    expect(await g.getTracker({})).toBe('tanpa-ip');
  });
});
