'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Galat, Halaman } from '../../components/ui';
import { ApiError, InfoSesi, ambilSesi, api } from '../../lib/api';

export default function BerandaStaff() {
  const router = useRouter();
  const [info, setInfo] = useState<InfoSesi | null>(null);
  const [galat, setGalat] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const s = await ambilSesi();
        if (!s) return router.replace('/staff/masuk');
        if (s.realm !== 'staff') return router.replace('/saya');
        if (s.state === 'MENUNGGU_ENROLL_MFA') return router.replace('/staff/daftar-mfa');
        if (s.state === 'MENUNGGU_MFA') return router.replace('/staff/masuk');
        setInfo(await api<InfoSesi>('/auth/me'));
      } catch (e) {
        setGalat((e as ApiError).message);
      }
    })();
  }, [router]);

  async function keluar() {
    if (!info) return;
    try {
      await api('/auth/logout', { method: 'POST', csrf: info.csrfToken });
      router.replace('/staff/masuk');
    } catch (e) {
      setGalat((e as ApiError).message);
    }
  }

  return (
    <Halaman judul="Beranda staff">
      <Galat pesan={galat} />
      {info ? (
        <>
          <div className="kartu">
            <p>
              Masuk sebagai <strong>{info.user.email}</strong>
            </p>
            <p>Peran: {info.roles && info.roles.length ? info.roles.join(', ') : 'belum ada peran'}</p>
            <p className="bantuan">Izin aktif: {info.permissions?.length ?? 0}. Akses perusahaan: {info.allCompanies ? 'seluruh perusahaan' : `${info.companyIds?.length ?? 0} perusahaan`}.</p>
          </div>
          <nav className="menu" aria-label="Menu utama">
            {info.permissions?.includes('company.view') ? (
              <Link className="tombol-sekunder" href="/staff/perusahaan">
                Perusahaan
              </Link>
            ) : null}
            {info.permissions?.includes('partner.view') ? (
              <Link className="tombol-sekunder" href="/staff/rekanan">
                Rekanan
              </Link>
            ) : null}
            {info.permissions?.includes('user_role.view') ? (
              <Link className="tombol-sekunder" href="/staff/persetujuan">
                Persetujuan
              </Link>
            ) : null}
          </nav>
          <p className="bantuan">Modul kepegawaian lainnya akan tersedia pada tahap berikutnya.</p>
          <button className="tombol-sekunder" type="button" onClick={keluar}>
            Keluar
          </button>
        </>
      ) : galat ? null : (
        <p role="status">Memuat…</p>
      )}
    </Halaman>
  );
}
