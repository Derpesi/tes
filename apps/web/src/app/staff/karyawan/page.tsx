'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Galat, Halaman, Lencana, Pilihan } from '../../../components/ui';
import { ApiError, api } from '../../../lib/api';
import { formatTanggalIso } from '../../../lib/format';
import { useStaff } from '../../../lib/staff';

interface Karyawan { placementId: string; workerName: string | null; position: string; locationName: string; contractNumber: string; contractEndDate: string; daysLeft: number; placementStatus: string }
interface Ringkasan { active: number; suspended: number; expiringWithin30Days: number }

export default function KaryawanStaff() {
  const { info, galat: galatSesi, punya } = useStaff();
  const [daftar, setDaftar] = useState<Karyawan[]>([]);
  const [kursor, setKursor] = useState<string | null>(null);
  const [ringkas, setRingkas] = useState<Ringkasan | null>(null);
  const [filter, setFilter] = useState('');
  const [galat, setGalat] = useState<string | null>(null);

  const muat = useCallback(async (f: string, lanjut?: string) => {
    try {
      const r = await api<{ items: Karyawan[]; nextCursor: string | null }>(`/employees?limit=20${f ? '&akanBerakhir=true' : ''}${lanjut ? `&cursor=${encodeURIComponent(lanjut)}` : ''}`);
      setDaftar((d) => (lanjut ? [...d, ...r.items] : r.items));
      setKursor(r.nextCursor);
    } catch (e) {
      setGalat((e as ApiError).message);
    }
  }, []);
  useEffect(() => {
    if (!info || !punya('placement.view')) return;
    void muat(filter);
    api<Ringkasan>('/employees/summary').then(setRingkas, () => undefined);
  }, [info, filter]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Halaman judul="Karyawan aktif">
      <Galat pesan={galatSesi ?? galat} />
      {info && !punya('placement.view') ? <Galat pesan="Anda tidak memiliki izin untuk melihat karyawan aktif." /> : null}
      {ringkas ? (
        <div className="angka" aria-label="Ringkasan karyawan">
          <div className="butir">
            <strong>{ringkas.active}</strong>Aktif
          </div>
          <div className="butir">
            <strong>{ringkas.suspended}</strong>Ditangguhkan
          </div>
          <div className="butir">
            <strong>{ringkas.expiringWithin30Days}</strong>Kontrak berakhir ≤ 30 hari
          </div>
        </div>
      ) : null}
      <Pilihan id="filter" label="Tampilkan" value={filter} onChange={setFilter} required={false} opsi={[{ nilai: 'akan', teks: 'Kontrak akan berakhir (≤ 30 hari)' }]} />
      {daftar.map((k) => (
        <article className="butir" key={k.placementId}>
          <h3>{k.workerName ?? 'Pekerja'}</h3>
          <p>
            {k.position} · {k.locationName} <Lencana status={k.placementStatus} />
          </p>
          <p className="bantuan">
            {k.contractNumber} · berakhir {formatTanggalIso(k.contractEndDate)} ({k.daysLeft} hari lagi)
          </p>
        </article>
      ))}
      {kursor ? (
        <button className="tombol-sekunder" type="button" onClick={() => muat(filter, kursor)}>
          Muat lebih banyak
        </button>
      ) : null}
      {info && punya('placement.view') && daftar.length === 0 && !galat ? <p className="bantuan">Tidak ada karyawan pada filter ini.</p> : null}
      <Link className="tautan" href="/staff">
        Kembali ke beranda
      </Link>
    </Halaman>
  );
}
