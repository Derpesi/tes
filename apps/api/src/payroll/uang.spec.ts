import { BarisSnapshot, formatUang, hashSnapshot, parseUang, subtotalPerJenis } from './uang';

describe('parseUang / formatUang', () => {
  it.each([['0', 0n], ['0.5', 50n], ['0.05', 5n], ['12', 1200n], ['1234567.89', 123456789n], ['999999999999.99', 99999999999999n], ['001', 100n]])('%s -> %s sen', (t, sen) => {
    expect(parseUang(t)).toBe(sen);
  });
  it.each(['', '-1', '+1', '1,5', '1.234', '.5', '5.', '1e3', '1000000000000', ' 1', '1 ', 'NaN', 'Infinity', '0x10', '१२'])('menolak %j', (t) => {
    expect(() => parseUang(t)).toThrow('Nominal tidak valid');
  });
  it('menolak bukan-teks (angka JS/float tidak diterima)', () => {
    for (const v of [1, 0.1, null, undefined, {}, 10n]) expect(() => parseUang(v)).toThrow('Nominal tidak valid');
  });
  it('format: dua desimal tetap, tanpa kesalahan float, bolak-balik', () => {
    expect(formatUang(0n)).toBe('0.00');
    expect(formatUang(5n)).toBe('0.05');
    expect(formatUang(123456789n)).toBe('1234567.89');
    for (const t of ['0.10', '0.20', '0.30', '19.99', '100.00']) expect(formatUang(parseUang(t))).toBe(t);
    expect(() => formatUang(-1n)).toThrow();
  });
});

describe('subtotalPerJenis', () => {
  it('menjumlahkan tepat (0.1 + 0.2 = 0.30, bukan 0.30000000000000004)', () => {
    expect(subtotalPerJenis([{ kind: 'TUNJANGAN', amount: '0.10' }, { kind: 'TUNJANGAN', amount: '0.20' }, { kind: 'POTONGAN', amount: '5' }])).toEqual({ TUNJANGAN: '0.30', POTONGAN: '5.00', INSENTIF: '0.00' });
  });
  it('tanpa komponen = nol; tidak ada bidang total/neto', () => {
    const r = subtotalPerJenis([]);
    expect(r).toEqual({ TUNJANGAN: '0.00', POTONGAN: '0.00', INSENTIF: '0.00' });
    expect(Object.keys(r).join()).not.toMatch(/total|neto|gaji|net/i);
  });
  it('jumlah besar tetap eksak', () => {
    const banyak = Array.from({ length: 1000 }, () => ({ kind: 'INSENTIF' as const, amount: '999999999999.99' }));
    expect(subtotalPerJenis(banyak).INSENTIF).toBe('999999999999990.00');
  });
});

describe('hashSnapshot', () => {
  const dasar = (o: Partial<BarisSnapshot> = {}): BarisSnapshot => ({
    personId: 'p1', workerName: 'A', source: 'ATTENDANCE', daysPresent: 20, daysAbsent: 1, daysPermit: 0, daysSick: 0, daysLeave: 0, lateCount: 2, earlyLeaveCount: 0, pendingCount: 0,
    hoursWorked: '160.00', overtimeHours: '0.00', note: null, components: [{ kind: 'TUNJANGAN', name: 'Makan', amount: '100.00' }], ...o,
  });
  it('stabil terhadap urutan baris dan komponen', () => {
    const a = [dasar(), dasar({ personId: 'p2', components: [{ kind: 'POTONGAN', name: 'B', amount: '1.00' }, { kind: 'INSENTIF', name: 'A', amount: '2.00' }] })];
    const b = [a[1], dasar()].map((x) => ({ ...x, components: [...x.components].reverse() }));
    expect(hashSnapshot(a)).toBe(hashSnapshot(b));
    expect(hashSnapshot(a)).toMatch(/^[0-9a-f]{64}$/);
  });
  it('berubah bila nominal, hari, nama, atau komponen berubah sekecil apa pun', () => {
    const awal = hashSnapshot([dasar()]);
    for (const o of [{ daysPresent: 21 }, { workerName: 'B' }, { hoursWorked: '160.01' }, { note: 'x' }, { components: [{ kind: 'TUNJANGAN' as const, name: 'Makan', amount: '100.01' }] }, { components: [] }]) {
      expect(hashSnapshot([dasar(o)])).not.toBe(awal);
    }
    expect(hashSnapshot([dasar(), dasar({ personId: 'p2' })])).not.toBe(awal);
  });
});
