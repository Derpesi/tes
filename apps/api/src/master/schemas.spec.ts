import { PengaturanDokumen } from './schemas';

describe('PengaturanDokumen', () => {
  it('retensi selfie: bilangan bulat 7-3650 hari', () => {
    for (const n of [7, 90, 3650]) expect(PengaturanDokumen.safeParse({ selfieRetentionDays: n }).success).toBe(true);
    for (const n of [6, 0, 3651, 1.5, -1]) expect(PengaturanDokumen.safeParse({ selfieRetentionDays: n }).success).toBe(false);
    expect(PengaturanDokumen.safeParse({ selfieRetentionDays: '90' }).success).toBe(false);
  });
  it('pesan galat berbahasa Indonesia dan kunci tak dikenal ditolak', () => {
    const r = PengaturanDokumen.safeParse({ selfieRetentionDays: 3 });
    expect(r.success ? '' : r.error.issues[0].message).toBe('Retensi selfie minimal 7 hari');
    expect(PengaturanDokumen.safeParse({ lain: 1 }).success).toBe(false);
  });
  it('pkwt: penandatangan/kota/legalitas; batas panjang dan jumlah; kunci tak dikenal ditolak', () => {
    expect(PengaturanDokumen.safeParse({ pkwt: { penandatanganNama: 'Nama Sintetis', penandatanganJabatan: 'Personalia', kota: 'Tangerang', legalitas: ['Butir satu', 'Butir dua'] } }).success).toBe(true);
    expect(PengaturanDokumen.safeParse({ pkwt: {} }).success).toBe(true);
    expect(PengaturanDokumen.safeParse({ pkwt: { legalitas: Array.from({ length: 11 }, () => 'x') } }).success).toBe(false);
    expect(PengaturanDokumen.safeParse({ pkwt: { legalitas: ['x'.repeat(301)] } }).success).toBe(false);
    expect(PengaturanDokumen.safeParse({ pkwt: { penandatanganNama: '' } }).success).toBe(false);
    expect(PengaturanDokumen.safeParse({ pkwt: { klausul: 'x' } }).success).toBe(false);
    const r = PengaturanDokumen.safeParse({ pkwt: { legalitas: Array.from({ length: 11 }, () => 'x') } });
    expect(r.success ? '' : r.error.issues[0].message).toBe('Legalitas maksimal 10 butir');
  });
});
