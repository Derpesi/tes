import { createHash } from 'node:crypto';

/**
 * Uang TIDAK PERNAH float: nominal diterima sebagai teks desimal, diubah ke bilangan bulat sen (bigint), dijumlahkan sebagai bigint,
 * lalu diformat kembali sebagai teks. Batas 12 digit sebelum koma, maksimal 2 digit desimal (sesuai NUMERIC(14,2)).
 */
export const POLA_UANG = /^\d{1,12}(\.\d{1,2})?$/;
export type JenisKomponen = 'TUNJANGAN' | 'POTONGAN' | 'INSENTIF';
export const JENIS_KOMPONEN: readonly JenisKomponen[] = ['TUNJANGAN', 'POTONGAN', 'INSENTIF'];

export function parseUang(teks: unknown): bigint {
  if (typeof teks !== 'string' || !POLA_UANG.test(teks)) throw new RangeError('Nominal tidak valid');
  const [bulat, pecahan = ''] = teks.split('.');
  return BigInt(bulat) * 100n + BigInt(pecahan.padEnd(2, '0'));
}

export function formatUang(sen: bigint): string {
  if (sen < 0n) throw new RangeError('Nominal negatif tidak diperbolehkan');
  const s = sen.toString().padStart(3, '0');
  return `${s.slice(0, -2)}.${s.slice(-2)}`;
}

export interface Komponen { kind: JenisKomponen; name: string; amount: string }

/** Subtotal per jenis (hanya penjumlahan masukan; BUKAN gaji/neto). Nominal dari database berupa teks NUMERIC. */
export function subtotalPerJenis(komponen: Pick<Komponen, 'kind' | 'amount'>[]): Record<JenisKomponen, string> {
  const jumlah: Record<JenisKomponen, bigint> = { TUNJANGAN: 0n, POTONGAN: 0n, INSENTIF: 0n };
  for (const k of komponen) jumlah[k.kind] += parseUang(k.amount);
  return { TUNJANGAN: formatUang(jumlah.TUNJANGAN), POTONGAN: formatUang(jumlah.POTONGAN), INSENTIF: formatUang(jumlah.INSENTIF) };
}

export interface BarisSnapshot {
  personId: string;
  workerName: string;
  source: string;
  daysPresent: number; daysAbsent: number; daysPermit: number; daysSick: number; daysLeave: number;
  lateCount: number; earlyLeaveCount: number; pendingCount: number;
  hoursWorked: string; overtimeHours: string;
  note: string | null;
  components: Komponen[];
}

/** Hash kanonik isi rekap (urutan tetap, nominal sebagai teks). Disimpan saat DISETUJUI dan dicek ulang saat ekspor. */
export function hashSnapshot(baris: BarisSnapshot[]): string {
  const kanon = [...baris]
    .sort((a, b) => a.personId.localeCompare(b.personId))
    .map((b) => ({ ...b, components: [...b.components].sort((x, y) => `${x.kind}|${x.name}|${x.amount}`.localeCompare(`${y.kind}|${y.name}|${y.amount}`)).map((c) => ({ kind: c.kind, name: c.name, amount: c.amount })) }))
    .map((b) => [b.personId, b.workerName, b.source, b.daysPresent, b.daysAbsent, b.daysPermit, b.daysSick, b.daysLeave, b.lateCount, b.earlyLeaveCount, b.pendingCount, b.hoursWorked, b.overtimeHours, b.note, b.components]);
  return createHash('sha256').update(JSON.stringify(kanon)).digest('hex');
}
