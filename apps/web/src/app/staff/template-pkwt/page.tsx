'use client';

import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { AreaTeks, Galat, Halaman, Kolom, Lencana, Sukses } from '../../../components/ui';
import { ApiError, api } from '../../../lib/api';
import { useStaff } from '../../../lib/staff';

interface Template { id: string; name: string; version: number; status: string }

export default function TemplatePkwt() {
  const { info, galat: galatSesi, punya } = useStaff();
  const [daftar, setDaftar] = useState<Template[]>([]);
  const [variabel, setVariabel] = useState<string[]>([]);
  const [galat, setGalat] = useState<string | null>(null);
  const [sukses, setSukses] = useState<string | null>(null);
  const [nama, setNama] = useState('');
  const [isi, setIsi] = useState('');
  const [catatan, setCatatan] = useState('');

  const muat = useCallback(async () => {
    try {
      setDaftar((await api<{ items: Template[] }>('/pkwt/templates?limit=100')).items);
      setVariabel((await api<{ items: string[] }>('/pkwt/templates/variabel')).items);
    } catch (e) {
      setGalat((e as ApiError).message);
    }
  }, []);
  useEffect(() => {
    if (info && punya('pkwt.view')) void muat();
  }, [info]); // eslint-disable-line react-hooks/exhaustive-deps

  async function aksi(path: string, body: unknown, pesan: string): Promise<boolean> {
    if (!info) return false;
    setGalat(null);
    setSukses(null);
    try {
      await api(path, { method: 'POST', csrf: info.csrfToken, body });
      await muat();
      setSukses(pesan);
      return true;
    } catch (e) {
      setGalat((e as ApiError).message);
      return false;
    }
  }
  async function buat(e: FormEvent) {
    e.preventDefault();
    if (await aksi('/pkwt/templates', { name: nama, body: isi }, 'Template dibuat. Template baru perlu diverifikasi sebelum dipakai untuk kontrak.')) {
      setNama('');
      setIsi('');
    }
  }

  return (
    <Halaman judul="Template PKWT">
      <Galat pesan={galatSesi ?? galat} />
      <Sukses pesan={sukses} />
      <p className="bantuan">Sistem tidak menyediakan teks hukum. Isi template disediakan perusahaan dan harus diverifikasi ahli hukum sebelum dipakai.</p>
      {punya('pkwt.update') ? (
        <details className="lipat">
          <summary>Tambah template</summary>
          <form onSubmit={buat}>
            <Kolom id="nama-tpl" label="Nama template" value={nama} onChange={setNama} maxLength={150} />
            <AreaTeks id="isi-tpl" label="Isi template" value={isi} onChange={setIsi} maxLength={50000} baris={8} bantuan={`Variabel yang boleh dipakai: ${variabel.map((v) => `{{${v}}}`).join(', ')}`} />
            <button className="tombol" type="submit">
              Simpan template
            </button>
          </form>
        </details>
      ) : null}
      {daftar.map((t) => (
        <article className="butir" key={t.id}>
          <h3>
            {t.name} v{t.version}
          </h3>
          <p>
            <Lencana status={t.status} />
          </p>
          {t.status === 'BELUM_DIVERIFIKASI' && punya('pkwt.approve') ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void aksi(`/pkwt/templates/${t.id}/verify`, { note: catatan }, 'Template tercatat sudah diverifikasi.');
              }}
            >
              <Kolom id={`cat-${t.id}`} label={`Catatan verifikasi hukum untuk ${t.name} v${t.version}`} value={catatan} onChange={setCatatan} maxLength={500} />
              <button className="tombol" type="submit">
                Catat verifikasi {t.name} v{t.version}
              </button>
            </form>
          ) : null}
          {t.status === 'TERVERIFIKASI' && punya('pkwt.update') ? (
            <button className="tombol-sekunder" type="button" onClick={() => aksi(`/pkwt/templates/${t.id}/archive`, {}, 'Template diarsipkan.')}>
              Arsipkan {t.name} v{t.version}
            </button>
          ) : null}
        </article>
      ))}
      {info && punya('pkwt.view') && daftar.length === 0 && !galat ? <p className="bantuan">Belum ada template.</p> : null}
      <Link className="tautan" href="/staff">
        Kembali ke beranda
      </Link>
    </Halaman>
  );
}
