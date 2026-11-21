'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Galat, Halaman, Sukses } from '../../../components/ui';
import { ApiError, api } from '../../../lib/api';
import { formatTanggalIso } from '../../../lib/format';
import { useMember } from '../../../lib/member';

interface Lowongan { id: string; title: string; description: string; companyName: string; positions: number; closesOn: string | null }

export default function LowonganMember() {
  const { sesi, galat: galatSesi } = useMember();
  const [daftar, setDaftar] = useState<Lowongan[]>([]);
  const [kursor, setKursor] = useState<string | null>(null);
  const [galat, setGalat] = useState<string | null>(null);
  const [sukses, setSukses] = useState<string | null>(null);

  const muat = useCallback(async (lanjut?: string) => {
    try {
      const r = await api<{ items: Lowongan[]; nextCursor: string | null }>(`/member/vacancies?limit=20${lanjut ? `&cursor=${encodeURIComponent(lanjut)}` : ''}`);
      setDaftar((d) => (lanjut ? [...d, ...r.items] : r.items));
      setKursor(r.nextCursor);
    } catch (e) {
      setGalat((e as ApiError).message);
    }
  }, []);
  useEffect(() => {
    if (sesi) void muat();
  }, [sesi, muat]);

  async function lamar(l: Lowongan) {
    if (!sesi) return;
    setGalat(null);
    setSukses(null);
    try {
      await api('/member/applications', { method: 'POST', csrf: sesi.csrfToken, body: { vacancyId: l.id } });
      setSukses(`Lamaran untuk ${l.title} terkirim.`);
    } catch (e) {
      setGalat((e as ApiError).message); // backend menolak (mis. karyawan aktif) dengan pesan Indonesia
    }
  }

  return (
    <Halaman judul="Lowongan">
      <Galat pesan={galatSesi ?? galat} />
      <Sukses pesan={sukses} />
      {daftar.map((l) => (
        <article className="butir" key={l.id}>
          <h3>{l.title}</h3>
          <p className="bantuan">
            {l.companyName} · {l.positions} posisi{l.closesOn ? ` · batas ${formatTanggalIso(l.closesOn)}` : ''}
          </p>
          <p>{l.description}</p>
          <button className="tombol" type="button" onClick={() => lamar(l)}>
            Lamar {l.title}
          </button>
        </article>
      ))}
      {kursor ? (
        <button className="tombol-sekunder" type="button" onClick={() => muat(kursor)}>
          Muat lebih banyak
        </button>
      ) : null}
      {sesi && daftar.length === 0 && !galat ? <p className="bantuan">Belum ada lowongan yang dibuka.</p> : null}
      <Link className="tautan" href="/saya">
        Kembali
      </Link>
    </Halaman>
  );
}
