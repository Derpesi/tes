'use client';

import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Galat, Halaman, Kolom, Lencana, Pilihan, Sukses } from '../../../components/ui';
import { ApiError, api } from '../../../lib/api';
import { useStaff } from '../../../lib/staff';

interface Lowongan { id: string; title: string; status: string; positions: number; companyId: string }
interface Perusahaan { id: string; name: string }

export default function LowonganStaff() {
  const { info, galat: galatSesi, punya } = useStaff();
  const [daftar, setDaftar] = useState<Lowongan[]>([]);
  const [perusahaan, setPerusahaan] = useState<Perusahaan[]>([]);
  const [kursor, setKursor] = useState<string | null>(null);
  const [galat, setGalat] = useState<string | null>(null);
  const [sukses, setSukses] = useState<string | null>(null);
  const [judul, setJudul] = useState('');
  const [deskripsi, setDeskripsi] = useState('');
  const [companyId, setCompanyId] = useState('');

  const muat = useCallback(async (lanjut?: string) => {
    try {
      const r = await api<{ items: Lowongan[]; nextCursor: string | null }>(`/vacancies?limit=20${lanjut ? `&cursor=${encodeURIComponent(lanjut)}` : ''}`);
      setDaftar((d) => (lanjut ? [...d, ...r.items] : r.items));
      setKursor(r.nextCursor);
    } catch (e) {
      setGalat((e as ApiError).message);
    }
  }, []);
  useEffect(() => {
    if (!info || !punya('vacancy_application.view')) return;
    void muat();
    if (punya('vacancy_application.create') && punya('company.view')) api<{ items: Perusahaan[] }>('/companies').then((r) => setPerusahaan(r.items), () => undefined);
  }, [info]); // eslint-disable-line react-hooks/exhaustive-deps

  const perluPilih = !info?.allCompanies && (info?.companyIds?.length ?? 0) > 1;

  async function buat(e: FormEvent) {
    e.preventDefault();
    if (!info) return;
    setGalat(null);
    setSukses(null);
    try {
      await api('/vacancies', { method: 'POST', csrf: info.csrfToken, body: { title: judul, description: deskripsi, ...(companyId ? { companyId } : {}) } });
      setJudul('');
      setDeskripsi('');
      await muat();
      setSukses('Lowongan dibuat sebagai DRAFT. Buka lowongan agar terlihat oleh member.');
    } catch (err) {
      setGalat((err as ApiError).message);
    }
  }
  async function ubah(l: Lowongan, aksi: 'open' | 'close', pesan: string) {
    if (!info) return;
    setGalat(null);
    setSukses(null);
    try {
      await api(`/vacancies/${l.id}/${aksi}`, { method: 'POST', csrf: info.csrfToken, body: {} });
      await muat();
      setSukses(pesan);
    } catch (err) {
      setGalat((err as ApiError).message);
    }
  }

  return (
    <Halaman judul="Lowongan">
      <Galat pesan={galatSesi ?? galat} />
      <Sukses pesan={sukses} />
      {info && !punya('vacancy_application.view') ? <Galat pesan="Anda tidak memiliki izin untuk melihat lowongan." /> : null}
      {punya('vacancy_application.create') ? (
        <details className="lipat">
          <summary>Tambah lowongan</summary>
          <form onSubmit={buat}>
            {perluPilih || info?.allCompanies ? <Pilihan id="perusahaan" label="Perusahaan pengelola" value={companyId} onChange={setCompanyId} opsi={perusahaan.map((p) => ({ nilai: p.id, teks: p.name }))} /> : null}
            <Kolom id="judul" label="Judul lowongan" value={judul} onChange={setJudul} maxLength={150} />
            <Kolom id="deskripsi" label="Deskripsi" value={deskripsi} onChange={setDeskripsi} maxLength={5000} />
            <button className="tombol" type="submit">
              Simpan lowongan
            </button>
          </form>
        </details>
      ) : null}
      {daftar.map((l) => (
        <article className="butir" key={l.id}>
          <h3>{l.title}</h3>
          <p>
            {l.positions} posisi <Lencana status={l.status} />
          </p>
          <div className="aksi">
            {l.status === 'DRAFT' && punya('vacancy_application.update') ? (
              <button className="tombol" type="button" onClick={() => ubah(l, 'open', 'Lowongan dibuka.')}>
                Buka lowongan {l.title}
              </button>
            ) : null}
            {l.status === 'DIBUKA' && punya('vacancy_application.update') ? (
              <button className="tombol-sekunder" type="button" onClick={() => ubah(l, 'close', 'Lowongan ditutup.')}>
                Tutup lowongan {l.title}
              </button>
            ) : null}
            <Link className="tautan" href={`/staff/lamaran?vacancyId=${l.id}`}>
              Lihat lamaran {l.title}
            </Link>
          </div>
        </article>
      ))}
      {kursor ? (
        <button className="tombol-sekunder" type="button" onClick={() => muat(kursor)}>
          Muat lebih banyak
        </button>
      ) : null}
      {info && punya('vacancy_application.view') && daftar.length === 0 && !galat ? <p className="bantuan">Belum ada lowongan.</p> : null}
      <Link className="tautan" href="/staff">
        Kembali ke beranda
      </Link>
    </Halaman>
  );
}
