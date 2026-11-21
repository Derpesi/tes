'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Galat, Halaman, Kolom, Lencana, Sukses } from '../../../../components/ui';
import { ApiError, api } from '../../../../lib/api';
import { useStaff } from '../../../../lib/staff';

interface Detail { id: string; vacancyTitle: string; status: string; applicant: { fullName: string | null; city: string | null; education: string | null }; history: { to: string; reason: string | null }[] }

export default function DetailLamaran() {
  const { id } = useParams<{ id: string }>();
  const { info, galat: galatSesi, punya } = useStaff();
  const [d, setD] = useState<Detail | null>(null);
  const [alasan, setAlasan] = useState('');
  const [galat, setGalat] = useState<string | null>(null);
  const [sukses, setSukses] = useState<string | null>(null);

  const muat = useCallback(async () => {
    try {
      setD(await api<Detail>(`/applications/${id}`));
    } catch (e) {
      setGalat((e as ApiError).message);
    }
  }, [id]);
  useEffect(() => {
    if (info) void muat();
  }, [info, muat]);

  async function aksi(jalur: string, body: unknown, pesan: string) {
    if (!info) return;
    setGalat(null);
    setSukses(null);
    try {
      await api(`/applications/${id}/${jalur}`, { method: 'POST', csrf: info.csrfToken, body });
      setAlasan('');
      await muat();
      setSukses(pesan);
    } catch (e) {
      setGalat((e as ApiError).message);
    }
  }
  function tolak(e: FormEvent) {
    e.preventDefault();
    void aksi('reject', { reason: alasan }, 'Lamaran ditolak.');
  }

  return (
    <Halaman judul={d?.applicant.fullName ?? 'Detail lamaran'}>
      <Galat pesan={galatSesi ?? galat} />
      <Sukses pesan={sukses} />
      {d ? (
        <>
          <div className="kartu">
            <p>
              {d.vacancyTitle} <Lencana status={d.status} />
            </p>
            <p className="bantuan">
              {d.applicant.city ?? '-'} · {d.applicant.education ?? '-'}
            </p>
          </div>
          <div className="aksi">
            {d.status === 'DIAJUKAN' && punya('vacancy_application.review') ? (
              <button className="tombol" type="button" onClick={() => aksi('stage', { status: 'SELEKSI_ADMINISTRASI' }, 'Dipindahkan ke seleksi administrasi.')}>
                Lanjut ke seleksi administrasi
              </button>
            ) : null}
            {d.status === 'SELEKSI_ADMINISTRASI' && punya('vacancy_application.review') ? (
              <button className="tombol" type="button" onClick={() => aksi('stage', { status: 'INTERVIEW' }, 'Dipindahkan ke interview.')}>
                Lanjut ke interview
              </button>
            ) : null}
            {d.status === 'INTERVIEW' && punya('vacancy_application.approve') ? (
              <button className="tombol" type="button" onClick={() => aksi('accept', {}, 'Pelamar diterima dan menunggu PKWT.')}>
                Terima pelamar
              </button>
            ) : null}
          </div>
          {['DIAJUKAN', 'SELEKSI_ADMINISTRASI', 'INTERVIEW'].includes(d.status) && punya('vacancy_application.review') ? (
            <form onSubmit={tolak}>
              <Kolom id="alasan" label="Alasan penolakan" value={alasan} onChange={setAlasan} maxLength={500} />
              <button className="tombol-sekunder" type="submit">
                Tolak lamaran
              </button>
            </form>
          ) : null}
          <section className="bagian" aria-labelledby="h-riw">
            <h3 id="h-riw">Riwayat</h3>
            {d.history.map((h, i) => (
              <p className="bantuan" key={i}>
                {h.to.replace(/_/g, ' ')}
                {h.reason ? ` — ${h.reason}` : ''}
              </p>
            ))}
          </section>
        </>
      ) : galat || galatSesi ? null : (
        <p role="status">Memuat…</p>
      )}
      <Link className="tautan" href="/staff/lamaran">
        Kembali ke daftar
      </Link>
    </Halaman>
  );
}
