// Generator data uji SINTETIS. Dilarang memakai data pekerja nyata.
// Semua nilai berlabel "SINTETIS" agar tidak pernah tertukar dengan data sungguhan.
export const LABEL = 'SINTETIS';

/** UUID tetap per perusahaan sintetis agar tes deterministik. */
export const COMPANY_SINTETIS = {
  A: '00000000-0000-4000-8000-00000000000a',
  B: '00000000-0000-4000-8000-00000000000b',
  C: '00000000-0000-4000-8000-00000000000c',
} as const;

const pad = (n: number, lebar: number) => String(n).padStart(lebar, '0');

export function namaPerusahaanSintetis(kode: string): string {
  return `PT ${LABEL} ${kode}`;
}

export function namaPekerjaSintetis(n: number): string {
  return `${LABEL} Pekerja ${pad(n, 3)}`;
}

/** NIK 16 digit berawalan "0000" (kode wilayah tidak valid) sehingga tidak dapat menyamai NIK nyata. */
export function nikSintetis(n: number): string {
  return `0000${pad(n, 12)}`;
}

/** Domain `.invalid` dicadangkan standar agar tidak pernah dapat dikirimi email sungguhan. */
export function emailSintetis(n: number): string {
  return `sintetis-${pad(n, 3)}@contoh.invalid`;
}
