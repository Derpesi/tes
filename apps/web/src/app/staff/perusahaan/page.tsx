'use client';

import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Galat, Halaman, Kolom, Lencana, Sukses } from '../../../components/ui';
import { ApiError, api } from '../../../lib/api';
import { useStaff } from '../../../lib/staff';

interface Perusahaan { id: string; name: string; shortCode: string; active: boolean; city: string | null }

export default function PerusahaanStaff() {
  const { info, galat: galatSesi, punya } = useStaff();
  const [daftar, setDaftar] = useState<Perusahaan[]>([]);
  const [galat, setGalat] = useState<string | null>(null);
  const [sukses, setSukses] = useState<string | null>(null);
  const [nama, setNama] = useState('');
  const [kode, setKode] = useState('');
  const [kirim, setKirim] = useState(false);

  const muat = useCallback(async () => {
    try {
      setDaftar((await api<{ items: Perusahaan[] }>('/companies')).items);
    } catch (e) {
      setGalat((e as ApiError).message);
    }
  }, []);
  useEffect(() => {
    if (info && punya('company.view')) void muat();
  }, [info]); // eslint-disable-line react-hooks/exhaustive-deps

  async function buat(e: FormEvent) {
    e.preventDefault();
    if (!info) return;
    setGalat(null);
    setSukses(null);
    setKirim(true);
    try {
      await api('/companies', { method: 'POST', csrf: info.csrfToken, body: { name: nama, shortCode: kode } });
      setNama('');
      setKode('');
      setSukses('Perusahaan dibuat dan menunggu persetujuan aktivasi Direktur.');
      await muat();
    } catch (err) {
      setGalat((err as ApiError).message);
    } finally {
      setKirim(false);
    }
  }

  return (
    <Halaman judul="Perusahaan grup">
      <Galat pesan={galatSesi ?? galat} />
      <Sukses pesan={sukses} />
      {info && !punya('company.view') ? <Galat pesan="Anda tidak memiliki izin untuk melihat perusahaan." /> : null}
      {punya('company.create') ? (
        <details className="lipat">
          <summary>Tambah perusahaan</summary>
          <form onSubmit={buat}>
            <Kolom id="nama" label="Nama perusahaan" value={nama} onChange={setNama} maxLength={150} />
            <Kolom id="kode" label="Kode singkat" value={kode} onChange={(v) => setKode(v.toUpperCase())} maxLength={12} bantuan="2–12 huruf besar atau angka, unik antarperusahaan." />
            <button className="tombol" type="submit" disabled={kirim}>
              {kirim ? 'Menyimpan…' : 'Simpan'}
            </button>
          </form>
        </details>
      ) : null}
      {daftar.map((p) => (
        <article className="butir" key={p.id}>
          <h3>{p.name}</h3>
          <p>
            Kode {p.shortCode} <Lencana status={p.active ? 'AKTIF' : 'MENUNGGU_PERSETUJUAN'} />
          </p>
        </article>
      ))}
      {info && punya('company.view') && daftar.length === 0 && !galat ? <p className="bantuan">Belum ada perusahaan dalam akses Anda.</p> : null}
      <Link className="tautan" href="/staff">
        Kembali ke beranda
      </Link>
    </Halaman>
  );
}
