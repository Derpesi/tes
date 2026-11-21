'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Galat, Halaman, Lencana, Sukses } from '../../../components/ui';
import { ApiError, api } from '../../../lib/api';
import { useMember } from '../../../lib/member';

interface Lamaran { id: string; status: string; vacancyTitle: string; companyName: string }
const AKTIF = ['DIAJUKAN', 'SELEKSI_ADMINISTRASI', 'INTERVIEW'];

export default function LamaranMember() {
  const { sesi, galat: galatSesi } = useMember();
  const [daftar, setDaftar] = useState<Lamaran[]>([]);
  const [galat, setGalat] = useState<string | null>(null);
  const [sukses, setSukses] = useState<string | null>(null);

  const muat = useCallback(async () => {
    try {
      setDaftar((await api<{ items: Lamaran[] }>('/member/applications?limit=50')).items);
    } catch (e) {
      setGalat((e as ApiError).message);
    }
  }, []);
  useEffect(() => {
    if (sesi) void muat();
  }, [sesi, muat]);

  async function tarik(l: Lamaran) {
    if (!sesi) return;
    setGalat(null);
    setSukses(null);
    try {
      await api(`/member/applications/${l.id}/withdraw`, { method: 'POST', csrf: sesi.csrfToken, body: {} });
      await muat();
      setSukses('Lamaran ditarik.');
    } catch (e) {
      setGalat((e as ApiError).message);
    }
  }

  return (
    <Halaman judul="Lamaran saya">
      <Galat pesan={galatSesi ?? galat} />
      <Sukses pesan={sukses} />
      {daftar.map((l) => (
        <article className="butir" key={l.id}>
          <h3>{l.vacancyTitle}</h3>
          <p>
            {l.companyName} <Lencana status={l.status} />
          </p>
          {AKTIF.includes(l.status) ? (
            <button className="tombol-sekunder" type="button" onClick={() => tarik(l)}>
              Tarik lamaran {l.vacancyTitle}
            </button>
          ) : null}
        </article>
      ))}
      {sesi && daftar.length === 0 && !galat ? <p className="bantuan">Anda belum melamar lowongan apa pun.</p> : null}
      <Link className="tautan" href="/saya">
        Kembali
      </Link>
    </Halaman>
  );
}
