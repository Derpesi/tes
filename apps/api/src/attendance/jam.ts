/** Jam sistem untuk absensi. Disuntikkan agar tes dapat mengatur waktu (aturan shift lintas tengah malam, toleransi). Produksi: waktu server. */
export const JAM_ABSENSI = Symbol('JAM_ABSENSI');
export type JamAbsensi = () => Date;
