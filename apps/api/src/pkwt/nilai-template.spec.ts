import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatLegalitas, susunNilaiTemplate } from './nilai-template';
import { ekstrakVariabel, isiTemplateLengkap, TITIK_ISIAN, variabelTidakDikenal } from './variabel';

const perusahaan = { name: 'PT. SINTETIS A', legal_name: 'PT. Sintetis Abadi', address: 'Jl. Contoh No. 1', city: 'Bandung', province: 'Jawa Barat', pkwt: { penandatanganNama: 'Penandatangan Sintetis', penandatanganJabatan: 'Personalia', legalitas: ['Akta Sintetis Nomor 1', 'NIB Sintetis 2'], pengadilanNegeri: 'Bandung' } };
const pekerja = { full_name: 'SINTETIS Pekerja', nik: '3201010101010001', birth_place: 'Bandung', birth_date: '1990-01-05', education: 'SMA/SMK', address: 'Jl. Pekerja 2', city: 'Bandung', phone: '08123456' };
const kontrak = { contract_number: 'PKWT/A/2026/0001', position: 'Satpam', start_date: '2026-03-01', end_date: '2026-12-31' };

describe('susunNilaiTemplate', () => {
  it('menyusun nilai Pihak Pertama, Pihak Kedua, dan penempatan dari data master', () => {
    const n = susunNilaiTemplate({ perusahaan, pekerja, kontrak, penempatan: { rekanan: 'Rekanan Sintetis', alamat: 'Jl. Lokasi 3, Bandung' }, tanggalCetakIso: '2026-02-20' });
    expect(n).toMatchObject({
      perusahaan_hukum: 'PT. Sintetis Abadi', perusahaan_hukum_kapital: 'PT. SINTETIS ABADI', perusahaan_alamat: 'Jl. Contoh No. 1, Bandung, Jawa Barat',
      perusahaan_legalitas: 'a. Akta Sintetis Nomor 1\nb. NIB Sintetis 2', penandatangan_nama: 'Penandatangan Sintetis', penandatangan_jabatan: 'Personalia',
      kota_penandatanganan: 'Bandung', pengadilan_negeri: 'Bandung', tempat_lahir: 'Bandung', tanggal_lahir: '5 Januari 1990', pendidikan: 'SMA/SMK',
      alamat_pekerja: 'Jl. Pekerja 2, Bandung', kontak_pekerja: '08123456', pengguna_jasa: 'Rekanan Sintetis', alamat_pengguna_jasa: 'Jl. Lokasi 3, Bandung',
      jenis_pekerjaan: 'Satpam', tanggal_mulai: '1 Maret 2026', tanggal_akhir: '31 Desember 2026', tanggal_cetak: '20 Februari 2026', nomor: 'PKWT/A/2026/0001',
    });
  });
  it('nama hukum jatuh ke nama biasa; kota jatuh ke kota perusahaan; data kosong TIDAK diisi (menjadi titik-titik)', () => {
    const n = susunNilaiTemplate({ perusahaan: { name: 'PT. B', legal_name: null, address: null, city: 'Jakarta', province: null, pkwt: null }, pekerja: { ...pekerja, birth_place: null, birth_date: null, phone: null }, kontrak, penempatan: null, tanggalCetakIso: '2026-02-20' });
    expect(n.perusahaan_hukum).toBe('PT. B');
    expect(n.kota_penandatanganan).toBe('Jakarta');
    expect(n.pengadilan_negeri).toBe('Jakarta');
    expect(n.perusahaan_alamat).toBe('Jakarta'); // hanya kota yang ada
    for (const k of ['perusahaan_legalitas', 'penandatangan_nama', 'tempat_lahir', 'tanggal_lahir', 'kontak_pekerja', 'pengguna_jasa', 'alamat_pengguna_jasa'] as const) expect(n[k]).toBeUndefined();
  });
  it('formatLegalitas: huruf a., b., ...; spasi dirapikan; kosong => undefined', () => {
    expect(formatLegalitas(['  Satu   butir ', 'Dua'])).toBe('a. Satu butir\nb. Dua');
    expect(formatLegalitas([])).toBeUndefined();
    expect(formatLegalitas(undefined)).toBeUndefined();
    expect(formatLegalitas(['   '])).toBeUndefined();
  });
});

describe('templat PKWT alih daya dari draf pemilik (docs/templates/pkwt-alih-daya/isi.txt)', () => {
  const isi = readFileSync(join(__dirname, '../../../../docs/templates/pkwt-alih-daya/isi.txt'), 'utf8');

  it('hanya memakai variabel daftar putih dan muat di batas 50.000 karakter basis data', () => {
    expect(variabelTidakDikenal(isi)).toEqual([]);
    expect(isi.length).toBeLessThanOrEqual(50000);
    expect(ekstrakVariabel(isi)).toEqual(expect.arrayContaining(['nomor', 'nama', 'nik', 'perusahaan_hukum', 'penandatangan_nama', 'perusahaan_legalitas', 'pengguna_jasa', 'tanggal_mulai']));
  });
  it('GENERIK: tidak memuat identitas perusahaan, orang, atau nomor legalitas tertentu (data itu milik pengaturan perusahaan)', () => {
    for (const terlarang of [/damarindo/i, /yuli/i, /eka wati/i, /9120202811565/, /udin narsudin/i, /jatiuwung/i, /Gatot Subroto/i, /C-23535/, /15134\.2021/, /0622\/PM/]) expect(isi).not.toMatch(terlarang);
  });
  it('dirender untuk dua perusahaan berbeda: nama/legalitas masing-masing, tanpa bocor antar perusahaan, tanpa variabel tersisa', () => {
    const a = isiTemplateLengkap(isi, susunNilaiTemplate({ perusahaan, pekerja, kontrak, penempatan: { rekanan: 'Rekanan Sintetis', alamat: 'Jl. Lokasi 3' }, tanggalCetakIso: '2026-02-20' }));
    const b = isiTemplateLengkap(isi, susunNilaiTemplate({ perusahaan: { name: 'PT. SINTETIS B', legal_name: null, address: null, city: null, province: null, pkwt: { legalitas: ['Akta B Sintetis'] } }, pekerja, kontrak, penempatan: null, tanggalCetakIso: '2026-02-20' }));
    expect(a.teks).toContain('PT. Sintetis Abadi');
    expect(a.teks).toContain('a. Akta Sintetis Nomor 1');
    expect(a.teks).toContain('PT. SINTETIS ABADI'); // blok tanda tangan huruf kapital
    expect(a.teks).not.toMatch(/\{\{|\}\}/);
    expect(a.isianTangan).toEqual([]);
    expect(b.teks).toContain('PT. SINTETIS B');
    expect(b.teks).toContain('a. Akta B Sintetis');
    expect(b.teks).not.toContain('Sintetis Abadi');
    expect(b.teks).not.toContain('Akta Sintetis Nomor 1');
    expect(b.isianTangan).toEqual(expect.arrayContaining(['penandatangan_nama', 'pengguna_jasa', 'alamat_pengguna_jasa', 'perusahaan_alamat']));
    expect(b.teks).toContain(TITIK_ISIAN);
  });
  it('klausul hukum tidak ada yang dikarang: kalimat kunci dari draf pemilik tetap utuh', () => {
    for (const k of ['PERJANJIAN KERJA WAKTU TERTENTU', 'PASAL 1', 'PASAL 9', 'KEDUA BELAH PIHAK sepakat untuk menunjuk domisili hukum', 'SURAT PERNYATAAN', 'Agama :']) expect(isi).toContain(k);
  });
});
