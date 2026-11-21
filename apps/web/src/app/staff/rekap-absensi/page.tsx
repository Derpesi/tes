'use client';

import Link from 'next/link';
import { FormEvent, useState } from 'react';
import { Galat, Halaman, Kolom, Lencana } from '../../../components/ui';
import { LABEL_FLAG, LABEL_STATUS_HARI } from '../../../lib/absensi';
import { ApiError, api } from '../../../lib/api';
import { formatTanggalIso } from '../../../lib/format';
import { useStaff } from '../../../lib/staff';

interface Baris { personId: string; workerName: string; shiftDate: string; locationName: string | null; masuk: string | null; pulang: string | null; status: string; flags: string[]; pendingVerification: number; corrected: boolean; adjustmentNo: string | null }

export default function RekapAbsensi() {
  const { info, galat: galatSesi, punya } = useStaff();
  const [dari, setDari] = useState('');
  const [sampai, setSampai] = useState('');
  const [items, setItems] = useState<Baris[]>([]);
  const [kursor, setKursor] = useState<string | null>(null);
  const [galat, setGalat] = useState<string | null>(null);
  const [sudah, setSudah] = useState(false);

  async function muat(lanjut?: string) {
    setGalat(null);
    try {
      const r = await api<{ items: Baris[]; nextCursor: string | null }>(`/attendance/recap?from=${dari}&to=${sampai}&limit=50${lanjut ? `&cursor=${encodeURIComponent(lanjut)}` : ''}`);
      setItems((d) => (lanjut ? [...d, ...r.items] : r.items));
      setKursor(r.nextCursor);
      setSudah(true);
    } catch (e) {
      setGalat((e as ApiError).message);
    }
  }
  function cari(e: FormEvent) {
    e.preventDefault();
    void muat();
  }

  return (
    <Halaman judul="Rekap absensi">
      <Galat pesan={galatSesi ?? galat} />
      {info && !punya('attendance_recap.view') ? <Galat pesan="Anda tidak memiliki izin untuk melihat rekap absensi." /> : null}
      <p className="bantuan">Rekap per orang-hari dari rekaman efektif (putusan tinjauan dan koreksi disetujui). Hari tanpa absen belum ditampilkan. Ini bukan perhitungan gaji.</p>
      <form onSubmit={cari}>
        <Kolom id="dari" label="Dari tanggal" type="date" value={dari} onChange={setDari} />
        <Kolom id="sampai" label="Sampai tanggal" type="date" value={sampai} onChange={setSampai} bantuan="Rentang maksimal 93 hari." />
        <button className="tombol" type="submit">
          Tampilkan rekap
        </button>
      </form>
      {punya('attendance_recap.export') && dari && sampai ? (
        <a className="tombol-sekunder" href={`/api/attendance/recap/export.csv?from=${dari}&to=${sampai}`}>
          Ekspor CSV
        </a>
      ) : null}
      {sudah && items.length === 0 ? <p>Tidak ada data pada rentang ini.</p> : null}
      {items.map((x) => (
        <div className="butir" key={`${x.personId}-${x.shiftDate}`}>
          <h3>{x.workerName}</h3>
          <p>
            {formatTanggalIso(x.shiftDate)} · {x.locationName ?? '-'}
          </p>
          <p>
            <Lencana status={x.status} /> {LABEL_STATUS_HARI[x.status] ?? x.status}
            {x.corrected ? ` · dikoreksi (${x.adjustmentNo})` : ''}
          </p>
          <p className="bantuan">
            Masuk {x.masuk ?? '-'} · Pulang {x.pulang ?? '-'} WIB
            {x.flags.length ? ` · ${x.flags.map((f) => LABEL_FLAG[f] ?? f).join(', ')}` : ''}
            {x.pendingVerification ? ` · ${x.pendingVerification} menunggu verifikasi` : ''}
          </p>
          {punya('attendance_adjustment.create') ? (
            <Link className="tombol-sekunder" href={`/staff/koreksi-absensi?personId=${x.personId}&shiftDate=${x.shiftDate}&nama=${encodeURIComponent(x.workerName)}`}>
              Ajukan koreksi
            </Link>
          ) : null}
        </div>
      ))}
      {kursor ? (
        <button className="tombol-sekunder" type="button" onClick={() => void muat(kursor)}>
          Muat lebih banyak
        </button>
      ) : null}
      <Link className="tombol-sekunder" href="/staff">
        Kembali
      </Link>
    </Halaman>
  );
}
