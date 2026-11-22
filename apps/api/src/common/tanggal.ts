/** Tanggal kalender YYYY-MM-DD yang benar-benar ada. Aman untuk masukan sembarang (tidak pernah melempar RangeError). */
export const tanggalValid = (v: string): boolean => {
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v);
};
