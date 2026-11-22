'use client';

import Link from 'next/link';
import { FormEvent, useEffect, useState } from 'react';
import { Galat, Halaman, Kolom, Lencana, Pilihan } from '../../../components/ui';
import { LABEL_FLAG, LABEL_STATUS_HARI } from '../../../lib/absensi';
import { ApiError, api } from '../../../lib/api';
import { formatTanggalIso } from '../../../lib/format';
import { useStaff } from '../../../lib/staff';

interface Baris { personId: string; workerName: string; shiftDate: string; locationName: string | null; masuk: string | null; pulang: string | null; status: string; flags: string[]; pendingVerification: number; corrected: boolean; adjustmentNo: string | null }

interface Titik { locationId: string; locationName: string }

/** Samakan dengan server (A-62): tanpa lokasi/pekerja maksimal 7 hari; dengan filter 93 hari. */
const HARI_TANPA_FILTER = 7;

export default function RekapAbsensi() {
  const { info, galat: galatSesi, punya } = useStaff();
  const [dari, setDari] = useState('');
  const [sampai, setSampai] = useState('');
  const [lokasi, setLokasi] = useState('');
  const [lokasiOpsi, setLokasiOpsi] = useState<{ nilai: string; teks: string }[]>([]);
  const [items, setItems] = useState<Baris[]>([]);
  const [kursor, setKursor] = useState<string | null>(null);
  const [galat, setGalat] = useState<string | null>(null);
  const [sudah, setSudah] = useState(false);

  // Daftar lokasi dari titik absensi yang dapat dilihat peran ini (izin attendance_point.view); bila tidak ada izin, rekap tanpa lokasi (maks 7 hari).
  useEffect(() => {
    if (!info) return;
    const peta = new Map<string, string>();
    (async () => {
      let kursorTitik: string | null = null;
      for (let i = 0; i < 5; i++) {
        const r: { items: Titik[]; nextCursor: string | null } = await api(`/attendance/points?limit=100${kursorTitik ? `&cursor=${encodeURIComponent(kursorTitik)}` : ''}`);
        for (const t of r.items) peta.set(t.locationId, t.locationName);
        kursorTitik = r.nextCursor;
        if (!kursorTitik) break;
      }
    })()
      .catch(() => undefined)
      .finally(() => setLokasiOpsi([...peta].map(([nilai, teks]) => ({ nilai, teks })).sort((a, b) => a.teks.localeCompare(b.teks))));
  }, [info]);

  const filter = lokasi ? `&locationId=${lokasi}` : '';
  const selisih = dari && sampai ? (Date.parse(sampai) - Date.parse(dari)) / 86400000 : 0;
  const terlaluLebar = !lokasi && selisih > HARI_TANPA_FILTER - 1;

  async function muat(lanjut?: string) {
    setGalat(null);
    try {
      const r = await api<{ items: Baris[]; nextCursor: string | null }>(`/attendance/recap?from=${dari}&to=${sampai}${filter}&limit=50${lanjut ? `&cursor=${encodeURIComponent(lanjut)}` : ''}`);
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
        <Pilihan id="lokasi" label="Lokasi kerja (opsional)" value={lokasi} onChange={setLokasi} opsi={lokasiOpsi} required={false} />
        <Kolom id="sampai" label="Sampai tanggal" type="date" value={sampai} onChange={setSampai} bantuan="Tanpa lokasi: rentang maksimal 7 hari. Dengan lokasi: maksimal 93 hari." />
        {terlaluLebar ? <p role="alert" className="bantuan">Pilih lokasi kerja atau persempit rentang menjadi 7 hari agar rekap dapat dimuat.</p> : null}
        <button className="tombol" type="submit" disabled={terlaluLebar}>
          Tampilkan rekap
        </button>
      </form>
      {punya('attendance_recap.export') && dari && sampai && !terlaluLebar ? (
        <a className="tombol-sekunder" href={`/api/attendance/recap/export.csv?from=${dari}&to=${sampai}${filter}`}>
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
