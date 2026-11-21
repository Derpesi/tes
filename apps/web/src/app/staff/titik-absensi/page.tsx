'use client';

import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Galat, Halaman, Lencana, Pilihan, Sukses } from '../../../components/ui';
import { ApiError, api } from '../../../lib/api';
import { useStaff } from '../../../lib/staff';

interface Titik { id: string; locationId: string; locationName: string; publicCode: string; status: string; geofenceRadiusM: number }
interface Rekanan { id: string; name: string }
interface Lokasi { id: string; name: string }

export default function TitikAbsensi() {
  const { info, galat: galatSesi, punya } = useStaff();
  const [daftar, setDaftar] = useState<Titik[]>([]);
  const [kursor, setKursor] = useState<string | null>(null);
  const [rekanan, setRekanan] = useState<Rekanan[]>([]);
  const [lokasi, setLokasi] = useState<Lokasi[]>([]);
  const [f, setF] = useState({ rekanan: '', lokasi: '' });
  const [galat, setGalat] = useState<string | null>(null);
  const [sukses, setSukses] = useState<string | null>(null);

  const muat = useCallback(async (lanjut?: string) => {
    try {
      const r = await api<{ items: Titik[]; nextCursor: string | null }>(`/attendance/points?limit=20${lanjut ? `&cursor=${encodeURIComponent(lanjut)}` : ''}`);
      setDaftar((d) => (lanjut ? [...d, ...r.items] : r.items));
      setKursor(r.nextCursor);
    } catch (e) {
      setGalat((e as ApiError).message);
    }
  }, []);
  const lihat = ['attendance_point.view', 'attendance_point.create', 'attendance_point.update', 'attendance_point.export'].some(punya);
  useEffect(() => {
    if (!info || !lihat) return;
    void muat();
    if (punya('attendance_point.create')) api<{ items: Rekanan[] }>('/partners?status=AKTIF&limit=100').then((r) => setRekanan(r.items), () => undefined);
  }, [info]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!f.rekanan) return setLokasi([]);
    api<{ items: Lokasi[] }>(`/partners/${f.rekanan}/locations`).then((r) => setLokasi(r.items), () => setLokasi([]));
  }, [f.rekanan]);

  async function aksi(jalur: string, pesan: string, konfirmasi?: string) {
    if (!info || (konfirmasi && !window.confirm(konfirmasi))) return;
    setGalat(null);
    setSukses(null);
    try {
      await api(jalur, { method: 'POST', csrf: info.csrfToken });
      await muat();
      setSukses(pesan);
    } catch (e) {
      setGalat((e as ApiError).message);
    }
  }
  async function buat(e: FormEvent) {
    e.preventDefault();
    if (!info) return;
    setGalat(null);
    setSukses(null);
    try {
      await api('/attendance/points', { method: 'POST', csrf: info.csrfToken, body: { locationId: f.lokasi } });
      setF({ rekanan: '', lokasi: '' });
      await muat();
      setSukses('Titik absensi dibuat. Unduh poster QR lalu tempel di lokasi kerja.');
    } catch (err) {
      setGalat((err as ApiError).message);
    }
  }

  return (
    <Halaman judul="Titik absensi (QR)">
      <Galat pesan={galatSesi ?? galat} />
      <Sukses pesan={sukses} />
      {info && !lihat ? <Galat pesan="Anda tidak memiliki izin untuk melihat titik absensi." /> : null}
      <p className="bantuan">QR hanya pengenal titik, bukan rahasia. Keamanan absen ada pada login member, radius lokasi, dan selfie. Ganti kode bila QR rusak atau disalahgunakan.</p>
      {punya('attendance_point.create') ? (
        <details className="lipat">
          <summary>Buat titik absensi</summary>
          <form onSubmit={buat}>
            <Pilihan id="rekanan" label="Rekanan" value={f.rekanan} onChange={(v) => setF({ rekanan: v, lokasi: '' })} opsi={rekanan.map((r) => ({ nilai: r.id, teks: r.name }))} />
            <Pilihan id="lokasi" label="Lokasi kerja (harus memiliki koordinat)" value={f.lokasi} onChange={(v) => setF((x) => ({ ...x, lokasi: v }))} opsi={lokasi.map((l) => ({ nilai: l.id, teks: l.name }))} />
            <button className="tombol" type="submit">
              Buat titik
            </button>
          </form>
        </details>
      ) : null}
      {daftar.map((t) => (
        <div className="butir" key={t.id}>
          <h3>{t.locationName}</h3>
          <p>
            <Lencana status={t.status} /> · radius {t.geofenceRadiusM} m · kode {t.publicCode.slice(0, 8).toUpperCase()}
          </p>
          {t.status === 'AKTIF' ? (
            <div className="aksi">
              {punya('attendance_point.export') ? (
                <a className="tombol-sekunder" href={`/api/attendance/points/${t.id}/qr.pdf`}>
                  Unduh poster QR (PDF)
                </a>
              ) : null}
              {punya('attendance_point.update') ? (
                <button className="tombol-sekunder" type="button" onClick={() => void aksi(`/attendance/points/${t.id}/rotate-code`, 'Kode diganti. QR lama tidak berlaku; cetak poster baru.', 'Ganti kode? QR yang sudah ditempel langsung tidak berlaku.')}>
                  Ganti kode QR
                </button>
              ) : null}
              {punya('attendance_point.deactivate') ? (
                <button className="tombol-sekunder" type="button" onClick={() => void aksi(`/attendance/points/${t.id}/deactivate`, 'Titik dinonaktifkan.', 'Nonaktifkan titik absensi ini?')}>
                  Nonaktifkan
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ))}
      {daftar.length === 0 && info && lihat ? <p>Belum ada titik absensi.</p> : null}
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
