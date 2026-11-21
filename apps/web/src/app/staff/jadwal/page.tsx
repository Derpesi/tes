'use client';

import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Galat, Halaman, Kolom, Lencana, Pilihan, Sukses } from '../../../components/ui';
import { NAMA_HARI } from '../../../lib/absensi';
import { ApiError, api } from '../../../lib/api';
import { formatTanggalIso } from '../../../lib/format';
import { useStaff } from '../../../lib/staff';

interface Shift { id: string; name: string; kind: string; startTime: string; endTime: string; crossesMidnight: boolean; lateToleranceMin: number; earlyToleranceMin: number; status: string }
interface Jadwal { id: string; placementId: string; shiftId: string; workDays: number[]; validFrom: string; validTo: string | null }
interface Libur { id: string; date: string; scope: string; name: string }
interface Penempatan { id: string; workerName: string | null; locationName: string }
interface Rekanan { id: string; name: string }
interface Lokasi { id: string; name: string }

export default function JadwalStaff() {
  const { info, galat: galatSesi, punya } = useStaff();
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [jadwal, setJadwal] = useState<Jadwal[]>([]);
  const [libur, setLibur] = useState<Libur[]>([]);
  const [penempatan, setPenempatan] = useState<Penempatan[]>([]);
  const [rekanan, setRekanan] = useState<Rekanan[]>([]);
  const [lokasi, setLokasi] = useState<Lokasi[]>([]);
  const [galat, setGalat] = useState<string | null>(null);
  const [sukses, setSukses] = useState<string | null>(null);
  const [s, setS] = useState({ nama: '', jenis: 'FIXED', mulai: '07:00', selesai: '15:00', terlambat: '15', awal: '30' });
  const [j, setJ] = useState({ penempatan: '', shift: '', mulai: '', akhir: '' });
  const [hari, setHari] = useState<number[]>([1, 2, 3, 4, 5]);
  const [l, setL] = useState({ tanggal: '', cakupan: 'NASIONAL', nama: '', rekanan: '', lokasi: '' });

  const muat = useCallback(async () => {
    try {
      const [a, b, c] = await Promise.all([
        api<{ items: Shift[] }>('/attendance/shifts?limit=100'),
        api<{ items: Jadwal[] }>('/attendance/schedules?limit=50'),
        api<{ items: Libur[] }>('/attendance/holidays?limit=50'),
      ]);
      setShifts(a.items);
      setJadwal(b.items);
      setLibur(c.items);
    } catch (e) {
      setGalat((e as ApiError).message);
    }
  }, []);
  useEffect(() => {
    if (!info || !punya('placement.view')) return;
    void muat();
    api<{ items: Penempatan[] }>('/placements?status=AKTIF&limit=100').then((r) => setPenempatan(r.items), () => undefined);
    api<{ items: Rekanan[] }>('/partners?status=AKTIF&limit=100').then((r) => setRekanan(r.items), () => undefined);
  }, [info]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!l.rekanan) return setLokasi([]);
    api<{ items: Lokasi[] }>(`/partners/${l.rekanan}/locations`).then((r) => setLokasi(r.items), () => setLokasi([]));
  }, [l.rekanan]);

  async function kirim(e: FormEvent, jalur: string, method: 'POST' | 'PATCH' | 'DELETE', body: unknown, pesan: string, reset?: () => void) {
    e.preventDefault();
    if (!info) return;
    setGalat(null);
    setSukses(null);
    try {
      await api(jalur, { method, csrf: info.csrfToken, body });
      reset?.();
      await muat();
      setSukses(pesan);
    } catch (err) {
      setGalat((err as ApiError).message);
    }
  }
  const namaShift = (id: string) => shifts.find((x) => x.id === id)?.name ?? 'Shift';
  const namaPenempatan = (id: string) => {
    const p = penempatan.find((x) => x.id === id);
    return p ? `${p.workerName ?? 'Tanpa nama'} · ${p.locationName}` : 'Penempatan';
  };

  return (
    <Halaman judul="Shift, jadwal, dan hari libur">
      <Galat pesan={galatSesi ?? galat} />
      <Sukses pesan={sukses} />
      {info && !punya('placement.view') ? <Galat pesan="Anda tidak memiliki izin untuk melihat jadwal." /> : null}

      <section className="bagian" aria-labelledby="h-shift">
        <h3 id="h-shift">Shift</h3>
        {punya('placement.create') ? (
          <details className="lipat">
            <summary>Tambah shift</summary>
            <form onSubmit={(e) => kirim(e, '/attendance/shifts', 'POST', { name: s.nama, kind: s.jenis, startTime: s.mulai, endTime: s.selesai, lateToleranceMin: Number(s.terlambat), earlyToleranceMin: Number(s.awal) }, 'Shift ditambahkan.', () => setS((x) => ({ ...x, nama: '' })))}>
              <Kolom id="s-nama" label="Nama shift" value={s.nama} onChange={(v) => setS({ ...s, nama: v })} maxLength={80} />
              <Pilihan id="s-jenis" label="Jenis" value={s.jenis} onChange={(v) => setS({ ...s, jenis: v })} opsi={[{ nilai: 'FIXED', teks: 'Tetap' }, { nilai: 'FLEXIBLE', teks: 'Fleksibel (tanpa penanda terlambat)' }]} />
              <Kolom id="s-mulai" label="Jam mulai" type="time" value={s.mulai} onChange={(v) => setS({ ...s, mulai: v })} />
              <Kolom id="s-selesai" label="Jam selesai" type="time" value={s.selesai} onChange={(v) => setS({ ...s, selesai: v })} bantuan="Jam selesai lebih awal dari jam mulai berarti shift melewati tengah malam; tanggal shift = tanggal mulai." />
              <Kolom id="s-terlambat" label="Toleransi terlambat (menit)" type="number" inputMode="numeric" value={s.terlambat} onChange={(v) => setS({ ...s, terlambat: v })} />
              <Kolom id="s-awal" label="Toleransi awal (menit)" type="number" inputMode="numeric" value={s.awal} onChange={(v) => setS({ ...s, awal: v })} />
              <button className="tombol" type="submit">
                Simpan shift
              </button>
            </form>
          </details>
        ) : null}
        {shifts.map((x) => (
          <div className="butir" key={x.id}>
            <h3>{x.name}</h3>
            <p>
              <Lencana status={x.status} /> {x.startTime}–{x.endTime} WIB{x.crossesMidnight ? ' (melewati tengah malam)' : ''}
            </p>
            <p className="bantuan">
              Toleransi terlambat {x.lateToleranceMin} menit, awal {x.earlyToleranceMin} menit{x.kind === 'FLEXIBLE' ? ' · fleksibel' : ''}
            </p>
            {punya('placement.update') ? (
              <div className="aksi">
                <button className="tombol-sekunder" type="button" onClick={(e) => void kirim(e as unknown as FormEvent, `/attendance/shifts/${x.id}`, 'PATCH', { status: x.status === 'AKTIF' ? 'NONAKTIF' : 'AKTIF' }, 'Status shift diubah.')}>
                  {x.status === 'AKTIF' ? 'Nonaktifkan' : 'Aktifkan'}
                </button>
              </div>
            ) : null}
          </div>
        ))}
        {shifts.length === 0 && info ? <p>Belum ada shift.</p> : null}
      </section>

      <section className="bagian" aria-labelledby="h-jadwal">
        <h3 id="h-jadwal">Jadwal kerja per penempatan</h3>
        {punya('placement.update') ? (
          <details className="lipat">
            <summary>Tambah jadwal</summary>
            <form onSubmit={(e) => kirim(e, '/attendance/schedules', 'POST', { placementId: j.penempatan, shiftId: j.shift, workDays: hari, validFrom: j.mulai, ...(j.akhir ? { validTo: j.akhir } : {}) }, 'Jadwal ditambahkan.')}>
              <Pilihan id="j-p" label="Penempatan aktif" value={j.penempatan} onChange={(v) => setJ({ ...j, penempatan: v })} opsi={penempatan.map((p) => ({ nilai: p.id, teks: `${p.workerName ?? 'Tanpa nama'} · ${p.locationName}` }))} />
              <Pilihan id="j-s" label="Shift" value={j.shift} onChange={(v) => setJ({ ...j, shift: v })} opsi={shifts.filter((x) => x.status === 'AKTIF').map((x) => ({ nilai: x.id, teks: x.name }))} />
              <fieldset className="kolom" style={{ border: 0, padding: 0 }}>
                <legend className="bantuan">Hari kerja</legend>
                <div className="hari-kerja">
                  {NAMA_HARI.map((n, i) => (
                    <label key={n} htmlFor={`hari-${i + 1}`}>
                      <input id={`hari-${i + 1}`} type="checkbox" checked={hari.includes(i + 1)} onChange={(e) => setHari((h) => (e.target.checked ? [...h, i + 1].sort() : h.filter((x) => x !== i + 1)))} /> {n}
                    </label>
                  ))}
                </div>
              </fieldset>
              <Kolom id="j-mulai" label="Berlaku dari" type="date" value={j.mulai} onChange={(v) => setJ({ ...j, mulai: v })} />
              <Kolom id="j-akhir" label="Berlaku sampai (opsional)" type="date" value={j.akhir} onChange={(v) => setJ({ ...j, akhir: v })} required={false} />
              <button className="tombol" type="submit">
                Simpan jadwal
              </button>
            </form>
          </details>
        ) : null}
        {jadwal.map((x) => (
          <div className="butir" key={x.id}>
            <h3>{namaPenempatan(x.placementId)}</h3>
            <p>
              {namaShift(x.shiftId)} · {x.workDays.map((d) => NAMA_HARI[d - 1]).join(', ')}
            </p>
            <p className="bantuan">
              {formatTanggalIso(x.validFrom)}
              {x.validTo ? ` – ${formatTanggalIso(x.validTo)}` : ' – seterusnya'}
            </p>
            {punya('placement.update') ? (
              <div className="aksi">
                <button className="tombol-sekunder" type="button" onClick={(e) => window.confirm('Hapus jadwal ini?') && void kirim(e as unknown as FormEvent, `/attendance/schedules/${x.id}`, 'DELETE', undefined, 'Jadwal dihapus.')}>
                  Hapus jadwal
                </button>
              </div>
            ) : null}
          </div>
        ))}
        {jadwal.length === 0 && info ? <p>Belum ada jadwal.</p> : null}
      </section>

      <section className="bagian" aria-labelledby="h-libur">
        <h3 id="h-libur">Hari libur</h3>
        {punya('placement.update') ? (
          <details className="lipat">
            <summary>Tambah hari libur</summary>
            <form onSubmit={(e) => kirim(e, '/attendance/holidays', 'POST', { date: l.tanggal, scope: l.cakupan, name: l.nama, ...(l.cakupan === 'LOKASI' ? { locationId: l.lokasi } : {}) }, 'Hari libur ditambahkan.', () => setL((x) => ({ ...x, tanggal: '', nama: '' })))}>
              <Kolom id="l-tgl" label="Tanggal" type="date" value={l.tanggal} onChange={(v) => setL({ ...l, tanggal: v })} />
              <Kolom id="l-nama" label="Nama hari libur" value={l.nama} onChange={(v) => setL({ ...l, nama: v })} maxLength={120} />
              <Pilihan id="l-cakupan" label="Cakupan" value={l.cakupan} onChange={(v) => setL({ ...l, cakupan: v, rekanan: '', lokasi: '' })} opsi={[{ nilai: 'NASIONAL', teks: 'Nasional' }, { nilai: 'PERUSAHAAN', teks: 'Perusahaan' }, { nilai: 'LOKASI', teks: 'Satu lokasi' }]} />
              {l.cakupan === 'LOKASI' ? (
                <>
                  <Pilihan id="l-rek" label="Rekanan" value={l.rekanan} onChange={(v) => setL({ ...l, rekanan: v, lokasi: '' })} opsi={rekanan.map((r) => ({ nilai: r.id, teks: r.name }))} />
                  <Pilihan id="l-lok" label="Lokasi" value={l.lokasi} onChange={(v) => setL({ ...l, lokasi: v })} opsi={lokasi.map((x) => ({ nilai: x.id, teks: x.name }))} />
                </>
              ) : null}
              <button className="tombol" type="submit">
                Simpan hari libur
              </button>
            </form>
          </details>
        ) : null}
        {libur.map((x) => (
          <div className="butir" key={x.id}>
            <h3>{x.name}</h3>
            <p className="bantuan">
              {formatTanggalIso(x.date)} · {x.scope === 'NASIONAL' ? 'Nasional' : x.scope === 'PERUSAHAAN' ? 'Perusahaan' : 'Satu lokasi'}
            </p>
            {punya('placement.update') ? (
              <div className="aksi">
                <button className="tombol-sekunder" type="button" onClick={(e) => window.confirm('Hapus hari libur ini?') && void kirim(e as unknown as FormEvent, `/attendance/holidays/${x.id}`, 'DELETE', undefined, 'Hari libur dihapus.')}>
                  Hapus
                </button>
              </div>
            ) : null}
          </div>
        ))}
        {libur.length === 0 && info ? <p>Belum ada hari libur.</p> : null}
      </section>
      <Link className="tombol-sekunder" href="/staff">
        Kembali
      </Link>
    </Halaman>
  );
}
