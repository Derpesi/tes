// Kerangka uji beban k6 — BELUM DIJALANKAN pada Fase 2 (k6 tidak terpasang di lingkungan pengembangan ini).
// Pakai: k6 run -e BASE_URL=https://staging.contoh.invalid tests/load/smoke-health.js
// Ambang di bawah adalah ASUMSI A-04, bukan SLA, dan harus divalidasi di staging.
import http from 'k6/http';
import { check, sleep } from 'k6';

if (!__ENV.BASE_URL) {
  throw new Error('BASE_URL wajib diisi (mis. -e BASE_URL=https://staging.contoh.invalid)');
}

export const options = {
  vus: 5,
  duration: '30s',
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<1000'],
  },
};

export default function () {
  const res = http.get(`${__ENV.BASE_URL}/health`);
  check(res, { 'status 200': (r) => r.status === 200 });
  sleep(1);
}
