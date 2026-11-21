'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { FormEvent, Suspense, useCallback, useEffect, useState } from 'react';
import { AreaTeks, Galat, Halaman, Lencana, Pilihan, Sukses } from '../../../components/ui';
import { LABEL_STATUS_HARI } from '../../../lib/absensi';
import { ApiError, api } from '../../../lib/api';
import { formatTanggalIso } from '../../../lib/format';
import { useStaff } from '../../../lib/staff';

interface Koreksi { id: string; adjustmentNo: string; workerName: string; shiftDate: string; effect: string; reason: string; status: string; decisionNote: string | null }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function Isi() {
  const { info, galat: galatSesi, punya } = useStaff();
  const q = useSearchParams();
  const personId = q.get('personId') ?? '';
  const shiftDate = q.get('shiftDate') ?? '';
  const nama = q.get('nama') ?? '';
  const [status, setStatus] = useState('');
  const [daftar, setDaftar] = useState<Koreksi[]>([]);
  const [kursor, setKursor] = useState<string | null>(null);
  const [galat, setGalat] = useState<string | null>(null);
  const [sukses, setSukses] = useState<string | null>(null);
  const [efek, setEfek] = useState('');
  const [alasan, setAlasan] = useState('');
  const [catatan, setCatatan] = useState('');

  const lihat = ['attendance_adjustment.view', 'attendance_adjustment.create', 'attendance_adjustment.update', 'attendance_adjustment.approve'].some(punya);
  const muat = useCallback(async (lanjut?: string) => {
    try {
      const r = await api<{ items: Koreksi[]; nextCursor: string | null }>(`/attendance/adjustments?limit=20${status ? `&status=${status}` : ''}${lanjut ? `&cursor=${encodeURIComponent(lanjut)}` : ''}`);
      setDaftar((d) => (lanjut ? [...d, ...r.items] : r.items));
      setKursor(r.nextCursor);
    } catch (e) {
      setGalat((e as ApiError).message);
    }
  }, [status]);
  useEffect(() => {
    if (info && lihat) void muat();
  }, [info, muat]); // eslint-disable-line react-hooks/exhaustive-deps

  async function ajukan(e: FormEvent) {
    e.preventDefault();
    if (!info) return;
    setGalat(null);
    setSukses(null);
    try {
      const r = await api<Koreksi>('/attendance/adjustments', { method: 'POST', csrf: info.csrfToken, body: { personId, shiftDate, effect: efek, reason: alasan } });
      setAlasan('');
      await muat();
      setSukses(`Koreksi ${r.adjustmentNo} diajukan dan menunggu putusan Manajer Operasional.`);
    } catch (err) {
      setGalat((err as ApiError).message);
    }
  }
  async function putuskan(k: Koreksi, keputusan: 'DISETUJUI' | 'DITOLAK') {
    if (!info) return;
    setGalat(null);
    setSukses(null);
    try {
      await api(`/attendance/adjustments/${k.id}/decide`, { method: 'POST', csrf: info.csrfToken, body: { decision: keputusan, note: catatan } });
      setCatatan('');
      await muat();
      setSukses(`Koreksi ${k.adjustmentNo} ${keputusan === 'DISETUJUI' ? 'disetujui' : 'ditolak'}.`);
    } catch (err) {
      setGalat((err as ApiError).message);
    }
  }

  return (
    <Halaman judul="Koreksi absensi">
      <Galat pesan={galatSesi ?? galat} />
      <Sukses pesan={sukses} />
      {info && !lihat ? <Galat pesan="Anda tidak memiliki izin untuk melihat koreksi absensi." /> : null}
      <p className="bantuan">Koreksi bernomor menggantikan hasil hari itu pada rekap tanpa mengubah rekaman asli. Pembuat dan penyetuju harus orang berbeda.</p>
      {UUID.test(personId) && /^\d{4}-\d{2}-\d{2}$/.test(shiftDate) && punya('attendance_adjustment.create') ? (
        <form onSubmit={ajukan} className="kartu">
          <h3>Ajukan koreksi</h3>
          <p>
            {nama || 'Pekerja'} · {formatTanggalIso(shiftDate)}
          </p>
          <Pilihan id="efek" label="Hasil yang benar" value={efek} onChange={setEfek} opsi={['HADIR', 'TIDAK_HADIR', 'IZIN', 'SAKIT'].map((v) => ({ nilai: v, teks: LABEL_STATUS_HARI[v] }))} />
          <AreaTeks id="alasan" label="Alasan koreksi" value={alasan} onChange={setAlasan} maxLength={500} baris={3} />
          <button className="tombol" type="submit">
            Ajukan koreksi
          </button>
        </form>
      ) : (
        <p className="bantuan">Untuk mengajukan koreksi, buka rekap absensi lalu pilih &quot;Ajukan koreksi&quot; pada hari yang dimaksud.</p>
      )}
      <Pilihan id="status" label="Status" required={false} value={status} onChange={setStatus} opsi={[{ nilai: 'DIAJUKAN', teks: 'Diajukan' }, { nilai: 'DISETUJUI', teks: 'Disetujui' }, { nilai: 'DITOLAK', teks: 'Ditolak' }]} />
      {daftar.map((k) => (
        <div className="butir" key={k.id}>
          <h3>{k.adjustmentNo}</h3>
          <p>
            {k.workerName} · {formatTanggalIso(k.shiftDate)}
          </p>
          <p>
            <Lencana status={k.status} /> {k.status === 'DIAJUKAN' ? 'Diajukan' : k.status === 'DISETUJUI' ? 'Disetujui' : 'Ditolak'} · hasil: {LABEL_STATUS_HARI[k.effect] ?? k.effect}
          </p>
          <p className="bantuan">{k.reason}</p>
          {k.decisionNote ? <p className="bantuan">Putusan: {k.decisionNote}</p> : null}
          {k.status === 'DIAJUKAN' && punya('attendance_adjustment.approve') ? (
            <div className="aksi">
              <AreaTeks id={`cat-${k.id}`} label="Catatan putusan" value={catatan} onChange={setCatatan} maxLength={500} baris={2} />
              <button className="tombol" type="button" onClick={() => void putuskan(k, 'DISETUJUI')}>
                Setujui
              </button>
              <button className="tombol-sekunder" type="button" onClick={() => void putuskan(k, 'DITOLAK')}>
                Tolak
              </button>
            </div>
          ) : null}
        </div>
      ))}
      {daftar.length === 0 && info && lihat ? <p>Belum ada koreksi.</p> : null}
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

export default function KoreksiAbsensi() {
  return (
    <Suspense fallback={<p role="status">Memuat…</p>}>
      <Isi />
    </Suspense>
  );
}
