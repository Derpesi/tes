'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Galat, Halaman } from '../../components/ui';
import { ApiError, InfoSesi, ambilSesi, api } from '../../lib/api';

export default function Saya() {
  const router = useRouter();
  const [sesi, setSesi] = useState<InfoSesi | null>(null);
  const [galat, setGalat] = useState<string | null>(null);

  useEffect(() => {
    ambilSesi()
      .then((s) => (s ? setSesi(s) : router.replace('/masuk')))
      .catch((e: ApiError) => setGalat(e.message));
  }, [router]);

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
      <Galat pesan={galat} />
      {sesi ? (
        sesi.realm === 'member' ? (
          <>
            <p>
              Anda masuk sebagai <strong>{sesi.user.email}</strong>.
            </p>
            <p className="bantuan">Biodata, lowongan, dan absensi akan tersedia pada tahap berikutnya.</p>
            <button className="tombol-sekunder" type="button" onClick={keluar}>
              Keluar
            </button>
          </>
        ) : (
          <p>Halaman ini khusus member. Gunakan halaman staff.</p>
        )
      ) : galat ? null : (
        <p role="status">Memuat…</p>
      )}
    </Halaman>
  );
}
