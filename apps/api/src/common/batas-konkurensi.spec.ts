import { BatasKonkurensi, SistemSibuk } from './batas-konkurensi';

const tunda = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Tugas yang tetap berjalan sampai `selesai()` dipanggil. */
const tugasTahan = () => {
  let selesai!: () => void;
  const p = new Promise<void>((r) => { selesai = r; });
  return { p, selesai };
};

describe('BatasKonkurensi', () => {
  it('tidak pernah menjalankan lebih dari maks tugas bersamaan; sisanya antre lalu berjalan berurutan', async () => {
    const b = new BatasKonkurensi(2, 10, 1000);
    let aktif = 0;
    let puncak = 0;
    const kerja = async () => { aktif++; puncak = Math.max(puncak, aktif); await tunda(10); aktif--; return 1; };
    const hasil = await Promise.all(Array.from({ length: 8 }, () => b.jalankan(kerja)));
    expect(hasil).toHaveLength(8);
    expect(puncak).toBe(2);
    expect(b.status).toEqual({ berjalan: 0, antre: 0 });
  });

  it('antrean penuh => SistemSibuk 503 segera (tanpa menunggu)', async () => {
    const b = new BatasKonkurensi(1, 1, 5000);
    const t1 = tugasTahan();
    const a = b.jalankan(() => t1.p); // slot
    const bq = b.jalankan(async () => 'antre'); // antrean 1
    await tunda(5);
    const mulai = Date.now();
    await expect(b.jalankan(async () => 'ditolak')).rejects.toBeInstanceOf(SistemSibuk);
    expect(Date.now() - mulai).toBeLessThan(200);
    expect(b.status).toEqual({ berjalan: 1, antre: 1 });
    t1.selesai();
    await a;
    await expect(bq).resolves.toBe('antre');
    expect(b.status).toEqual({ berjalan: 0, antre: 0 });
  });

  it('menunggu terlalu lama => SistemSibuk dan entri dikeluarkan dari antrean', async () => {
    const b = new BatasKonkurensi(1, 5, 30);
    const t1 = tugasTahan();
    const a = b.jalankan(() => t1.p);
    await expect(b.jalankan(async () => 'x')).rejects.toBeInstanceOf(SistemSibuk);
    expect(b.status).toEqual({ berjalan: 1, antre: 0 });
    t1.selesai();
    await a;
  });

  it('slot dilepas saat tugas gagal (tidak bocor) dan galat asli diteruskan', async () => {
    const b = new BatasKonkurensi(1, 5, 1000);
    await expect(b.jalankan(async () => { throw new Error('gagal'); })).rejects.toThrow('gagal');
    expect(b.status).toEqual({ berjalan: 0, antre: 0 });
    await expect(b.jalankan(async () => 'ok')).resolves.toBe('ok');
  });

  it('slot dialihkan ke penunggu pertama (FIFO) tanpa melebihi maks', async () => {
    const b = new BatasKonkurensi(1, 5, 1000);
    const urutan: number[] = [];
    const t1 = tugasTahan();
    const a = b.jalankan(async () => { await t1.p; urutan.push(0); });
    const x = b.jalankan(async () => { urutan.push(1); });
    const y = b.jalankan(async () => { urutan.push(2); });
    t1.selesai();
    await Promise.all([a, x, y]);
    expect(urutan).toEqual([0, 1, 2]);
  });

  it('atur() mengubah batas saat berjalan', async () => {
    const b = new BatasKonkurensi(1, 0, 10);
    const t1 = tugasTahan();
    const a = b.jalankan(() => t1.p);
    await expect(b.jalankan(async () => 1)).rejects.toBeInstanceOf(SistemSibuk);
    b.atur(2, 0, 10);
    await expect(b.jalankan(async () => 1)).resolves.toBe(1);
    t1.selesai();
    await a;
  });
});
