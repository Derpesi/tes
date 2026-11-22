import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AWALAN_DIKENAL, kategoriAksi, kebijakanUntuk, KUNCI_DETAIL_BOLEH, saringDetail } from './kategori';

describe('kategoriAksi', () => {
  it.each([
    ['auth.login.success', 'TEKNIS'], ['auth.role.granted', 'TEKNIS'], ['system.apa-saja', 'TEKNIS'],
    ['payroll.recap.approved', 'TRANSAKSI'], ['payroll.recap.exported', 'TRANSAKSI'], ['report.exported', 'TRANSAKSI'], ['reports.bukan', 'OPERASIONAL'],
    ['attendance.selfie.viewed', 'OPERASIONAL'], ['master.company.created', 'OPERASIONAL'], ['member.nik.revealed', 'OPERASIONAL'], ['pkwt.contract.created', 'OPERASIONAL'],
    ['placement.approved', 'OPERASIONAL'], ['recruitment.vacancy.opened', 'OPERASIONAL'],
    ['aksi.tidak.dikenal', 'OPERASIONAL'], ['authx.bukan-teknis', 'OPERASIONAL'], ['xpayroll.bukan', 'OPERASIONAL'], ['', 'OPERASIONAL'],
  ] as const)('%s -> %s', (aksi, kat) => expect(kategoriAksi(aksi)).toBe(kat));
});

describe('kebijakanUntuk', () => {
  const lihat = (roles: string[]) => { const k = kebijakanUntuk(roles); return { kategori: [...k.kategori].sort(), detail: k.detail }; };
  it('per peran sesuai matriks', () => {
    expect(lihat(['DIREKTUR'])).toEqual({ kategori: ['OPERASIONAL', 'TEKNIS', 'TRANSAKSI'], detail: true });
    expect(lihat(['MANAGER_OPERASIONAL'])).toEqual({ kategori: ['OPERASIONAL', 'TRANSAKSI'], detail: true });
    expect(lihat(['IT_ADMIN'])).toEqual({ kategori: ['TEKNIS'], detail: false });
    expect(lihat(['STAFF_KEUANGAN'])).toEqual({ kategori: ['TRANSAKSI'], detail: true });
  });
  it('peran lain atau kosong = tidak ada akses (gagal-aman); gabungan peran = union', () => {
    for (const r of [[], ['HRD'], ['MARKETING'], ['STAFF_ADMINISTRASI'], ['STAFF_PAYROLL_INTERNAL'], ['PERAN_BARU']]) expect(lihat(r)).toEqual({ kategori: [], detail: false });
    expect(lihat(['IT_ADMIN', 'STAFF_KEUANGAN'])).toEqual({ kategori: ['TEKNIS', 'TRANSAKSI'], detail: true });
  });
});

describe('saringDetail', () => {
  it('membuang kunci tak dikenal (PII/rahasia) dan nilai bersarang; memotong teks panjang', () => {
    const r = saringDetail({ nik: '9900000000000001', email: 'a@b.invalid', emailRef: 'x', subjek: 'Halo Budi', password: 'rahasia', token: 't', jenis: 'PARTNER', versi: 2, bersarang: { a: 1 }, alasan: 'x'.repeat(500), bidang: ['a', 'b'], campur: [1, { x: 1 }] });
    expect(Object.keys(r).sort()).toEqual(['alasan', 'bidang', 'jenis', 'versi']);
    expect((r.alasan as string).length).toBe(300);
    expect(r.bidang).toEqual(['a', 'b']);
  });
  it('bukan objek -> kosong; null/boolean/angka lolos', () => {
    for (const v of [null, undefined, 'teks', 5, ['a']]) expect(saringDetail(v)).toEqual({});
    expect(saringDetail({ status: null, mode: true, jumlah: 3 })).toEqual({ status: null, mode: true, jumlah: 3 });
  });
  it('daftar putih tidak memuat kunci berbau PII', () => {
    for (const k of KUNCI_DETAIL_BOLEH) expect(k).not.toMatch(/nik|email|nama|name|phone|telepon|alamat|address|password|token|secret|rekening|gaji|lat|lng|selfie|subjek/i);
  });
});

/** Menelusuri sumber: setiap aksi audit yang dipakai kode harus memakai awalan yang dikenal (agar kategori dan pembatasan IT/Keuangan tidak bocor). */
describe('semua aksi audit di kode terpetakan', () => {
  const akar = join(__dirname, '..');
  const berkas = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? berkas(p) : p.endsWith('.ts') && !p.endsWith('.spec.ts') ? [p] : []; });
  const sumber = berkas(akar).map((p) => readFileSync(p, 'utf8')).join('\n');
  const aksi = new Set<string>();
  for (const m of sumber.matchAll(/aksi: '([a-z_]+(?:\.[a-z_]+)+)'/g)) aksi.add(m[1]);
  for (const m of sumber.matchAll(/auditSunting\([^,]+,[^,]+, '([a-z_]+(?:\.[a-z_]+)+)'/g)) aksi.add(m[1]);
  for (const m of sumber.matchAll(/'(placement\.[a-z_]+)'/g)) aksi.add(m[1]);
  it('menemukan aksi yang wajar jumlahnya (penelusuran tidak kosong)', () => expect(aksi.size).toBeGreaterThan(80));
  it.each([...aksi].sort())('%s memakai awalan yang dikenal', (a) => expect(AWALAN_DIKENAL as readonly string[]).toContain(a.split('.')[0]));
  it('semua aksi payroll berkategori TRANSAKSI dan auth TEKNIS', () => {
    for (const a of aksi) {
      if (a.startsWith('payroll.')) expect(kategoriAksi(a)).toBe('TRANSAKSI');
      if (a.startsWith('auth.')) expect(kategoriAksi(a)).toBe('TEKNIS');
    }
  });
});
