const RADIUS_BUMI_M = 6371008.8;
const rad = (d: number) => (d * Math.PI) / 180;

/** Jarak lingkaran besar (Haversine) dalam meter. */
export function jarakMeter(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * RADIUS_BUMI_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

export const koordinatSah = (lat: number, lng: number): boolean => Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
