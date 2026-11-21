import {
  COMPANY_SINTETIS,
  LABEL,
  emailSintetis,
  namaPekerjaSintetis,
  namaPerusahaanSintetis,
  nikSintetis,
} from './data-sintetis';

describe('data sintetis', () => {
  it('nama perusahaan dan pekerja berlabel SINTETIS', () => {
    expect(namaPerusahaanSintetis('A')).toContain(LABEL);
    expect(namaPekerjaSintetis(7)).toContain(LABEL);
  });
  it('NIK 16 digit dan berawalan 0000 (tidak valid, tidak bisa menyamai NIK nyata)', () => {
    const nik = nikSintetis(42);
    expect(nik).toMatch(/^0000\d{12}$/);
    expect(nik).toHaveLength(16);
  });
  it('email memakai domain .invalid', () => {
    expect(emailSintetis(1)).toMatch(/@contoh\.invalid$/);
  });
  it('generator deterministik dan berbeda per nomor', () => {
    expect(nikSintetis(1)).toBe(nikSintetis(1));
    expect(nikSintetis(1)).not.toBe(nikSintetis(2));
  });
  it('UUID perusahaan sintetis valid dan unik', () => {
    const nilai = Object.values(COMPANY_SINTETIS);
    expect(new Set(nilai).size).toBe(nilai.length);
    for (const v of nilai) expect(v).toMatch(/^[0-9a-f-]{36}$/);
  });
});
