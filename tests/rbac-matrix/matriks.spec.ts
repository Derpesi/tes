import { KODE_SAH, muatMatriksRbac, uraiSel } from './parse-matriks';

const PERAN = ['Direktur', 'Mgr Ops', 'IT', 'HRD', 'Marketing', 'Adm', 'Pay-Abs Rekanan', 'Keuangan', 'Pay Internal'];
const m = muatMatriksRbac();
const sel = (modul: string, peran: string) => m.sel.get(modul)?.get(peran) ?? new Set<string>();
const pemegang = (modul: string, kode: string) => m.peran.filter((p) => sel(modul, p).has(kode)).sort();

describe('uraiSel', () => {
  it('mengurai kode, kualifikasi, bintang, dan tanda kosong', () => {
    expect([...uraiSel('V,U(konfig)')]).toEqual(['V', 'U']);
    expect([...uraiSel('V(teknis, tanpa PII)')]).toEqual(['V']);
    expect([...uraiSel('V*,E')]).toEqual(['V', 'E']);
    expect(uraiSel('–').size).toBe(0);
  });
});

describe('docs/rbac.md', () => {
  it('memuat tepat 9 peran yang diharapkan', () => {
    expect(m.peran).toEqual(PERAN);
  });
  it('setiap kode izin berasal dari himpunan sah', () => {
    for (const [modul, perPeran] of m.sel) {
      for (const [peran, kode] of perPeran) {
        for (const k of kode) expect({ modul, peran, k, sah: (KODE_SAH as readonly string[]).includes(k) }).toMatchObject({ sah: true });
      }
    }
  });
  it('tidak ada kode pembayaran/transfer dan tidak ada modul pembayaran (tahap awal hanya rekap)', () => {
    expect([...m.sel.keys()].filter((x) => /pembayaran|transfer/i.test(x))).toEqual([]);
    for (const perPeran of m.sel.values()) for (const kode of perPeran.values()) expect(kode.has('P')).toBe(false);
  });
  it('rantai kewenangan: finalisasi rekap hanya Direktur dan Keuangan', () => {
    expect(pemegang('Persetujuan rekap', 'F')).toEqual(['Direktur', 'Keuangan']);
    for (const modul of m.sel.keys()) {
      if (modul !== 'Persetujuan rekap') expect({ modul, f: pemegang(modul, 'F') }).toEqual({ modul, f: [] });
    }
  });
  it('pemisahan tugas pada rekap payroll: tak ada peran yang membuat sekaligus memeriksa/menyetujui', () => {
    for (const modul of m.sel.keys()) {
      if (!/^Rekap payroll/.test(modul)) continue;
      for (const p of m.peran) {
        const k = sel(modul, p);
        const peranTugas = ['C', 'K', 'A', 'F'].filter((x) => k.has(x));
        expect({ modul, p, peranTugas: peranTugas.length <= 1 }).toEqual({ modul, p, peranTugas: true });
      }
    }
  });
  it('IT tidak boleh melihat selfie, rekap payroll, atau slip', () => {
    for (const modul of m.sel.keys()) {
      if (/selfie|payroll|slip/i.test(modul)) expect({ modul, v: sel(modul, 'IT').has('V') }).toEqual({ modul, v: false });
    }
  });
  it('lihat selfie hanya Mgr Ops, Pay-Abs Rekanan, dan Pay Internal (asumsi A-09)', () => {
    expect(pemegang('Lihat selfie', 'V')).toEqual(['Mgr Ops', 'Pay Internal', 'Pay-Abs Rekanan']);
  });
  it('pengelolaan pengguna dan peran: hanya IT mengubah, Direktur menyetujui', () => {
    expect(pemegang('Pengguna & role', 'C')).toEqual(['IT']);
    expect(pemegang('Pengguna & role', 'A')).toEqual(['Direktur']);
  });
  it('verifikasi dokumen PKWT hanya HRD', () => {
    expect(pemegang('Verifikasi dokumen PKWT', 'K')).toEqual(['HRD']);
  });
});
