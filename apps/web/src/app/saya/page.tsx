'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Galat, Halaman } from '../../components/ui';
import { ApiError, api } from '../../lib/api';
import { LABEL_STATUS_MEMBER, useMember } from '../../lib/member';

interface Profil { status: string; fullName: string | null; reviewNote: string | null }
interface Kelayakan { bisaMelamar: boolean; kode?: string; pesan?: string }

export default function Saya() {
  const router = useRouter();
  const { sesi, galat: galatSesi } = useMember();
  const [profil, setProfil] = useState<Profil | null>(null);
  const [layak, setLayak] = useState<Kelayakan | null>(null);
  const [galat, setGalat] = useState<string | null>(null);

  useEffect(() => {
    if (!sesi) return;
    Promise.all([api<Profil>('/member/profile'), api<Kelayakan>('/member/eligibility')])
      .then(([p, k]) => {
        setProfil(p);
        setLayak(k);
      })
      .catch((e: ApiError) => setGalat(e.message));
  }, [sesi]);

  async function keluar() {
    if (!sesi) return;
    try {
      await api('/auth/logout', { method: 'POST', csrf: sesi.csrfToken });
      router.replace('/masuk');
    } catch (e) {
      setGalat((e as ApiError).message);
    }
  }

  return (
    <Halaman judul="Akun member">
      <Galat pesan={galatSesi ?? galat} />
      {sesi && profil && layak ? (
        <>
          <div className="kartu">
            <p>
              Masuk sebagai <strong>{sesi.user.email}</strong>
            </p>
            <p>
              Status: <strong>{LABEL_STATUS_MEMBER[profil.status] ?? profil.status}</strong>
            </p>
            {profil.status === 'PROFIL_BELUM_LENGKAP' && profil.reviewNote ? (
              <div className="galat" role="alert">
                Catatan HRD: {profil.reviewNote}
              </div>
            ) : null}
            {!layak.bisaMelamar && layak.pesan ? <p className="bantuan">{layak.pesan}</p> : null}
          </div>
          <nav className="menu" aria-label="Menu member">
            <Link className="tombol-sekunder" href="/saya/biodata">
              Biodata dan dokumen
            </Link>
            {layak.bisaMelamar ? (
              <Link className="tombol-sekunder" href="/saya/lowongan">
                Lowongan
              </Link>
            ) : null}
            <Link className="tombol-sekunder" href="/saya/lamaran">
              Lamaran saya
            </Link>
          </nav>
          <button className="tombol-sekunder" type="button" onClick={keluar}>
            Keluar
          </button>
        </>
      ) : galat || galatSesi ? null : (
        <p role="status">Memuat…</p>
      )}
    </Halaman>
  );
}
