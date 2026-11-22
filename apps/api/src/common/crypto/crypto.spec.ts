import { createCipheriv, randomBytes } from 'node:crypto';
import { cincinKunci, dekripsi, dekripsiBerversi, enkripsi, hmac, samaAman, sha256, tokenAcak } from './crypto';

const kunci = randomBytes(32);

describe('enkripsi AES-256-GCM', () => {
  it('round-trip mengembalikan data asli', () => {
    const c = enkripsi('rahasia-sintetis', kunci, 'mfa:u1');
    expect(dekripsi(c, kunci, 'mfa:u1').toString()).toBe('rahasia-sintetis');
  });
  it('ciphertext berbeda tiap panggilan (IV acak) dan tidak memuat plaintext', () => {
    const a = enkripsi('x', kunci, 'k');
    const b = enkripsi('x', kunci, 'k');
    expect(a.equals(b)).toBe(false);
    expect(enkripsi('rahasia-sintetis', kunci, 'k').includes(Buffer.from('rahasia-sintetis'))).toBe(false);
  });
  it('menolak kunci salah', () => {
    const c = enkripsi('x', kunci, 'k');
    expect(() => dekripsi(c, randomBytes(32), 'k')).toThrow();
  });
  it('menolak data yang diubah (tamper)', () => {
    const c = enkripsi('x', kunci, 'k');
    c[c.length - 1] ^= 0x01;
    expect(() => dekripsi(c, kunci, 'k')).toThrow();
  });
  it('menolak AAD berbeda (tidak dapat dipindah konteks)', () => {
    const c = enkripsi('x', kunci, 'mfa:u1');
    expect(() => dekripsi(c, kunci, 'mfa:u2')).toThrow();
  });
  it('menolak kunci bukan 32 byte dan data terlalu pendek', () => {
    expect(() => enkripsi('x', randomBytes(16), 'k')).toThrow(/32 byte/);
    expect(() => dekripsi(Buffer.alloc(10), kunci, 'k')).toThrow();
  });
});

describe('token, hash, hmac', () => {
  it('tokenAcak unik dan berpanjang memadai (256-bit => 43 karakter base64url)', () => {
    const a = tokenAcak();
    expect(a).toHaveLength(43);
    expect(a).not.toBe(tokenAcak());
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
  it('sha256 deterministik 32 byte', () => {
    expect(sha256('a').equals(sha256('a'))).toBe(true);
    expect(sha256('a')).toHaveLength(32);
  });
  it('hmac bergantung pada kunci', () => {
    expect(hmac(kunci, 'x').equals(hmac(randomBytes(32), 'x'))).toBe(false);
    expect(hmac(kunci, 'x').equals(hmac(kunci, 'x'))).toBe(true);
  });
  it('samaAman membandingkan isi dan panjang', () => {
    expect(samaAman(Buffer.from('ab'), Buffer.from('ab'))).toBe(true);
    expect(samaAman(Buffer.from('ab'), Buffer.from('ac'))).toBe(false);
    expect(samaAman(Buffer.from('ab'), Buffer.from('abc'))).toBe(false);
  });
});

describe('cincin kunci berversi (rotasi kunci, ADR-0013)', () => {
  const k1 = randomBytes(32);
  const k2 = randomBytes(32);
  const cincin12 = () => cincinKunci([{ id: 1, kunci: k1 }, { id: 2, kunci: k2 }]);
  /** Format lama sebelum rotasi: iv | tag | ciphertext, tanpa awalan, kunci id 1. */
  const formatLama = (plain: string, kunci: Buffer, aad: string): Buffer => {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', kunci, iv);
    c.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([c.update(plain), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]);
  };

  it('penulisan memakai kunci AKTIF (id tertinggi) dan membawa awalan versi', () => {
    const e = enkripsi('rahasia', cincin12(), 'konteks');
    expect(e[0]).toBe(0xe1);
    expect(e[1]).toBe(2);
    expect(dekripsiBerversi(e, cincin12(), 'konteks')).toMatchObject({ versi: 2, lama: false });
    expect(dekripsi(e, cincin12(), 'konteks').toString()).toBe('rahasia');
  });
  it('data yang ditulis dengan kunci lama tetap terbaca selama kunci itu ada di cincin; versinya dilaporkan', () => {
    const e1 = enkripsi('lama', cincinKunci([{ id: 1, kunci: k1 }]), 'a');
    expect(dekripsiBerversi(e1, cincin12(), 'a')).toMatchObject({ versi: 1, lama: false });
  });
  it('format LAMA tanpa awalan tetap terbaca (kunci id 1) dan ditandai lama', () => {
    const lama = formatLama('warisan', k1, 'a');
    expect(dekripsiBerversi(lama, cincin12(), 'a')).toMatchObject({ versi: 1, lama: true });
    expect(dekripsi(lama, k1, 'a').toString()).toBe('warisan'); // Buffer tunggal = id 1
  });
  it('format lama yang kebetulan berawalan 0xE1 + id dikenal jatuh ke jalur format lama (fallback aman)', () => {
    const iv = Buffer.concat([Buffer.from([0xe1, 2]), randomBytes(10)]);
    const c = createCipheriv('aes-256-gcm', k1, iv);
    c.setAAD(Buffer.from('a'));
    const ct = Buffer.concat([c.update('kebetulan'), c.final()]);
    const data = Buffer.concat([iv, c.getAuthTag(), ct]);
    expect(dekripsiBerversi(data, cincin12(), 'a')).toMatchObject({ versi: 1, lama: true });
  });
  it('kunci hilang dari cincin: data kunci itu tidak terbaca (membuktikan kunci lama boleh dibuang hanya setelah dienkripsi ulang)', () => {
    const e1 = enkripsi('x', cincinKunci([{ id: 1, kunci: k1 }]), 'a');
    expect(() => dekripsi(e1, cincinKunci([{ id: 2, kunci: k2 }]), 'a')).toThrow();
  });
  it('diubah, AAD salah, atau kunci salah => gagal', () => {
    const e = enkripsi('x', cincin12(), 'a');
    const rusak = Buffer.from(e);
    rusak[rusak.length - 1] ^= 1;
    expect(() => dekripsi(rusak, cincin12(), 'a')).toThrow();
    expect(() => dekripsi(e, cincin12(), 'b')).toThrow();
    expect(() => dekripsi(e, cincinKunci([{ id: 2, kunci: randomBytes(32) }]), 'a')).toThrow();
  });
  it('cincin menolak id tidak valid/ganda dan kunci bukan 32 byte', () => {
    expect(() => cincinKunci([])).toThrow();
    expect(() => cincinKunci([{ id: 0, kunci: k1 }])).toThrow();
    expect(() => cincinKunci([{ id: 256, kunci: k1 }])).toThrow();
    expect(() => cincinKunci([{ id: 1, kunci: k1 }, { id: 1, kunci: k2 }])).toThrow();
    expect(() => cincinKunci([{ id: 1, kunci: randomBytes(16) }])).toThrow(/32 byte/);
  });
  it('aktif = id tertinggi walau urutan input acak', () => {
    expect(cincinKunci([{ id: 3, kunci: k2 }, { id: 1, kunci: k1 }]).aktif).toBe(3);
  });
});
