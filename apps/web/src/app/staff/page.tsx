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
            {info.permissions?.includes('member.view') ? (
              <Link className="tombol-sekunder" href="/staff/anggota">
                Database member
              </Link>
            ) : null}
            {info.permissions?.includes('vacancy_application.view') ? (
              <>
                <Link className="tombol-sekunder" href="/staff/lowongan">
                  Lowongan
                </Link>
                <Link className="tombol-sekunder" href="/staff/lamaran">
                  Lamaran
                </Link>
              </>
            ) : null}
            {info.permissions?.includes('pkwt.view') ? (
              <>
                <Link className="tombol-sekunder" href="/staff/pkwt">
                  Kontrak PKWT
                </Link>
                <Link className="tombol-sekunder" href="/staff/template-pkwt">
                  Template PKWT
                </Link>
              </>
            ) : null}
            {info.permissions?.includes('placement.view') ? (
              <>
                <Link className="tombol-sekunder" href="/staff/penempatan">
                  Penempatan
                </Link>
                <Link className="tombol-sekunder" href="/staff/karyawan">
                  Karyawan aktif
                </Link>
              </>
            ) : null}
            {['attendance_point.view', 'attendance_point.create', 'attendance_point.update', 'attendance_point.export'].some((i) => info.permissions?.includes(i)) ? (
              <Link className="tombol-sekunder" href="/staff/titik-absensi">
                Titik absensi (QR)
              </Link>
            ) : null}
            {info.permissions?.includes('placement.view') ? (
              <Link className="tombol-sekunder" href="/staff/jadwal">
                Shift dan jadwal
              </Link>
            ) : null}
            {['attendance_anomaly.view', 'attendance_anomaly.review', 'attendance_anomaly.approve'].some((i) => info.permissions?.includes(i)) ? (
              <Link className="tombol-sekunder" href="/staff/tinjauan-absensi">
                Tinjauan absensi
              </Link>
            ) : null}
            {['attendance_adjustment.view', 'attendance_adjustment.create', 'attendance_adjustment.update', 'attendance_adjustment.approve'].some((i) => info.permissions?.includes(i)) ? (
              <Link className="tombol-sekunder" href="/staff/koreksi-absensi">
                Koreksi absensi
              </Link>
            ) : null}
            {info.permissions?.includes('attendance_recap.view') ? (
              <Link className="tombol-sekunder" href="/staff/rekap-absensi">
                Rekap absensi
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
