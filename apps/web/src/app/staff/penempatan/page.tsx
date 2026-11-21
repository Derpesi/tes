'use client';

import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Galat, Halaman, Kolom, Lencana, Pilihan, Sukses } from '../../../components/ui';
import { ApiError, api } from '../../../lib/api';
import { formatTanggalIso } from '../../../lib/format';
import { useStaff } from '../../../lib/staff';

interface Penempatan { id: string; workerName: string | null; locationName: string; contractNumber: string; startDate: string; endDate: string | null; status: string }
interface Kontrak { id: string; contractNumber: string; applicantName: string | null; startDate: string; endDate: string }
interface Rekanan { id: string; name: string }
interface Lokasi { id: string; name: string }

export default function PenempatanStaff() {
  const { info, galat: galatSesi, punya } = useStaff();
  const [daftar, setDaftar] = useState<Penempatan[]>([]);
  const [kursor, setKursor] = useState<string | null>(null);
  const [kontrak, setKontrak] = useState<Kontrak[]>([]);
  const [rekanan, setRekanan] = useState<Rekanan[]>([]);
  const [lokasi, setLokasi] = useState<Lokasi[]>([]);
  const [galat, setGalat] = useState<string | null>(null);
  const [sukses, setSukses] = useState<string | null>(null);
  const [alasan, setAlasan] = useState('');
  const [f, setF] = useState({ kontrak: '', rekanan: '', lokasi: '', mulai: '', akhir: '' });
  const set = (k: keyof typeof f) => (v: string) => setF((x) => ({ ...x, [k]: v }));

  const muat = useCallback(async (lanjut?: string) => {
    try {
      const r = await api<{ items: Penempatan[]; nextCursor: string | null }>(`/placements?limit=20${lanjut ? `&cursor=${encodeURIComponent(lanjut)}` : ''}`);
      setDaftar((d) => (lanjut ? [...d, ...r.items] : r.items));
      setKursor(r.nextCursor);
    } catch (e) {
      setGalat((e as ApiError).message);
    }
  }, []);
  useEffect(() => {
    if (!info || !punya('placement.view')) return;
    void muat();
    if (punya('placement.create')) {
      Promise.all([api<{ items: Kontrak[] }>('/pkwt?status=DITANDATANGANI&limit=100'), api<{ items: Kontrak[] }>('/pkwt?status=AKTIF&limit=100'), api<{ items: Rekanan[] }>('/partners?status=AKTIF&limit=100')])
        .then(([a, b, c]) => {
          setKontrak([...a.items, ...b.items]);
          setRekanan(c.items);
        })
        .catch(() => undefined);
    }
  }, [info]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!f.rekanan) return setLokasi([]);
    api<{ items: Lokasi[] }>(`/partners/${f.rekanan}/locations`).then((r) => setLokasi(r.items), () => setLokasi([]));
  }, [f.rekanan]);

  async function buat(e: FormEvent) {
    e.preventDefault();
    if (!info) return;
    setGalat(null);
    setSukses(null);
    try {
      await api('/placements', { method: 'POST', csrf: info.csrfToken, body: { contractId: f.kontrak, locationId: f.lokasi, startDate: f.mulai, ...(f.akhir ? { endDate: f.akhir } : {}) } });
      setF({ kontrak: '', rekanan: '', lokasi: '', mulai: '', akhir: '' });
      await muat();
      setSukses('Penempatan direncanakan dan menunggu persetujuan.');
    } catch (err) {
      setGalat((err as ApiError).message);
    }
  }
  async function aksi(p: Penempatan, jalur: string, body: unknown, pesan: string) {
    if (!info) return;
    setGalat(null);
    setSukses(null);
    try {
      await api(`/placements/${p.id}/${jalur}`, { method: 'POST', csrf: info.csrfToken, body });
      setAlasan('');
      await muat();
      setSukses(pesan);
    } catch (err) {
      setGalat((err as ApiError).message);
    }
  }

  return (
    <Halaman judul="Penempatan">
      <Galat pesan={galatSesi ?? galat} />
      <Sukses pesan={sukses} />
      {info && !punya('placement.view') ? <Galat pesan="Anda tidak memiliki izin untuk melihat penempatan." /> : null}
      {punya('placement.create') ? (
        <details className="lipat">
          <summary>Rencanakan penempatan</summary>
          <form onSubmit={buat}>
            <Pilihan id="kontrak" label="Kontrak" value={f.kontrak} onChange={set('kontrak')} opsi={kontrak.map((k) => ({ nilai: k.id, teks: `${k.contractNumber} — ${k.applicantName ?? 'Pekerja'}` }))} />
            <Pilihan id="rekanan" label="Rekanan" value={f.rekanan} onChange={set('rekanan')} opsi={rekanan.map((r) => ({ nilai: r.id, teks: r.name }))} />
            <Pilihan id="lokasi" label="Lokasi kerja" value={f.lokasi} onChange={set('lokasi')} opsi={lokasi.map((l) => ({ nilai: l.id, teks: l.name }))} />
            <Kolom id="mulai" label="Tanggal mulai" type="date" value={f.mulai} onChange={set('mulai')} />
            <Kolom id="akhir" label="Tanggal selesai (opsional)" type="date" value={f.akhir} onChange={set('akhir')} required={false} bantuan="Kosongkan untuk mengikuti tanggal akhir kontrak." />
            <button className="tombol" type="submit">
              Simpan penempatan
            </button>
          </form>
        </details>
      ) : null}
      {daftar.map((p) => (
        <article className="butir" key={p.id}>
          <h3>{p.workerName ?? 'Pekerja'}</h3>
          <p>
            {p.locationName} · {p.contractNumber} <Lencana status={p.status} />
          </p>
          <p className="bantuan">
            {formatTanggalIso(p.startDate)}
            {p.endDate ? ` – ${formatTanggalIso(p.endDate)}` : ''}
          </p>
          <div className="aksi">
            {p.status === 'DIRENCANAKAN' && punya('placement.approve') ? (
              <button className="tombol" type="button" onClick={() => aksi(p, 'approve', {}, 'Penempatan disetujui.')}>
                Setujui penempatan {p.workerName ?? ''}
              </button>
            ) : null}
            {p.status === 'DITANGGUHKAN' && punya('placement.update') ? (
              <button className="tombol" type="button" onClick={() => aksi(p, 'resume', {}, 'Penempatan dilanjutkan.')}>
                Lanjutkan penempatan {p.workerName ?? ''}
              </button>
            ) : null}
          </div>
          {['AKTIF', 'DITANGGUHKAN', 'DIRENCANAKAN', 'MENUNGGU_KONTRAK'].includes(p.status) && punya('placement.update') ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void aksi(p, p.status === 'AKTIF' ? 'suspend' : p.status === 'DITANGGUHKAN' ? 'complete' : 'cancel', { reason: alasan }, p.status === 'AKTIF' ? 'Penempatan ditangguhkan.' : p.status === 'DITANGGUHKAN' ? 'Penempatan diselesaikan.' : 'Penempatan dibatalkan.');
              }}
            >
              <Kolom id={`alasan-${p.id}`} label={`Alasan ${p.status === 'AKTIF' ? 'menangguhkan' : p.status === 'DITANGGUHKAN' ? 'menyelesaikan' : 'membatalkan'} (${p.workerName ?? 'pekerja'})`} value={alasan} onChange={setAlasan} maxLength={500} />
              <button className="tombol-sekunder" type="submit">
                {p.status === 'AKTIF' ? 'Tangguhkan' : p.status === 'DITANGGUHKAN' ? 'Selesaikan' : 'Batalkan'} penempatan {p.workerName ?? ''}
              </button>
            </form>
          ) : null}
        </article>
      ))}
      {kursor ? (
        <button className="tombol-sekunder" type="button" onClick={() => muat(kursor)}>
          Muat lebih banyak
        </button>
      ) : null}
      {info && punya('placement.view') && daftar.length === 0 && !galat ? <p className="bantuan">Belum ada penempatan.</p> : null}
      <Link className="tautan" href="/staff">
        Kembali ke beranda
      </Link>
    </Halaman>
  );
}
