import { tanggalValid } from './tanggal';

describe('tanggalValid', () => {
  it.each(['2026-03-11', '2024-02-29', '2000-01-01', '9999-12-31'])('menerima %s', (v) => expect(tanggalValid(v)).toBe(true));
  it.each(['2026-02-30', '2025-02-29', '2026-13-01', '2026-00-10', '', 'kemarin', "' OR 1=1--", '<script>', '2026-03-11T00:00', '\u0000', 'A'.repeat(5000), '😀', '-2026-01-01', '2026-3-1'])('menolak %j tanpa melempar galat', (v) => {
    expect(() => tanggalValid(v)).not.toThrow();
    expect(tanggalValid(v)).toBe(false);
  });
});
