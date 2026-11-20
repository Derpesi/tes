import test from 'node:test';
import assert from 'node:assert/strict';
import { formatRupiah, formatTanggal } from './format.ts';

test('formatRupiah memakai pemisah titik', () => {
  assert.equal(formatRupiah(1234567), 'Rp 1.234.567');
});
test('formatTanggal berbahasa Indonesia', () => {
  assert.equal(formatTanggal(new Date('2026-11-20T05:00:00Z')), '20 November 2026');
});
