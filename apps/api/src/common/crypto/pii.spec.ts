import { randomBytes, randomUUID } from 'node:crypto';
import { blindIndexNik, dekripsiBerkas, dekripsiNik, enkripsiBerkas, enkripsiNik, nikValid, samarkanNik } from './pii';
import { hmac } from './crypto';

const NIK_UJI = '0000000000000001'; // sintetis, bukan NIK nyata

describe('PII member', () => {
  const kunci = randomBytes(32);
  const hmacKey = randomBytes(32);
  it('NIK: enkripsi bolak-balik; AAD profil lain gagal; ciphertext tidak memuat NIK terang', () => {
    const id = randomUUID();
    const ct = enkripsiNik(NIK_UJI, kunci, id);
    expect(dekripsiNik(ct, kunci, id)).toBe(NIK_UJI);
    expect(ct.includes(Buffer.from(NIK_UJI))).toBe(false);
    expect(() => dekripsiNik(ct, kunci, randomUUID())).toThrow();
  });
  it('blind index stabil, berbeda per NIK, dan terpisah dari HMAC domain lain', () => {
    expect(blindIndexNik(hmacKey, NIK_UJI).equals(blindIndexNik(hmacKey, NIK_UJI))).toBe(true);
    expect(blindIndexNik(hmacKey, NIK_UJI).equals(blindIndexNik(hmacKey, '0000000000000002'))).toBe(false);
    expect(blindIndexNik(hmacKey, NIK_UJI).equals(hmac(hmacKey, `nik:${NIK_UJI}`))).toBe(false);
    expect(blindIndexNik(hmacKey, NIK_UJI)).toHaveLength(32);
  });
  it('validasi dan penyamaran NIK', () => {
    expect(nikValid(NIK_UJI)).toBe(true);
    for (const buruk of ['123', '00000000000000a1', '00000000000000011', '']) expect(nikValid(buruk)).toBe(false);
    expect(samarkanNik(NIK_UJI)).toBe('************0001');
  });
  it('berkas: AAD terikat kunci objek, perubahan satu byte terdeteksi', () => {
    const isi = Buffer.from('%PDF-1.4 sintetis');
    const ko = `${randomUUID()}/${randomUUID()}`;
    const ct = enkripsiBerkas(isi, kunci, ko);
    expect(ct.includes(isi)).toBe(false);
    expect(dekripsiBerkas(ct, kunci, ko).equals(isi)).toBe(true);
    expect(() => dekripsiBerkas(ct, kunci, `${randomUUID()}/${randomUUID()}`)).toThrow();
    const rusak = Buffer.from(ct);
    rusak[rusak.length - 1] ^= 1;
    expect(() => dekripsiBerkas(rusak, kunci, ko)).toThrow();
  });
});
