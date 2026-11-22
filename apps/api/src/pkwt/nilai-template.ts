import { tanggalPanjang } from './pdf';
import type { NamaVariabel } from './variabel';

/** Pengaturan PKWT per perusahaan (companies.document_settings.pkwt). Semua opsional; yang kosong menjadi isian tangan. */
export interface PengaturanPkwt {
  penandatanganNama?: string;
  penandatanganJabatan?: string;
  kota?: string;
  pengadilanNegeri?: string;
  legalitas?: string[];
}

export interface DataPerusahaan {
  name: string;
  legal_name: string | null;
  address: string | null;
  city: string | null;
  province: string | null;
  pkwt?: PengaturanPkwt | null;
}
export interface DataPekerja {
  full_name: string;
  nik: string;
  birth_place: string | null;
  birth_date: string | null;
  education: string | null;
  address: string | null;
  city: string | null;
  phone: string | null;
}
export interface DataKontrak {
  contract_number: string;
  position: string;
  start_date: string;
  end_date: string;
}
export interface DataPenempatan {
  /** Nama rekanan (perusahaan pengguna jasa) dan alamat lokasi, dari lowongan → lokasi. */
  rekanan: string | null;
  alamat: string | null;
}

const huruf = (i: number) => String.fromCharCode(97 + i);
const bersih = (v: string | null | undefined) => (v ?? '').replace(/\s+/g, ' ').trim();
const gabung = (...p: (string | null | undefined)[]) => p.map(bersih).filter(Boolean).join(', ');

/** Daftar legalitas bernomor huruf (a., b., ...), satu butir per baris. Kosong => tidak ada nilai (jatuh ke titik-titik). */
export function formatLegalitas(butir: string[] | undefined): string | undefined {
  const b = (butir ?? []).map(bersih).filter(Boolean);
  return b.length ? b.map((x, i) => `${huruf(i)}. ${x}`).join('\n') : undefined;
}

/**
 * Menyusun nilai variabel templat dari data master/biodata/kontrak. Fungsi murni (tanpa DB). Nilai yang tidak tersedia tidak diisi
 * (jatuh ke titik-titik untuk variabel isian-tangan). Tidak membawa teks hukum apa pun.
 */
export function susunNilaiTemplate(p: { perusahaan: DataPerusahaan; pekerja: DataPekerja; kontrak: DataKontrak; penempatan?: DataPenempatan | null; tanggalCetakIso: string }): Partial<Record<NamaVariabel, string>> {
  const { perusahaan: c, pekerja, kontrak: k, penempatan } = p;
  const pk = c.pkwt ?? {};
  const namaHukum = bersih(c.legal_name) || bersih(c.name);
  const nilai: Partial<Record<NamaVariabel, string>> = {
    nama: pekerja.full_name,
    nik: pekerja.nik,
    nomor: k.contract_number,
    jabatan: k.position,
    jenis_pekerjaan: k.position,
    tanggal_mulai: tanggalPanjang(k.start_date),
    tanggal_akhir: tanggalPanjang(k.end_date),
    perusahaan: c.name,
    tanggal_cetak: tanggalPanjang(p.tanggalCetakIso),
    perusahaan_hukum: namaHukum,
    perusahaan_hukum_kapital: namaHukum.toLocaleUpperCase('id-ID'),
    perusahaan_alamat: gabung(c.address, c.city, c.province),
    perusahaan_legalitas: formatLegalitas(pk.legalitas),
    penandatangan_nama: bersih(pk.penandatanganNama),
    penandatangan_jabatan: bersih(pk.penandatanganJabatan),
    kota_penandatanganan: bersih(pk.kota) || bersih(c.city),
    pengadilan_negeri: bersih(pk.pengadilanNegeri) || bersih(pk.kota) || bersih(c.city),
    tempat_lahir: bersih(pekerja.birth_place),
    tanggal_lahir: pekerja.birth_date ? tanggalPanjang(pekerja.birth_date) : '',
    pendidikan: bersih(pekerja.education),
    alamat_pekerja: gabung(pekerja.address, pekerja.city),
    kontak_pekerja: bersih(pekerja.phone),
    pengguna_jasa: bersih(penempatan?.rekanan),
    alamat_pengguna_jasa: bersih(penempatan?.alamat),
  };
  for (const key of Object.keys(nilai) as NamaVariabel[]) if ((nilai[key] ?? '') === '') delete nilai[key];
  return nilai;
}
