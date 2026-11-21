'use client';

import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Galat, Halaman, Kolom, Lencana, Pilihan, Sukses } from '../../../components/ui';
import { ApiError, api } from '../../../lib/api';
import { formatTanggalIso } from '../../../lib/format';
import { IZIN_PAYROLL_LIHAT, LABEL_JENIS_REKAP, LABEL_STATUS_REKAP, izinJenis } from '../../../lib/payroll';
import { useStaff } from '../../../lib/staff';

interface Periode { id: string; kind: string; label: string; startDate: string; endDate: string; recapId: string | null; status: string | null; versionNo: number | null }

export default function PayrollDaftar() {
  const { info, galat: galatSesi, punya } = useStaff();
  const [daftar, setDaftar] = useState<Periode[]>([]);
  const [kursor, setKursor] = useState<string | null>(null);
  const [galat, setGalat] = useState<string | null>(null);
  const [sukses, setSukses] = useState<string | null>(null);
  const [f, setF] = useState({ kind: '', label: '', mulai: '', akhir: '' });
  const lihat = IZIN_PAYROLL_LIHAT.some(punya);
  const jenisBuat = (['PARTNER', 'INTERNAL'] as const).filter((k) => punya(izinJenis(k, 'create')));

  const muat = useCallback(async (lanjut?: string) => {
    try {
      const r = await api<{ items: Periode[]; nextCursor: string | null }>(`/payroll/periods?limit=20${lanjut ? `&cursor=${encodeURIComponent(lanjut)}` : ''}`);
      setDaftar((d) => (lanjut ? [...d, ...r.items] : r.items));
      setKursor(r.nextCursor);
    } catch (e) {
      setGalat((e as ApiError).message);
    }
  }, []);
  useEffect(() => {
    if (info && lihat) void muat();
  }, [info]); // eslint-disable-line react-hooks/exhaustive-deps

  async function buat(e: FormEvent) {
    e.preventDefault();
    if (!info) return;
    setGalat(null);
    setSukses(null);
    try {
      await api('/payroll/periods', { method: 'POST', csrf: info.csrfToken, body: { kind: f.kind, label: f.label, startDate: f.mulai, endDate: f.akhir } });
      setF({ kind: '', label: '', mulai: '', akhir: '' });
      await muat();
      setSukses('Periode dibuka. Buka rekap untuk menarik absensi dan mengisi komponen.');
    } catch (err) {
      setGalat((err as ApiError).message);
    }
  }

  return (
    <Halaman judul="Rekap payroll">
      <Galat pesan={galatSesi ?? galat} />
      <Sukses pesan={sukses} />
      {info && !lihat ? <Galat pesan="Anda tidak memiliki izin untuk melihat rekap payroll." /> : null}
      <p className="bantuan">Tahap awal: rekap dan masukan saja. Tidak ada perhitungan gaji, PPh 21, BPJS, slip, atau pembayaran.</p>
      {jenisBuat.length ? (
        <details className="lipat">
          <summary>Buka periode baru</summary>
          <form onSubmit={buat}>
            <Pilihan id="kind" label="Jenis rekap" value={f.kind} onChange={(v) => setF({ ...f, kind: v })} opsi={jenisBuat.map((k) => ({ nilai: k, teks: LABEL_JENIS_REKAP[k] }))} />
            <Kolom id="label" label="Label periode" value={f.label} onChange={(v) => setF({ ...f, label: v })} maxLength={100} bantuan="Contoh: Maret 2026" />
            <Kolom id="mulai" label="Tanggal mulai" type="date" value={f.mulai} onChange={(v) => setF({ ...f, mulai: v })} />
            <Kolom id="akhir" label="Tanggal akhir" type="date" value={f.akhir} onChange={(v) => setF({ ...f, akhir: v })} bantuan="Rentang maksimal 93 hari; tidak boleh tumpang tindih." />
            <button className="tombol" type="submit">
              Buka periode
            </button>
          </form>
        </details>
      ) : null}
      {daftar.map((p) => (
        <div className="butir" key={p.id}>
          <h3>{p.label}</h3>
          <p>
            {LABEL_JENIS_REKAP[p.kind] ?? p.kind} · {formatTanggalIso(p.startDate)} – {formatTanggalIso(p.endDate)}
          </p>
          {p.status ? (
            <p>
              <Lencana status={p.status} /> {LABEL_STATUS_REKAP[p.status] ?? p.status} · versi {p.versionNo}
            </p>
          ) : null}
          {p.recapId ? (
            <Link className="tombol-sekunder" href={`/staff/payroll/${p.recapId}`}>
              Buka rekap {p.label}
            </Link>
          ) : null}
        </div>
      ))}
      {daftar.length === 0 && info && lihat ? <p>Belum ada periode.</p> : null}
      {kursor ? (
        <button className="tombol-sekunder" type="button" onClick={() => void muat(kursor)}>
          Muat lebih banyak
        </button>
      ) : null}
      <Link className="tombol-sekunder" href="/staff">
        Kembali
      </Link>
    </Halaman>
  );
}
