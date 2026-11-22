'use client';

import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { AreaTeks, Galat, Halaman, Kolom, Lencana, Sukses } from '../../../components/ui';
import { ApiError, api } from '../../../lib/api';
import { useStaff } from '../../../lib/staff';

interface PkwtPengaturan { penandatanganNama?: string; penandatanganJabatan?: string; kota?: string; pengadilanNegeri?: string; legalitas?: string[] }
interface Perusahaan { id: string; name: string; shortCode: string; active: boolean; city: string | null; documentSettings?: { pkwt?: PkwtPengaturan } | null }

/** Data perusahaan yang masuk ke templat PKWT (variabel templat). Kosong = dicetak sebagai titik-titik untuk diisi tangan. Bukan teks hukum. */
function PengaturanPkwt({ p, csrf, onSimpan }: { p: Perusahaan; csrf: string; onSimpan: () => void }) {
  const a = p.documentSettings?.pkwt ?? {};
  const [nama, setNama] = useState(a.penandatanganNama ?? '');
  const [jabatan, setJabatan] = useState(a.penandatanganJabatan ?? '');
  const [kota, setKota] = useState(a.kota ?? '');
  const [pn, setPn] = useState(a.pengadilanNegeri ?? '');
  const [legal, setLegal] = useState((a.legalitas ?? []).join('\n'));
  const [galat, setGalat] = useState<string | null>(null);
  const [sukses, setSukses] = useState<string | null>(null);
  const [kirim, setKirim] = useState(false);
  async function simpan(e: FormEvent) {
    e.preventDefault();
    setGalat(null);
    setSukses(null);
    setKirim(true);
    const pkwt: PkwtPengaturan = {};
    if (nama.trim()) pkwt.penandatanganNama = nama.trim();
    if (jabatan.trim()) pkwt.penandatanganJabatan = jabatan.trim();
    if (kota.trim()) pkwt.kota = kota.trim();
    if (pn.trim()) pkwt.pengadilanNegeri = pn.trim();
    const butir = legal.split('\n').map((x) => x.trim()).filter(Boolean);
    if (butir.length) pkwt.legalitas = butir;
    try {
      await api(`/companies/${p.id}`, { method: 'PATCH', csrf, body: { documentSettings: { pkwt } } });
      setSukses('Pengaturan PKWT disimpan.');
      onSimpan();
    } catch (err) {
      setGalat((err as ApiError).message);
    } finally {
      setKirim(false);
    }
  }
  return (
    <details>
      <summary>Pengaturan PKWT</summary>
      <p className="bantuan">Data ini dipakai templat PKWT untuk {p.name}. Yang dikosongkan dicetak sebagai titik-titik untuk diisi tangan. Teks perjanjian tetap berasal dari templat yang diverifikasi.</p>
      <Galat pesan={galat} />
      <Sukses pesan={sukses} />
      <form onSubmit={simpan}>
        <Kolom id={`pn-${p.id}`} label="Nama penandatangan (Pihak Pertama)" value={nama} onChange={setNama} maxLength={100} required={false} />
        <Kolom id={`pj-${p.id}`} label="Jabatan penandatangan" value={jabatan} onChange={setJabatan} maxLength={100} required={false} />
        <Kolom id={`pk-${p.id}`} label="Kota penandatanganan" value={kota} onChange={setKota} maxLength={100} required={false} bantuan="Bila kosong memakai kota perusahaan." />
        <Kolom id={`pg-${p.id}`} label="Pengadilan negeri (domisili hukum)" value={pn} onChange={setPn} maxLength={100} required={false} bantuan="Hanya nama kota, mis. Tangerang." />
        <AreaTeks id={`pl-${p.id}`} label="Dasar legalitas perusahaan" value={legal} onChange={setLegal} baris={6} required={false} bantuan="Satu butir per baris (maksimal 10, 300 karakter per butir): akta, NIB, izin usaha, domisili, wajib lapor, dan sebagainya." />
        <button className="tombol" type="submit" disabled={kirim}>
          {kirim ? 'Menyimpan…' : 'Simpan pengaturan PKWT'}
        </button>
      </form>
    </details>
  );
}

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
          {info && punya('company.update') ? <PengaturanPkwt key={p.id} p={p} csrf={info.csrfToken} onSimpan={() => void muat()} /> : null}
        </article>
      ))}
      {info && punya('company.view') && daftar.length === 0 && !galat ? <p className="bantuan">Belum ada perusahaan dalam akses Anda.</p> : null}
      <Link className="tautan" href="/staff">
        Kembali ke beranda
      </Link>
    </Halaman>
  );
}
