'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Galat, Halaman, Lencana } from '../../../components/ui';
import { LABEL_FLAG, LABEL_JENIS_ABSEN, LABEL_STATUS_ABSEN, formatWaktuWib } from '../../../lib/absensi';
import { ApiError, api } from '../../../lib/api';
import { formatTanggalIso } from '../../../lib/format';
import { useMember } from '../../../lib/member';

interface Rekaman { id: string; kind: string; status: string; message: string; shiftDate: string; occurredAt: string; locationName: string | null; flags: string[] }

export default function RiwayatAbsensi() {
  const { sesi, galat: galatSesi } = useMember();
  const [items, setItems] = useState<Rekaman[]>([]);
  const [kursor, setKursor] = useState<string | null>(null);
  const [galat, setGalat] = useState<string | null>(null);
  const [selesai, setSelesai] = useState(false);

  const muat = useCallback(async (lanjut?: string) => {
    try {
      const r = await api<{ items: Rekaman[]; nextCursor: string | null }>(`/member/attendance?limit=20${lanjut ? `&cursor=${encodeURIComponent(lanjut)}` : ''}`);
      setItems((d) => (lanjut ? [...d, ...r.items] : r.items));
      setKursor(r.nextCursor);
      setSelesai(true);
    } catch (e) {
      setGalat((e as ApiError).message);
    }
  }, []);
  useEffect(() => {
    if (sesi) void muat();
  }, [sesi, muat]);

  return (
    <Halaman judul="Riwayat absensi">
      <Galat pesan={galatSesi ?? galat} />
      <p className="bantuan">Untuk absen, pindai QR di lokasi kerja dengan kamera ponsel. Absen yang gagal karena tidak ada koneksi dapat dikoreksi oleh petugas absensi.</p>
      {selesai && items.length === 0 ? <p>Belum ada absensi.</p> : null}
      {items.map((r) => (
        <div className="butir" key={r.id}>
          <h3>
            {LABEL_JENIS_ABSEN[r.kind] ?? r.kind} · {formatTanggalIso(r.shiftDate)}
          </h3>
          <p>
            <Lencana status={r.status} /> {LABEL_STATUS_ABSEN[r.status] ?? r.status}
          </p>
          <p className="bantuan">
            {formatWaktuWib(r.occurredAt)}
            {r.locationName ? ` · ${r.locationName}` : ''}
          </p>
          {r.flags.length ? <p className="bantuan">Catatan: {r.flags.map((f) => LABEL_FLAG[f] ?? f).join(', ')}</p> : null}
        </div>
      ))}
      {kursor ? (
        <button className="tombol-sekunder" type="button" onClick={() => void muat(kursor)}>
          Muat lebih banyak
        </button>
      ) : null}
      <Link className="tombol-sekunder" href="/saya">
        Kembali
      </Link>
    </Halaman>
  );
}
