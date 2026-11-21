'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Galat, Halaman, Sukses } from '../../../components/ui';
import { ApiError, api } from '../../../lib/api';
import { useStaff } from '../../../lib/staff';

interface Permintaan { id: string; type: string; requestedBy: { email: string }; subject: { email?: string; name?: string } | null; expiresAt: string }
const JENIS: Record<string, string> = {
  BERI_PERAN_TINGGI: 'Pemberian peran berhak tinggi',
  RESET_MFA: 'Reset verifikasi dua langkah',
  BERI_AKSES_SEMUA_PERUSAHAAN: 'Akses seluruh perusahaan',
  AKTIVASI_PERUSAHAAN: 'Aktivasi perusahaan baru',
};

export default function PersetujuanStaff() {
  const { info, galat: galatSesi, punya } = useStaff();
  const [daftar, setDaftar] = useState<Permintaan[]>([]);
  const [galat, setGalat] = useState<string | null>(null);
  const [sukses, setSukses] = useState<string | null>(null);

  const muat = useCallback(async () => {
    try {
      setDaftar(await api<Permintaan[]>('/approvals?status=MENUNGGU'));
    } catch (e) {
      setGalat((e as ApiError).message);
    }
  }, []);
  useEffect(() => {
    if (info && punya('user_role.view')) void muat();
  }, [info]); // eslint-disable-line react-hooks/exhaustive-deps

  async function putuskan(id: string, setuju: boolean) {
    if (!info) return;
    setGalat(null);
    setSukses(null);
    try {
      await api(`/approvals/${id}/${setuju ? 'approve' : 'reject'}`, { method: 'POST', csrf: info.csrfToken, body: {} });
      await muat();
      setSukses(setuju ? 'Permintaan disetujui.' : 'Permintaan ditolak.');
    } catch (e) {
      setGalat((e as ApiError).message);
    }
  }

  return (
    <Halaman judul="Persetujuan">
      <Galat pesan={galatSesi ?? galat} />
      <Sukses pesan={sukses} />
      {daftar.map((p) => (
        <article className="butir" key={p.id}>
          <h3>{JENIS[p.type] ?? p.type}</h3>
          <p>Subjek: {p.subject?.name ?? p.subject?.email ?? '-'}</p>
          <p className="bantuan">Diajukan oleh {p.requestedBy.email}</p>
          {punya('user_role.approve') ? (
            <div className="aksi">
              <button className="tombol" type="button" onClick={() => putuskan(p.id, true)}>
                Setujui
              </button>
              <button className="tombol-sekunder" type="button" onClick={() => putuskan(p.id, false)}>
                Tolak
              </button>
            </div>
          ) : null}
        </article>
      ))}
      {info && daftar.length === 0 && !galat ? <p className="bantuan">Tidak ada permintaan yang menunggu.</p> : null}
      <Link className="tautan" href="/staff">
        Kembali ke beranda
      </Link>
    </Halaman>
  );
}
