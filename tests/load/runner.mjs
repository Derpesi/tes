#!/usr/bin/env node
// Runner uji beban tanpa dependency (fetch bawaan Node). Model open-loop: permintaan dikirim sesuai jadwal laju,
// tidak menunggu respons sebelumnya, sehingga antrean server tampak sebagai kenaikan latensi (bukan melambatnya pengirim).
// Pakai (staging/lokal SAJA, data sintetis hasil seed-besar.mjs; jangan arahkan ke production):
//   BASE_URL=http://127.0.0.1:3001 APP_BASE_URL=<sama dengan API> AUTH_HMAC_KEY=<sama dengan API> \
//   node tests/load/runner.mjs --skenario scan --rps 100 --durasi 60 [--ramp 10] [--selfie] [--lokasi <uuid>] [--keluaran hasil.json]
// Skenario: scan (POST /member/attendance + selfie sintetis ~100 KB, pekerja berbeda per permintaan),
//           baca (campuran GET staf: dashboard, rekap, tinjauan, laporan, audit), ekspor (CSV laporan absensi, sinkron; ekspor rekap butuh izin khusus dan filter lokasi, tidak diukur di sini).
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3001';
const ORIGIN = process.env.APP_BASE_URL;
const KUNCI = process.env.AUTH_HMAC_KEY;
if (!ORIGIN || !KUNCI) throw new Error('APP_BASE_URL dan AUTH_HMAC_KEY wajib diisi (sama dengan konfigurasi API)');
if (/production|prod\./i.test(BASE)) throw new Error('Menolak BASE_URL yang tampak seperti production');

const skenario = arg('skenario', 'scan');
const rps = Number(arg('rps', 20));
const durasi = Number(arg('durasi', 30));
const ramp = Number(arg('ramp', 0));
const mulaiNo = Number(arg('mulai', 0));
const lokasiId = arg('lokasi'); // locationId untuk rekap (tanpa ini rekap memakai rentang 7 hari, batas server A-62)
const denganSelfie = process.argv.includes('--selfie'); // selfie ditiadakan sementara (bawaan produk); aktifkan hanya bila API memakai ABSENSI_SELFIE=on
const sesi = JSON.parse(readFileSync(arg('sesi', 'tests/load/.keluaran/sesi.json'), 'utf8'));
const kunci = Buffer.from(KUNCI, 'base64');
const csrf = (id) => createHmac('sha256', kunci).update(`csrf:${id}`).digest('base64url');
const hdr = (s) => ({ cookie: `__Host-sid=${s.token}`, 'x-csrf-token': csrf(s.sesiId), origin: ORIGIN });
const selfie = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('SELFIE-SINTETIS-UJI-BEBAN'), randomBytes(100 * 1024)]);

const hariIni = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
const kemarin = new Date(Date.now() + 7 * 3600e3 - 86400e3).toISOString().slice(0, 10);
const awal = new Date(Date.now() + 7 * 3600e3 - 30 * 86400e3).toISOString().slice(0, 10);

