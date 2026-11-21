'use client';

import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Galat, Halaman, Kolom, Lencana, Pilihan, Sukses } from '../../../components/ui';
import { ApiError, api } from '../../../lib/api';
import { useStaff } from '../../../lib/staff';

interface Rekanan { id: string; name: string; city: string | null; status: string }
interface Perusahaan { id: string; name: string }

export default function RekananStaff() {
  const { info, galat: galatSesi, punya } = useStaff();
  const [daftar, setDaftar] = useState<Rekanan[]>([]);
  const [perusahaan, setPerusahaan] = useState<Perusahaan[]>([]);
  const [kursor, setKursor] = useState<string | null>(null);
  const [galat, setGalat] = useState<string | null>(null);
  const [sukses, setSukses] = useState<string | null>(null);
  const [nama, setNama] = useState('');
  const [kota, setKota] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [kirim, setKirim] = useState(false);

  const muat = useCallback(async (lanjut?: string) => {
    try {
      const r = await api<{ items: Rekanan[]; nextCursor: string | null }>(`/partners?limit=20${lanjut ? `&cursor=${encodeURIComponent(lanjut)}` : ''}`);
      setDaftar((d) => (lanjut ? [...d, ...r.items] : r.items));
      setKursor(r.nextCursor);
    } catch (e) {
      setGalat((e as ApiError).message);
    }
  }, []);
  useEffect(() => {
    if (!info || !punya('partner.view')) return;
    void muat();
    if (punya('partner.create') && punya('company.view')) {
      api<{ items: Perusahaan[] }>('/companies').then((r) => setPerusahaan(r.items), () => undefined);
    }
  }, [info]); // eslint-disable-line react-hooks/exhaustive-deps

  const perluPilihPerusahaan = !info?.allCompanies && (info?.companyIds?.length ?? 0) > 1;

  async function buat(e: FormEvent) {
    e.preventDefault();
    if (!info) return;
    setGalat(null);
    setSukses(null);
    setKirim(true);
    try {
      await api('/partners', { method: 'POST', csrf: info.csrfToken, body: { name: nama, ...(kota ? { city: kota } : {}), ...(companyId ? { companyId } : {}) } });
      setNama('');
      setKota('');
      setSukses('Rekanan ditambahkan.');
      await muat();
    } catch (err) {
      setGalat((err as ApiError).message);
    } finally {
      setKirim(false);
    }
  }

  return (
    <Halaman judul="Rekanan">
      <Galat pesan={galatSesi ?? galat} />
      <Sukses pesan={sukses} />
      {info && !punya('partner.view') ? <Galat pesan="Anda tidak memiliki izin untuk melihat rekanan." /> : null}
      {punya('partner.create') ? (
        <details className="lipat">
          <summary>Tambah rekanan</summary>
          <form onSubmit={buat}>
            {perluPilihPerusahaan || info?.allCompanies ? <Pilihan id="perusahaan" label="Perusahaan pengelola" value={companyId} onChange={setCompanyId} opsi={perusahaan.map((p) => ({ nilai: p.id, teks: p.name }))} /> : null}
            <Kolom id="nama" label="Nama rekanan" value={nama} onChange={setNama} maxLength={150} />
            <Kolom id="kota" label="Kota (opsional)" value={kota} onChange={setKota} maxLength={100} required={false} />
            <button className="tombol" type="submit" disabled={kirim}>
              {kirim ? 'Menyimpan…' : 'Simpan'}
            </button>
          </form>
        </details>
      ) : null}
      {daftar.map((r) => (
        <article className="butir" key={r.id}>
          <h3>{r.name}</h3>
          <p>
            {r.city ?? 'Kota belum diisi'} <Lencana status={r.status} />
          </p>
          <Link className="tautan" href={`/staff/rekanan/${r.id}`}>
            Lihat detail {r.name}
          </Link>
        </article>
      ))}
      {kursor ? (
        <button className="tombol-sekunder" type="button" onClick={() => muat(kursor)}>
          Muat lebih banyak
        </button>
      ) : null}
      {info && punya('partner.view') && daftar.length === 0 && !galat ? <p className="bantuan">Belum ada rekanan.</p> : null}
      <Link className="tautan" href="/staff">
        Kembali ke beranda
      </Link>
    </Halaman>
  );
}
