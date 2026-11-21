'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Galat, Halaman, Lencana } from '../../../components/ui';
import { ApiError, api } from '../../../lib/api';
import { useStaff } from '../../../lib/staff';

interface Lamaran { id: string; vacancyTitle: string; applicantName: string | null; status: string }

export default function LamaranStaff() {
  const { info, galat: galatSesi, punya } = useStaff();
  const [daftar, setDaftar] = useState<Lamaran[]>([]);
  const [kursor, setKursor] = useState<string | null>(null);
  const [galat, setGalat] = useState<string | null>(null);

  const muat = useCallback(async (lanjut?: string) => {
    const vacancyId = new URLSearchParams(window.location.search).get('vacancyId');
    try {
      const r = await api<{ items: Lamaran[]; nextCursor: string | null }>(`/applications?limit=20${vacancyId ? `&vacancyId=${encodeURIComponent(vacancyId)}` : ''}${lanjut ? `&cursor=${encodeURIComponent(lanjut)}` : ''}`);
      setDaftar((d) => (lanjut ? [...d, ...r.items] : r.items));
      setKursor(r.nextCursor);
    } catch (e) {
      setGalat((e as ApiError).message);
    }
  }, []);
  useEffect(() => {
    if (info && punya('vacancy_application.view')) void muat();
  }, [info]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Halaman judul="Lamaran">
      <Galat pesan={galatSesi ?? galat} />
      {info && !punya('vacancy_application.view') ? <Galat pesan="Anda tidak memiliki izin untuk melihat lamaran." /> : null}
      {daftar.map((l) => (
        <article className="butir" key={l.id}>
          <h3>{l.applicantName ?? 'Pelamar'}</h3>
          <p>
            {l.vacancyTitle} <Lencana status={l.status} />
          </p>
          <Link className="tautan" href={`/staff/lamaran/${l.id}`}>
            Proses lamaran {l.applicantName ?? 'pelamar'}
          </Link>
        </article>
      ))}
      {kursor ? (
        <button className="tombol-sekunder" type="button" onClick={() => muat(kursor)}>
          Muat lebih banyak
        </button>
      ) : null}
      {info && punya('vacancy_application.view') && daftar.length === 0 && !galat ? <p className="bantuan">Belum ada lamaran.</p> : null}
      <Link className="tautan" href="/staff">
        Kembali ke beranda
      </Link>
    </Halaman>
  );
}
