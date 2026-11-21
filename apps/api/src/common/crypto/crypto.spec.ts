import { randomBytes } from 'node:crypto';
import { dekripsi, enkripsi, hmac, samaAman, sha256, tokenAcak } from './crypto';

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
