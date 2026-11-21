import { jarakMeter, koordinatSah } from './geo';

describe('geo', () => {
  it('jarak nol untuk titik sama', () => expect(jarakMeter(-6.2, 106.8, -6.2, 106.8)).toBe(0));
  it('1 derajat lintang ≈ 111,19 km', () => expect(jarakMeter(0, 0, 1, 0)).toBeCloseTo(111195, -2));
  it('Jakarta (Monas) ke Bandung (Gedung Sate) ≈ 116 km', () => {
    const m = jarakMeter(-6.175392, 106.827153, -6.902474, 107.618803);
    expect(m / 1000).toBeGreaterThan(110);
    expect(m / 1000).toBeLessThan(125);
  });
  it('simetris dan ukuran kecil teliti (~11,1 m untuk 0,0001°)', () => {
    expect(jarakMeter(-6.2, 106.8, -6.2001, 106.8)).toBeCloseTo(11.12, 1);
    expect(jarakMeter(1, 2, 3, 4)).toBeCloseTo(jarakMeter(3, 4, 1, 2), 6);
  });
  it('melewati garis bujur 180 tetap pendek', () => expect(jarakMeter(0, 179.9999, 0, -179.9999)).toBeLessThan(30));
  it('validasi koordinat', () => {
    expect(koordinatSah(-6.2, 106.8)).toBe(true);
    for (const [a, b] of [[91, 0], [0, 181], [NaN, 0], [0, Infinity]]) expect(koordinatSah(a, b)).toBe(false);
  });
});
