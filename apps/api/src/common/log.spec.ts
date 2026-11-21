import { serialisasiReq } from './log';

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
