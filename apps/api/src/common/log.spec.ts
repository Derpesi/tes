import { Writable } from 'node:stream';
import express from 'express';
import pinoHttp from 'pino-http';
import request from 'supertest';
import { opsiPinoHttp, serialisasiReq } from './log';

describe('serialisasiReq', () => {
  it('membuang query string (code, state, token) dari URL yang dicatat', () => {
    const r = serialisasiReq({ id: 1, method: 'GET', url: '/auth/member/google/callback?code=RAHASIA&state=RAHASIA2' });
    expect(r.url).toBe('/auth/member/google/callback');
    expect(JSON.stringify(r)).not.toContain('RAHASIA');
  });
  it('mempertahankan jalur tanpa query dan menangani url kosong', () => {
    expect(serialisasiReq({ url: '/health' }).url).toBe('/health');
    expect(serialisasiReq({}).url).toBe('');
  });
});

describe('konfigurasi pino-http yang dipakai aplikasi', () => {
  it('tidak mencatat query string (code/state), cookie, atau authorization, namun tetap mencatat jalur permintaan', async () => {
    const baris: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        baris.push(chunk.toString());
        cb();
      },
    });
    const app = express();
    app.use(pinoHttp({ ...opsiPinoHttp('test'), stream }));
    app.get('/auth/member/google/callback', (_req, res) => void res.status(302).setHeader('Set-Cookie', '__Host-sid=SESI-RAHASIA; HttpOnly').end());
    await request(app)
      .get('/auth/member/google/callback?code=KODE-RAHASIA&state=STATE-RAHASIA&id_token=TOKEN-RAHASIA')
      .set('Cookie', '__Host-oidc=COOKIE-RAHASIA')
      .set('Authorization', 'Bearer BEARER-RAHASIA')
      .expect(302);
    await new Promise((r) => setTimeout(r, 50));
    const log = baris.join('');
    expect(log).toContain('/auth/member/google/callback'); // bukti log benar-benar tertangkap
    expect(log).not.toMatch(/RAHASIA/);
  });
});

