import { muatMatriksRbac } from './parse-matriks';
import { Kebijakan, kebijakanDariMatriks, ujiKebijakan } from './uji-kebijakan';

const m = muatMatriksRbac();

describe('ujiKebijakan (uji diri harness; implementasi RBAC sungguhan dicolokkan di Fase 3)', () => {
  it('kebijakan yang persis sama dengan docs/rbac.md lolos', () => {
    const h = ujiKebijakan(kebijakanDariMatriks(m), m);
    expect(h.lolos).toBe(true);
    expect(h.kelebihan).toEqual([]);
    expect(h.kekurangan).toEqual([]);
  });

  it('kebijakan palsu yang kelebihan izin DITOLAK dan dilaporkan', () => {
    const asli = kebijakanDariMatriks(m);
    const bocor: Kebijakan = (peran, modul) => {
      const s = asli(peran, modul);
      if (peran === 'IT' && modul === 'Lihat selfie') s.add('V'); // IT tidak boleh melihat selfie
      return s;
    };
    const h = ujiKebijakan(bocor, m);
    expect(h.lolos).toBe(false);
    expect(h.kelebihan).toContain('IT / Lihat selfie: V');
    expect(h.laporan).toContain('!V'); // sel bermasalah ditandai di laporan
  });

  it('kebijakan yang kekurangan izin juga gagal (drift terhadap dokumen)', () => {
    const asli = kebijakanDariMatriks(m);
    const kurang: Kebijakan = (peran, modul) => {
      const s = asli(peran, modul);
      if (peran === 'HRD' && modul === 'Verifikasi dokumen PKWT') s.delete('K');
      return s;
    };
    const h = ujiKebijakan(kurang, m);
    expect(h.lolos).toBe(false);
    expect(h.kekurangan).toContain('HRD / Verifikasi dokumen PKWT: K');
  });

  it('kebijakan deny-all gagal karena kekurangan, bukan kelebihan', () => {
    const h = ujiKebijakan(() => new Set(), m);
    expect(h.lolos).toBe(false);
    expect(h.kelebihan).toEqual([]);
    expect(h.kekurangan.length).toBeGreaterThan(0);
  });

  it('laporan memuat semua modul dan header 9 peran', () => {
    const h = ujiKebijakan(kebijakanDariMatriks(m), m);
    const baris = h.laporan.split('\n');
    expect(baris).toHaveLength(m.sel.size + 1);
    expect(baris[0].split(' | ')).toHaveLength(10);
  });
});
