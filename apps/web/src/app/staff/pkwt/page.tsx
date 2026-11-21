'use client';

import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Galat, Halaman, Kolom, Lencana, Pilihan, Sukses } from '../../../components/ui';
import { ApiError, api } from '../../../lib/api';
import { formatTanggalIso } from '../../../lib/format';
import { LABEL_KONTRAK } from '../../../lib/pkwt';
import { useStaff } from '../../../lib/staff';

interface Kontrak { id: string; contractNumber: string; applicantName: string | null; position: string; startDate: string; endDate: string; status: string }
interface Lamaran { id: string; applicantName: string | null; vacancyTitle: string }
interface Template { id: string; name: string; version: number; status: string }

export default function PkwtStaff() {
  const { info, galat: galatSesi, punya } = useStaff();
  const [daftar, setDaftar] = useState<Kontrak[]>([]);
  const [kursor, setKursor] = useState<string | null>(null);
  const [lamaran, setLamaran] = useState<Lamaran[]>([]);
  const [template, setTemplate] = useState<Template[]>([]);
  const [galat, setGalat] = useState<string | null>(null);
  const [sukses, setSukses] = useState<string | null>(null);
  const [f, setF] = useState({ app: '', tpl: '', jabatan: '', mulai: '', akhir: '' });
  const set = (k: keyof typeof f) => (v: string) => setF((x) => ({ ...x, [k]: v }));

  const muat = useCallback(async (lanjut?: string) => {
    try {
      const r = await api<{ items: Kontrak[]; nextCursor: string | null }>(`/pkwt?limit=20${lanjut ? `&cursor=${encodeURIComponent(lanjut)}` : ''}`);
      setDaftar((d) => (lanjut ? [...d, ...r.items] : r.items));
      setKursor(r.nextCursor);
    } catch (e) {
      setGalat((e as ApiError).message);
    }
  }, []);
  useEffect(() => {
    if (!info || !punya('pkwt.view')) return;
    void muat();
    if (punya('pkwt.create')) {
      api<{ items: Lamaran[] }>('/applications?status=MENUNGGU_PKWT&limit=100').then((r) => setLamaran(r.items), () => undefined);
      api<{ items: Template[] }>('/pkwt/templates?limit=100').then((r) => setTemplate(r.items.filter((t) => t.status !== 'DIARSIPKAN')), () => undefined);
    }
  }, [info]); // eslint-disable-line react-hooks/exhaustive-deps

  async function buat(e: FormEvent) {
    e.preventDefault();
    if (!info) return;
    setGalat(null);
    setSukses(null);
    try {
      await api('/pkwt', { method: 'POST', csrf: info.csrfToken, body: { applicationId: f.app, templateId: f.tpl, position: f.jabatan, startDate: f.mulai, endDate: f.akhir } });
      setF({ app: '', tpl: '', jabatan: '', mulai: '', akhir: '' });
      await muat();
      setSukses('Kontrak dibuat sebagai draf.');
    } catch (err) {
      setGalat((err as ApiError).message);
    }
  }

  return (
    <Halaman judul="Kontrak PKWT">
      <Galat pesan={galatSesi ?? galat} />
      <Sukses pesan={sukses} />
      {info && !punya('pkwt.view') ? <Galat pesan="Anda tidak memiliki izin untuk melihat kontrak PKWT." /> : null}
      {punya('pkwt.create') ? (
        <details className="lipat">
          <summary>Buat kontrak dari lamaran</summary>
          <form onSubmit={buat}>
            <Pilihan id="lamaran" label="Lamaran yang diterima" value={f.app} onChange={set('app')} opsi={lamaran.map((l) => ({ nilai: l.id, teks: `${l.applicantName ?? 'Pelamar'} — ${l.vacancyTitle}` }))} />
            <Pilihan id="template" label="Template" value={f.tpl} onChange={set('tpl')} opsi={template.map((t) => ({ nilai: t.id, teks: `${t.name} v${t.version}${t.status === 'TERVERIFIKASI' ? '' : ' (belum diverifikasi)'}` }))} />
            <Kolom id="jabatan" label="Jabatan" value={f.jabatan} onChange={set('jabatan')} maxLength={100} />
            <Kolom id="mulai" label="Tanggal mulai" type="date" value={f.mulai} onChange={set('mulai')} />
            <Kolom id="akhir" label="Tanggal berakhir" type="date" value={f.akhir} onChange={set('akhir')} />
            <button className="tombol" type="submit">
              Simpan kontrak
            </button>
          </form>
        </details>
      ) : null}
      {daftar.map((k) => (
        <article className="butir" key={k.id}>
          <h3>{k.contractNumber}</h3>
          <p>
            {k.applicantName ?? 'Pekerja'} · {k.position} <Lencana status={k.status} />
          </p>
          <p className="bantuan">
            {formatTanggalIso(k.startDate)} – {formatTanggalIso(k.endDate)} · {LABEL_KONTRAK[k.status] ?? k.status}
          </p>
          <Link className="tautan" href={`/staff/pkwt/${k.id}`}>
            Buka kontrak {k.contractNumber}
          </Link>
        </article>
      ))}
      {kursor ? (
        <button className="tombol-sekunder" type="button" onClick={() => muat(kursor)}>
          Muat lebih banyak
        </button>
      ) : null}
      {info && punya('pkwt.view') && daftar.length === 0 && !galat ? <p className="bantuan">Belum ada kontrak.</p> : null}
      <Link className="tautan" href="/staff">
        Kembali ke beranda
      </Link>
    </Halaman>
  );
}