const aksi = {
  scan: (i) => {
    const m = sesi.member[(mulaiNo + i) % sesi.member.length];
    const f = new FormData();
    f.set('code', m.kode); f.set('kind', 'MASUK'); f.set('latitude', String(m.lat)); f.set('longitude', String(m.lng)); f.set('accuracy', '15');
    f.set('deviceId', `perangkat-beban-${m.no}`.padEnd(16, 'x')); f.set('idempotencyKey', `beban-${m.no}-${randomBytes(6).toString('hex')}`);
    if (denganSelfie) f.set('selfie', new Blob([selfie], { type: 'image/jpeg' }), 'selfie.jpg');
    return { nama: 'scan', url: `${BASE}/member/attendance`, init: { method: 'POST', headers: hdr(m), body: f } };
  },
  baca: (i) => {
    const s = sesi.staf[i % sesi.staf.length];
    const pilih = [
      ['dashboard', '/dashboard/staff'],
      ['rekap', lokasiId ? `/attendance/recap?from=${awal}&to=${kemarin}&locationId=${lokasiId}&limit=50` : `/attendance/recap?from=${new Date(Date.now() + 7 * 3600e3 - 7 * 86400e3).toISOString().slice(0, 10)}&to=${kemarin}&limit=50`],
      ['tinjauan', '/attendance/review?tahap=MENUNGGU_PERIKSA&limit=50'],
      ['laporan-absensi', `/reports/attendance?from=${awal}&to=${kemarin}`],
      ['laporan-tenaga', `/reports/workforce?from=${awal}&to=${kemarin}`],
      ['audit', '/audit-logs?limit=50'],
    ][i % 6];
    return { nama: pilih[0], url: `${BASE}${pilih[1]}`, init: { method: 'GET', headers: hdr(s) } };
  },
  ekspor: (i) => {
    const s = sesi.staf[i % sesi.staf.length];
    const pilih = ['ekspor-laporan', `/reports/attendance/export.csv?from=${awal}&to=${kemarin}`];
    return { nama: pilih[0], url: `${BASE}${pilih[1]}`, init: { method: 'GET', headers: hdr(s) } };
  },
}[skenario];
if (!aksi) throw new Error(`Skenario tidak dikenal: ${skenario}`);

const lat = new Map(); // nama -> daftar latensi (ms)
const status = new Map(); // nama -> {kode: jumlah}
let terkirim = 0; let selesai = 0; let galatJaringan = 0;
const catat = (nama, ms, kode) => {
  (lat.get(nama) ?? lat.set(nama, []).get(nama)).push(ms);
  const s = status.get(nama) ?? status.set(nama, {}).get(nama); s[kode] = (s[kode] ?? 0) + 1;
};
const persen = (a, p) => a.length ? a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] : 0;

async function kirim(i) {
  const { nama, url, init } = aksi(i);
  const t = performance.now();
  terkirim++;
  try {
    const r = await fetch(url, init);
    await r.arrayBuffer();
    catat(nama, performance.now() - t, r.status);
  } catch { galatJaringan++; catat(nama, performance.now() - t, 'GALAT'); }
  selesai++;
}

const mulai = performance.now();
const tugas = [];
let i = 0;
// jadwal: laju target pada waktu t (detik) = rps * min(1, t/ramp) bila ramp>0
while (true) {
  const t = (performance.now() - mulai) / 1000;
  if (t >= durasi) break;
  const lajuSaatIni = ramp > 0 ? Math.max(1, rps * Math.min(1, t / ramp)) : rps;
  const target = Math.floor(integral(t, lajuSaatIni));
  while (i < target) { tugas.push(kirim(i)); i++; }
  await new Promise((r) => setTimeout(r, 5));
}
function integral(t, laju) { // jumlah permintaan kumulatif yang seharusnya sudah dikirim
  if (ramp > 0 && t < ramp) return (rps / ramp) * t * t / 2;
  return ramp > 0 ? (rps * ramp) / 2 + rps * (t - ramp) : rps * t;
}
await Promise.all(tugas);
const lama = (performance.now() - mulai) / 1000;

const hasil = { skenario, rpsTarget: rps, durasiDetik: durasi, ramp, terkirim, selesai, galatJaringan, rpsRealisasi: +(selesai / lama).toFixed(1), perEndpoint: {} };
for (const [nama, a] of lat) {
  a.sort((x, y) => x - y);
  hasil.perEndpoint[nama] = { n: a.length, p50: +persen(a, 50).toFixed(1), p95: +persen(a, 95).toFixed(1), p99: +persen(a, 99).toFixed(1), maks: +a[a.length - 1].toFixed(1), status: status.get(nama) };
}
console.log(JSON.stringify(hasil, null, 2));
if (arg('keluaran')) writeFileSync(arg('keluaran'), JSON.stringify(hasil, null, 2));
