/**
 * Serializer request untuk log. Query string DIBUANG karena dapat memuat rahasia sekali-pakai
 * (mis. `code` dan `state` pada callback OAuth, token pada tautan undangan/reset).
 */
export function serialisasiReq(r: { id?: unknown; method?: string; url?: string }) {
  return { id: r.id, method: r.method, url: (r.url ?? '').split('?')[0] };
}

/** Opsi pino-http yang dipakai aplikasi (diekspor agar tes memakai konfigurasi yang SAMA, bukan salinan). */
export function opsiPinoHttp(nodeEnv: string | undefined) {
  return {
    level: nodeEnv === 'production' ? 'info' : 'debug',
    // Jangan mencatat header sensitif atau body (potensi PII/rahasia).
    redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
    serializers: {
      req: serialisasiReq,
      res: (r: { statusCode?: number }) => ({ statusCode: r.statusCode }),
    },
  };
}
