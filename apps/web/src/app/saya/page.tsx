'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Galat, Halaman } from '../../components/ui';
import { formatTanggalIso } from '../../lib/format';
import { ApiError, api } from '../../lib/api';
import { LABEL_STATUS_MEMBER, useMember } from '../../lib/member';

interface Profil { status: string; fullName: string | null; reviewNote: string | null }
interface Kelayakan { bisaMelamar: boolean; kode?: string; pesan?: string }
interface Dashboard { contract: { number: string; position: string; startDate: string; endDate: string; status: string; daysLeft: number | null } | null; placement: { status: string; locationName: string; locationCity: string | null; startDate: string; endDate: string | null } | null }

export default function Saya() {
  const router = useRouter();
  const { sesi, galat: galatSesi } = useMember();
  const [profil, setProfil] = useState<Profil | null>(null);
  const [layak, setLayak] = useState<Kelayakan | null>(null);
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [galat, setGalat] = useState<string | null>(null);

  useEffect(() => {
    if (!sesi) return;
    Promise.all([api<Profil>('/member/profile'), api<Kelayakan>('/member/eligibility'), api<Dashboard>('/member/dashboard')])
      .then(([p, k, d]) => {
        setProfil(p);
        setLayak(k);
        setDash(d);
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
          {dash?.contract ? (
            <div className="kartu" aria-label="Kontrak kerja">
              <p>
                <strong>Kontrak {dash.contract.number}</strong> ({dash.contract.status === 'AKTIF' ? 'aktif' : dash.contract.status === 'DITANDATANGANI' ? 'ditandatangani' : 'berakhir'})
              </p>
              <p className="bantuan">
                {dash.contract.position} · {formatTanggalIso(dash.contract.startDate)} – {formatTanggalIso(dash.contract.endDate)}
                {dash.contract.daysLeft !== null ? ` · ${dash.contract.daysLeft} hari lagi` : ''}
              </p>
              {dash.placement ? (
                <p className="bantuan">
                  Lokasi kerja: {dash.placement.locationName}
                  {dash.placement.locationCity ? `, ${dash.placement.locationCity}` : ''}
                </p>
              ) : null}
            </div>
          ) : null}
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
            {profil.status === 'KARYAWAN_AKTIF' || profil.status === 'KONTRAK_AKAN_BERAKHIR' ? (
              <Link className="tombol-sekunder" href="/saya/absensi">
                Riwayat absensi
              </Link>
            ) : null}
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
