import test from 'node:test';
import assert from 'node:assert/strict';
import { formatRupiah, formatTanggal, formatTanggalIso } from './format.ts';

test('formatRupiah memakai pemisah titik', () => {
  assert.equal(formatRupiah(1234567), 'Rp 1.234.567');
});
test('formatTanggal berbahasa Indonesia', () => {
  assert.equal(formatTanggal(new Date('2026-11-20T05:00:00Z')), '20 November 2026');
});
test('formatTanggalIso tidak bergeser zona waktu', () => {
  assert.equal(formatTanggalIso('2026-01-01'), '1 Januari 2026');
  assert.equal(formatTanggalIso('2026-12-31'), '31 Desember 2026');
});
