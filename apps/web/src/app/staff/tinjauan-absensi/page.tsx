'use client';

import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { AreaTeks, Galat, Halaman, Lencana, Pilihan, Sukses } from '../../../components/ui';
import { LABEL_FLAG, LABEL_JENIS_ABSEN, LABEL_TAHAP, formatWaktuWib } from '../../../lib/absensi';
import { ApiError, api } from '../../../lib/api';
import { formatTanggalIso } from '../../../lib/format';
import { useStaff } from '../../../lib/staff';

interface Item { id: string; workerName: string; locationName: string | null; kind: string; shiftDate: string; occurredAt: string; flags: string[]; tahap: string; deviceStatus: string | null; distanceM: number | null; accuracyM: number | null }
interface Detail extends Item {
  reviews: { stage: string; decision: string; reason: string }[];
  selfie: { available: boolean; purged: boolean; legalHold: boolean; purgeAfter: string } | null;
}

export default function TinjauanAbsensi() {
  const { info, galat: galatSesi, punya } = useStaff();
  const [tahap, setTahap] = useState('');
  const [daftar, setDaftar] = useState<Item[]>([]);
  const [kursor, setKursor] = useState<string | null>(null);
  const [buka, setBuka] = useState<Detail | null>(null);
  const [galat, setGalat] = useState<string | null>(null);
  const [sukses, setSukses] = useState<string | null>(null);
  const [alasan, setAlasan] = useState('');
  const [putusan, setPutusan] = useState('');
  const [perangkat, setPerangkat] = useState('');
  const [tampilFoto, setTampilFoto] = useState(false);

  const lihatDaftar = punya('attendance_anomaly.view') || punya('attendance_anomaly.review') || punya('attendance_anomaly.approve');
  const muat = useCallback(async (lanjut?: string) => {
    try {
      const r = await api<{ items: Item[]; nextCursor: string | null }>(`/attendance/review?limit=20${tahap ? `&tahap=${tahap}` : ''}${lanjut ? `&cursor=${encodeURIComponent(lanjut)}` : ''}`);
      setDaftar((d) => (lanjut ? [...d, ...r.items] : r.items));
      setKursor(r.nextCursor);
    } catch (e) {
      setGalat((e as ApiError).message);
    }
  }, [tahap]);
  useEffect(() => {
    if (info && lihatDaftar) void muat();
  }, [info, muat]); // eslint-disable-line react-hooks/exhaustive-deps

  async function bukaDetail(id: string, jagaPesan = false) {
    if (!jagaPesan) {
      setGalat(null);
      setSukses(null);
    }
    setTampilFoto(false);
    try {
      setBuka(await api<Detail>(`/attendance/review/${id}`));
      setAlasan('');
      setPutusan('');
      setPerangkat('');
    } catch (e) {
      setGalat((e as ApiError).message);
    }
  }
  async function kirim(e: FormEvent, jalur: string, body: unknown, pesan: string) {
    e.preventDefault();
    if (!info || !buka) return;
    setGalat(null);
    setSukses(null);
    try {
      await api(`/attendance/${jalur}`, { method: 'POST', csrf: info.csrfToken, body });
      setSukses(pesan);
      await muat();
      await bukaDetail(buka.id, true); // pesan sukses tidak boleh terhapus oleh pemuatan ulang rincian
    } catch (err) {
      setGalat((err as ApiError).message);
    }
  }

  return (
    <Halaman judul="Tinjauan absensi">
      <Galat pesan={galatSesi ?? galat} />
      <Sukses pesan={sukses} />
      {info && !lihatDaftar ? <Galat pesan="Anda tidak memiliki izin untuk meninjau absensi." /> : null}
      <p className="bantuan">Tinjauan dua langkah: pemeriksa memeriksa, lalu pemutus (orang berbeda) memutuskan. Rekaman asli tidak diubah.</p>
      <Pilihan id="tahap" label="Tahap" required={false} value={tahap} onChange={setTahap} opsi={[{ nilai: 'MENUNGGU_PERIKSA', teks: 'Menunggu pemeriksaan' }, { nilai: 'MENUNGGU_PUTUSAN', teks: 'Menunggu putusan' }, { nilai: 'SELESAI', teks: 'Selesai' }]} />
      {daftar.map((x) => (
        <div className="butir" key={x.id}>
          <h3>{x.workerName}</h3>
          <p>
            {LABEL_JENIS_ABSEN[x.kind] ?? x.kind} · {formatTanggalIso(x.shiftDate)} · {x.locationName ?? '-'}
          </p>
          <p>
            <Lencana status={x.tahap} /> {LABEL_TAHAP[x.tahap] ?? x.tahap}
          </p>
          <p className="bantuan">{x.flags.map((f) => LABEL_FLAG[f] ?? f).join(', ') || 'Tanpa catatan'}</p>
          <div className="aksi">
            <button className="tombol-sekunder" type="button" onClick={() => void bukaDetail(x.id)}>
              Buka rincian
            </button>
          </div>
        </div>
      ))}
      {daftar.length === 0 && info && lihatDaftar ? <p>Tidak ada rekaman yang perlu ditinjau.</p> : null}
      {kursor ? (
        <button className="tombol-sekunder" type="button" onClick={() => void muat(kursor)}>
          Muat lebih banyak
        </button>
      ) : null}

      {buka ? (
        <section className="kartu" aria-label="Rincian rekaman">
          <h3>{buka.workerName}</h3>
          <p>
            {LABEL_JENIS_ABSEN[buka.kind] ?? buka.kind} · {formatWaktuWib(buka.occurredAt)}
          </p>
          <p className="bantuan">
            Jarak ke titik: {buka.distanceM ?? '-'} m · akurasi GPS: {buka.accuracyM ?? '-'} m · perangkat: {buka.deviceStatus ?? '-'}
          </p>
          {buka.reviews.map((r) => (
            <p key={r.stage} className="bantuan">
              {r.stage === 'PERIKSA' ? 'Pemeriksaan' : `Putusan ${r.decision}`}: {r.reason}
            </p>
          ))}
          {buka.selfie && punya('selfie.view') ? (
            buka.selfie.available ? (
              tampilFoto ? (
                // Selfie hanya lewat API berizin dan diaudit pada setiap akses; tanpa cache.
                // eslint-disable-next-line @next/next/no-img-element
                <img className="foto-tinjau" src={`/api/attendance/records/${buka.id}/selfie`} alt="Selfie absensi" />
              ) : (
                <button className="tombol-sekunder" type="button" onClick={() => setTampilFoto(true)}>
                  Tampilkan selfie (diaudit)
                </button>
              )
            ) : (
              <p className="bantuan">Selfie sudah dihapus sesuai kebijakan retensi.</p>
            )
          ) : null}
          {buka.selfie?.legalHold ? <p className="bantuan">Selfie ditahan (legal hold).</p> : null}
          {buka.tahap === 'MENUNGGU_PERIKSA' && punya('attendance_anomaly.review') ? (
            <form onSubmit={(e) => kirim(e, `review/${buka.id}/check`, { reason: alasan }, 'Pemeriksaan dicatat.')}>
              <AreaTeks id="alasan-periksa" label="Catatan pemeriksaan" value={alasan} onChange={setAlasan} maxLength={500} baris={3} />
              <button className="tombol" type="submit">
                Catat pemeriksaan
              </button>
            </form>
          ) : null}
          {buka.tahap === 'MENUNGGU_PUTUSAN' && punya('attendance_anomaly.approve') ? (
            <form onSubmit={(e) => kirim(e, `review/${buka.id}/decide`, { decision: putusan, reason: alasan, ...(perangkat ? { device: perangkat } : {}) }, 'Putusan dicatat.')}>
              <Pilihan id="putusan" label="Putusan" value={putusan} onChange={setPutusan} opsi={[{ nilai: 'DISETUJUI', teks: 'Setujui' }, { nilai: 'DITOLAK', teks: 'Tolak' }]} />
              {buka.deviceStatus === 'PERLU_VERIFIKASI' ? (
                <Pilihan id="perangkat" label="Perangkat baru" required={false} value={perangkat} onChange={setPerangkat} opsi={[{ nilai: 'SETUJUI', teks: 'Setujui perangkat' }, { nilai: 'TOLAK', teks: 'Tolak perangkat' }]} />
              ) : null}
              <AreaTeks id="alasan-putus" label="Alasan putusan" value={alasan} onChange={setAlasan} maxLength={500} baris={3} />
              <button className="tombol" type="submit">
                Simpan putusan
              </button>
            </form>
          ) : null}
          {buka.selfie && buka.selfie.available && punya('attendance_anomaly.approve') ? (
            <form onSubmit={(e) => kirim(e, `records/${buka.id}/selfie/hold`, { hold: !buka.selfie?.legalHold, reason: alasan }, buka.selfie?.legalHold ? 'Legal hold dicabut.' : 'Legal hold diterapkan.')}>
              <AreaTeks id="alasan-hold" label="Alasan legal hold" value={alasan} onChange={setAlasan} maxLength={500} baris={2} />
              <button className="tombol-sekunder" type="submit">
                {buka.selfie.legalHold ? 'Cabut legal hold' : 'Tahan selfie (legal hold)'}
              </button>
            </form>
          ) : null}
        </section>
      ) : null}
      <Link className="tombol-sekunder" href="/staff">
        Kembali
      </Link>
    </Halaman>
  );
}
