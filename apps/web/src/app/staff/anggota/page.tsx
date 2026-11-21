'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Galat, Halaman, Pilihan } from '../../../components/ui';
import { ApiError, api } from '../../../lib/api';
import { LABEL_STATUS_MEMBER } from '../../../lib/member';
import { useStaff } from '../../../lib/staff';

interface Anggota { id: string; fullName: string | null; nik: string | null; city: string | null; status: string }

export default function AnggotaStaff() {
  const { info, galat: galatSesi, punya } = useStaff();
  const [daftar, setDaftar] = useState<Anggota[]>([]);
  const [kursor, setKursor] = useState<string | null>(null);
  const [status, setStatus] = useState('MENUNGGU_VERIFIKASI');
  const [galat, setGalat] = useState<string | null>(null);

  const muat = useCallback(async (st: string, lanjut?: string) => {
    try {
      const r = await api<{ items: Anggota[]; nextCursor: string | null }>(`/members?limit=20${st ? `&status=${st}` : ''}${lanjut ? `&cursor=${encodeURIComponent(lanjut)}` : ''}`);
      setDaftar((d) => (lanjut ? [...d, ...r.items] : r.items));
      setKursor(r.nextCursor);
    } catch (e) {
      setGalat((e as ApiError).message);
    }
  }, []);
  useEffect(() => {
    if (info && punya('member.view')) void muat(status);
  }, [info, status]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Halaman judul="Database member">
      <Galat pesan={galatSesi ?? galat} />
      {info && !punya('member.view') ? <Galat pesan="Anda tidak memiliki izin untuk melihat database member." /> : null}
      <Pilihan id="status" label="Filter status" value={status} onChange={setStatus} required={false} opsi={Object.entries(LABEL_STATUS_MEMBER).map(([nilai, teks]) => ({ nilai, teks }))} />
      {daftar.map((m) => (
        <article className="butir" key={m.id}>
          <h3>{m.fullName ?? 'Nama belum diisi'}</h3>
          <p className="bantuan">
            NIK {m.nik ?? '-'} · {m.city ?? 'Kota belum diisi'}
          </p>
          <p>{LABEL_STATUS_MEMBER[m.status] ?? m.status}</p>
          <Link className="tautan" href={`/staff/anggota/${m.id}`}>
            Buka {m.fullName ?? 'member'}
          </Link>
        </article>
      ))}
      {kursor ? (
        <button className="tombol-sekunder" type="button" onClick={() => muat(status, kursor)}>
          Muat lebih banyak
        </button>
      ) : null}
      {info && punya('member.view') && daftar.length === 0 && !galat ? <p className="bantuan">Tidak ada member pada status ini.</p> : null}
      <Link className="tautan" href="/staff">
        Kembali ke beranda
      </Link>
    </Halaman>
  );
}
