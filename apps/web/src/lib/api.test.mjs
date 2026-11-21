import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, api, ambilSesi } from './api.ts';
import { pesanGalatMasuk } from './teks.ts';

const jawab = (status, body) => async () => ({ status, ok: status >= 200 && status < 300, json: async () => body });

test('api mengirim CSRF dan JSON, serta mengembalikan data', async () => {
  let dipanggil;
  globalThis.fetch = async (url, init) => { dipanggil = { url, init }; return { status: 200, ok: true, json: async () => ({ ok: 1 }) }; };
  const r = await api('/auth/logout', { method: 'POST', csrf: 'TOKEN', body: { a: 1 } });
  assert.deepEqual(r, { ok: 1 });
  assert.equal(dipanggil.url, '/api/auth/logout');
  assert.equal(dipanggil.init.headers['X-CSRF-Token'], 'TOKEN');
  assert.equal(dipanggil.init.headers['Content-Type'], 'application/json');
  assert.equal(dipanggil.init.credentials, 'same-origin');
});

test('api melempar ApiError dengan pesan Indonesia dari server', async () => {
  globalThis.fetch = jawab(401, { kode: 'LOGIN_GAGAL', pesan: 'Email atau kata sandi salah' });
  await assert.rejects(api('/x'), (e) => e instanceof ApiError && e.status === 401 && e.kode === 'LOGIN_GAGAL' && e.message === 'Email atau kata sandi salah');
});

test('api menangani 204, galat jaringan, dan respons non-JSON', async () => {
  globalThis.fetch = jawab(204, null);
  assert.equal(await api('/x', { method: 'POST' }), undefined);
  globalThis.fetch = async () => { throw new TypeError('gagal'); };
  await assert.rejects(api('/x'), (e) => e instanceof ApiError && e.kode === 'JARINGAN' && /Tidak dapat terhubung/.test(e.message));
  globalThis.fetch = async () => ({ status: 502, ok: false, json: async () => { throw new Error('bukan json'); } });
  await assert.rejects(api('/x'), (e) => e instanceof ApiError && e.status === 502 && e.kode === 'HTTP_502');
});

test('ambilSesi mengembalikan null bila 401, melempar bila galat lain', async () => {
  globalThis.fetch = jawab(401, { kode: 'BELUM_MASUK', pesan: 'x' });
  assert.equal(await ambilSesi(), null);
  globalThis.fetch = jawab(500, { kode: 'HTTP_500', pesan: 'x' });
  await assert.rejects(ambilSesi(), ApiError);
});

test('pesanGalatMasuk: kode dikenal, tak dikenal, dan kosong', () => {
  assert.match(pesanGalatMasuk('dibatalkan'), /dibatalkan/);
  assert.match(pesanGalatMasuk('kode-aneh'), /gagal/);
  assert.equal(pesanGalatMasuk(undefined), null);
});
