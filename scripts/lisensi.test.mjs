import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluasi } from './lisensi.mjs';

const kebijakan = {
  diizinkan: ['MIT', 'Apache-2.0', 'ISC'],
  ditolakPrefiks: ['GPL', 'AGPL', 'SSPL'],
  perluTinjauPrefiks: ['LGPL', 'MPL', 'CC-BY'],
  pengecualian: [{ paket: 'lib-lgpl', lisensi: 'LGPL-3.0-or-later' }],
};
const p = (name) => [{ name, versions: ['1.0.0'] }];

test('lisensi diizinkan lolos', () => {
  assert.deepEqual(evaluasi({ MIT: p('a'), 'Apache-2.0': p('b') }, kebijakan), []);
});
test('GPL ditolak', () => {
  const r = evaluasi({ 'GPL-3.0-only': p('x') }, kebijakan);
  assert.equal(r.length, 1);
  assert.match(r[0], /DITOLAK/);
});
test('AGPL dan SSPL ditolak', () => {
  assert.equal(evaluasi({ 'AGPL-3.0-only': p('x'), 'SSPL-1.0': p('y') }, kebijakan).length, 2);
});
test('LGPL tanpa pengecualian gagal, dengan pengecualian lolos', () => {
  assert.equal(evaluasi({ 'LGPL-3.0-or-later': p('lain') }, kebijakan).length, 1);
  assert.deepEqual(evaluasi({ 'LGPL-3.0-or-later': p('lib-lgpl') }, kebijakan), []);
});
test('ekspresi OR lolos bila ada alternatif diizinkan', () => {
  assert.deepEqual(evaluasi({ '(MIT OR GPL-3.0-only)': p('c') }, kebijakan), []);
});
test('ekspresi AND dengan GPL ditolak', () => {
  assert.equal(evaluasi({ '(MIT AND GPL-3.0-only)': p('c') }, kebijakan).length, 1);
});
test('lisensi tak dikenal gagal', () => {
  assert.equal(evaluasi({ 'Proprietary-X': p('z') }, kebijakan).length, 1);
});
