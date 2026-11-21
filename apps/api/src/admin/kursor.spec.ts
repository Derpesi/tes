import { decodeKursor, encodeKursor } from './kursor';

describe('kursor keyset', () => {
  const sah = { t: '2026-11-21 07:06:03.613169+00', id: '00000000-0000-4000-8000-00000000000a' };
  it('round-trip mempertahankan mikrodetik', () => {
    expect(decodeKursor(encodeKursor(sah))).toEqual(sah);
  });
  it('kosong -> null', () => {
    expect(decodeKursor(undefined)).toBeNull();
  });
  it.each([
    ['bukan base64 json', 'bukan-kursor'],
    ['waktu bukan format Postgres', encodeKursor({ t: 'kemarin', id: sah.id })],
    ['id bukan uuid', encodeKursor({ t: sah.t, id: "x'; DROP TABLE users;--" })],
    ['objek lain', Buffer.from(JSON.stringify({ a: 1 })).toString('base64url')],
  ])('menolak: %s', (_n, v) => {
    expect(() => decodeKursor(v)).toThrow(/Kursor halaman tidak valid/);
  });
});
