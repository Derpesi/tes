/**
 * Serializer request untuk log. Query string DIBUANG karena dapat memuat rahasia sekali-pakai
 * (mis. `code` dan `state` pada callback OAuth, token pada tautan undangan/reset).
 */
export function serialisasiReq(r: { id?: unknown; method?: string; url?: string }) {
  return { id: r.id, method: r.method, url: (r.url ?? '').split('?')[0] };
}
