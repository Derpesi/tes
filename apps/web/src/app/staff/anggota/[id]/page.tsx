'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Galat, Halaman, Kolom, Sukses } from '../../../../components/ui';
import { ApiError, api } from '../../../../lib/api';
import { formatTanggalIso } from '../../../../lib/format';
import { LABEL_STATUS_MEMBER } from '../../../../lib/member';
import { useStaff } from '../../../../lib/staff';

interface Detail {
  id: string; fullName: string | null; nik: string | null; status: string; birthPlace: string | null; birthDate: string | null; city: string | null; province: string | null; education: string | null; phone: string | null; reviewNote: string | null;
  documents: { id: string; kind: string; originalFilename: string }[]; history: { to: string; reason: string | null }[];
}

export default function DetailAnggota() {
  const { id } = useParams<{ id: string }>();
  const { info, galat: galatSesi, punya } = useStaff();
  const [d, setD] = useState<Detail | null>(null);
  const [nikPenuh, setNikPenuh] = useState<string | null>(null);
  const [alasan, setAlasan] = useState('');
  const [galat, setGalat] = useState<string | null>(null);
  const [sukses, setSukses] = useState<string | null>(null);

  const muat = useCallback(async () => {
    try {
      setD(await api<Detail>(`/members/${id}`));
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
      await api(`/members/${id}/${jalur}`, { method: 'POST', csrf: info.csrfToken, body });
      setAlasan('');
      await muat();
      setSukses(pesan);
    } catch (e) {
      setGalat((e as ApiError).message);
    }
  }
  async function bukaNik() {
    setGalat(null);
    try {
      setNikPenuh((await api<{ nik: string }>(`/members/${id}/nik`)).nik);
    } catch (e) {
      setGalat((e as ApiError).message);
    }
  }
  function kembalikan(e: FormEvent) {
    e.preventDefault();
    void aksi('return', { reason: alasan }, 'Dikembalikan ke member untuk revisi.');
  }

  return (
    <Halaman judul={d?.fullName ?? 'Detail member'}>
      <Galat pesan={galatSesi ?? galat} />
      <Sukses pesan={sukses} />
      {d ? (
        <>
          <div className="kartu">
            <p>
              Status: <strong>{LABEL_STATUS_MEMBER[d.status] ?? d.status}</strong>
            </p>
            <p>NIK: {nikPenuh ?? d.nik ?? '-'}</p>
            <p>
              {d.birthPlace ?? '-'}, {d.birthDate ? formatTanggalIso(String(d.birthDate).slice(0, 10)) : '-'}
            </p>
            <p>
              {d.city ?? '-'}, {d.province ?? '-'} · {d.education ?? '-'}
            </p>
            {punya('member.review') && !nikPenuh ? (
              <button className="tombol-sekunder" type="button" onClick={bukaNik}>
                Tampilkan NIK lengkap
              </button>
            ) : null}
          </div>
          <section className="bagian" aria-labelledby="h-dok">
            <h3 id="h-dok">Dokumen</h3>
            {d.documents.map((x) => (
              <article className="butir" key={x.id}>
                <p>
                  <strong>{x.kind}</strong> · {x.originalFilename}
                </p>
                {punya('member.review') ? (
                  <a className="tombol-sekunder" href={`/api/members/${id}/documents/${x.id}/download`}>
                    Unduh {x.originalFilename}
                  </a>
                ) : null}
              </article>
            ))}
            {d.documents.length === 0 ? <p className="bantuan">Belum ada dokumen.</p> : null}
          </section>
          {d.status === 'MENUNGGU_VERIFIKASI' ? (
            <section className="bagian" aria-labelledby="h-verif">
              <h3 id="h-verif">Verifikasi</h3>
              {punya('member.approve') ? (
                <button className="tombol" type="button" onClick={() => aksi('approve', {}, 'Member diverifikasi.')}>
                  Setujui verifikasi
                </button>
              ) : null}
              {punya('member.review') ? (
                <form onSubmit={kembalikan}>
                  <Kolom id="alasan" label="Alasan pengembalian" value={alasan} onChange={setAlasan} maxLength={500} />
                  <button className="tombol-sekunder" type="submit">
                    Kembalikan untuk revisi
                  </button>
                </form>
              ) : null}
            </section>
          ) : null}
          <section className="bagian" aria-labelledby="h-riw">
            <h3 id="h-riw">Riwayat status</h3>
            {d.history.map((h, i) => (
              <p className="bantuan" key={i}>
                {LABEL_STATUS_MEMBER[h.to] ?? h.to}
                {h.reason ? ` — ${h.reason}` : ''}
              </p>
            ))}
          </section>
        </>
      ) : galat || galatSesi ? null : (
        <p role="status">Memuat…</p>
      )}
      <Link className="tautan" href="/staff/anggota">
        Kembali ke daftar
      </Link>
    </Halaman>
  );
}
