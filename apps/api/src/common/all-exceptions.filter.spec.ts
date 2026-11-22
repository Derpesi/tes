import { BadRequestException } from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';

function jalankan(e: unknown) {
  const kirim: { status?: number; body?: Record<string, unknown> } = {};
  const res = { status: (s: number) => ({ json: (b: Record<string, unknown>) => { kirim.status = s; kirim.body = b; } }) };
  new AllExceptionsFilter().catch(e, { switchToHttp: () => ({ getResponse: () => res }) } as never);
  return kirim;
}

describe('AllExceptionsFilter', () => {
  it('galat 4xx dari middleware HTTP (body-parser) dipetakan ke status aslinya, bukan 500', () => {
    const besar = Object.assign(new Error('request entity too large'), { status: 413, type: 'entity.too.large' });
    expect(jalankan(besar)).toMatchObject({ status: 413, body: { kode: 'HTTP_413', pesan: 'Ukuran berkas melebihi batas yang diizinkan' } });
    const rusak = Object.assign(new SyntaxError('Unexpected token'), { statusCode: 400, type: 'entity.parse.failed' });
    const r = jalankan(rusak);
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).not.toMatch(/Unexpected token/); // pesan pustaka tidak bocor
  });
  it('galat tak terduga tetap 500 tanpa membocorkan pesan; status non-4xx dari pustaka diabaikan', () => {
    for (const e of [new Error('SELECT * FROM rahasia gagal'), Object.assign(new Error('x'), { status: 200 }), Object.assign(new Error('x'), { status: 502 }), null, 'teks']) {
      const r = jalankan(e);
      expect(r.status).toBe(500);
      expect(JSON.stringify(r.body)).not.toMatch(/SELECT|rahasia/);
    }
  });
  it('HttpException terkurasi tetap membawa kode dan pesan Indonesia', () => {
    expect(jalankan(new BadRequestException({ kode: 'UJI', message: 'Pesan uji' }))).toMatchObject({ status: 400, body: { kode: 'UJI', pesan: 'Pesan uji' } });
  });
});
