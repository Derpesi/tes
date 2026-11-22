'use client';

import Link from 'next/link';
import { FormEvent, useState } from 'react';
import { Galat, Halaman, Kolom, Pilihan } from '../../../components/ui';
import { ApiError, api } from '../../../lib/api';
import { useStaff } from '../../../lib/staff';

interface Baris { companyId: string | null; companyName: string; location: string | null; measure: string; value: string | number }
interface Laporan { from: string; to: string; sections: Record<string, Baris[]> }

const NAMA_LAPORAN = [
  { nilai: 'workforce', teks: 'Ketenagakerjaan' },
  { nilai: 'recruitment', teks: 'Rekrutmen' },
  { nilai: 'attendance', teks: 'Absensi' },
  { nilai: 'payroll', teks: 'Rekap payroll (subtotal rekap disetujui)' },
];
const JUDUL_BAGIAN: Record<string, string> = {
  karyawan: 'Karyawan aktif', kontrak: 'Kontrak PKWT', statusMember: 'Status member (seluruh Group)', lowongan: 'Lowongan', lamaran: 'Lamaran', absensi: 'Absensi per lokasi',
  penandaAnomali: 'Penanda anomali teratas', rekanan: 'Payroll rekanan', internal: 'Payroll internal',
};

export default function LaporanKonsolidasi() {
  const { info, galat: galatSesi, punya } = useStaff();
  const [f, setF] = useState({ nama: 'workforce', dari: '', sampai: '' });
  const [hasil, setHasil] = useState<Laporan | null>(null);
  const [galat, setGalat] = useState<string | null>(null);

  async function tampil(e: FormEvent) {
    e.preventDefault();
    setGalat(null);
    try {
      setHasil(await api<Laporan>(`/reports/${f.nama}?from=${f.dari}&to=${f.sampai}`));
    } catch (err) {
      setHasil(null);
      setGalat((err as ApiError).message);
    }
  }

  const bagian = hasil ? Object.entries(hasil.sections) : [];
  return (
    <Halaman judul="Laporan konsolidasi">
      <Galat pesan={galatSesi ?? galat} />
      {info && !punya('report_consolidated.view') ? <Galat pesan="Anda tidak memiliki izin untuk melihat laporan konsolidasi." /> : null}
      <p className="bantuan">Laporan agregat per perusahaan dalam scope Anda, tanpa data pribadi. Setiap bagian hanya tampil bila Anda berhak atas datanya. Rentang maksimal 366 hari.</p>
      <form onSubmit={tampil}>
        <Pilihan id="laporan" label="Laporan" value={f.nama} onChange={(v) => setF({ ...f, nama: v })} opsi={NAMA_LAPORAN} />
        <Kolom id="dari" label="Dari tanggal" type="date" value={f.dari} onChange={(v) => setF({ ...f, dari: v })} />
        <Kolom id="sampai" label="Sampai tanggal" type="date" value={f.sampai} onChange={(v) => setF({ ...f, sampai: v })} />
        <button className="tombol" type="submit">
          Tampilkan laporan
        </button>
      </form>
      {hasil && punya('report_consolidated.export') ? (
        <a className="tombol-sekunder" href={`/api/reports/${f.nama}/export.csv?from=${f.dari}&to=${f.sampai}`}>
          Ekspor CSV
        </a>
      ) : null}
      {hasil && bagian.length === 0 ? <p>Tidak ada bagian laporan yang dapat Anda lihat untuk laporan ini.</p> : null}
      {bagian.map(([nama, rows]) => (
        <section className="kartu" key={nama} aria-labelledby={`b-${nama}`}>
          <h3 id={`b-${nama}`}>{JUDUL_BAGIAN[nama] ?? nama}</h3>
          {rows.length === 0 ? <p className="bantuan">Tidak ada data pada rentang ini.</p> : null}
          {rows.map((b, i) => (
            <div className="komponen" key={`${nama}-${i}`}>
              <span>
                {b.companyName}
                {b.location ? ` · ${b.location}` : ''} — {b.measure}
              </span>
              <strong>{b.value}</strong>
            </div>
          ))}
        </section>
      ))}
      <Link className="tombol-sekunder" href="/staff">
        Kembali
      </Link>
    </Halaman>
  );
}
