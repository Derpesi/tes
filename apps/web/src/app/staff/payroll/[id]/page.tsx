'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { AreaTeks, Galat, Halaman, Kolom, Lencana, Pilihan, Sukses } from '../../../../components/ui';
import { ApiError, api } from '../../../../lib/api';
import { formatTanggalIso } from '../../../../lib/format';
import { LABEL_JENIS_REKAP, LABEL_KOMPONEN, LABEL_STATUS_REKAP, izinJenis } from '../../../../lib/payroll';
import { useStaff } from '../../../../lib/staff';

interface Komponen { id: string; kind: string; name: string; amount: string }
interface Baris {
  id: string; personId: string; workerName: string; source: string; daysPresent: number; daysAbsent: number; daysPermit: number; daysSick: number; daysLeave: number;
  lateCount: number; earlyLeaveCount: number; pendingCount: number; hoursWorked: string; overtimeHours: string; note: string | null; components: Komponen[];
  subtotals: { TUNJANGAN: string; POTONGAN: string; INSENTIF: string };
}
interface Rekap {
  id: string; periodId: string; kind: string; label: string; startDate: string; endDate: string; versionNo: number; recapNumber: string | null; correctionReason: string | null; status: string;
  pendingCount: number; lineCount: number; totals: { TUNJANGAN: string; POTONGAN: string; INSENTIF: string }; lines: Baris[]; snapshotHash: string | null;
}
interface Versi { id: string; versionNo: number; recapNumber: string | null; status: string }
interface Ekspor { id: string; format: string; rowCount: number; createdAt: string }

export default function DetailRekap() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { info, galat: galatSesi, punya } = useStaff();
  const [r, setR] = useState<Rekap | null>(null);
  const [versi, setVersi] = useState<Versi[]>([]);
  const [ekspor, setEkspor] = useState<Ekspor[]>([]);
  const [galat, setGalat] = useState<string | null>(null);
  const [sukses, setSukses] = useState<string | null>(null);
  const [alasan, setAlasan] = useState('');
  const [k, setK] = useState({ baris: '', kind: '', nama: '', nominal: '' });
  const [manual, setManual] = useState({ personId: '', nama: '' });
  const [m, setM] = useState({ baris: '', cuti: '', lembur: '', catatan: '' });

  const muat = useCallback(async () => {
    try {
      const d = await api<Rekap>(`/payroll/recaps/${id}`);
      setR(d);
      const [p, e] = await Promise.all([api<{ versions: Versi[] }>(`/payroll/periods/${d.periodId}`), api<{ items: Ekspor[] }>(`/payroll/recaps/${id}/exports`)]);
      setVersi(p.versions);
      setEkspor(e.items);
    } catch (e) {
      setGalat((e as ApiError).message);
    }
  }, [id]);
  useEffect(() => {
    if (info) void muat();
  }, [info, muat]);

  async function kirim(jalur: string, method: 'POST' | 'PUT' | 'DELETE', body: unknown, pesan: string, setelah?: () => void) {
    if (!info) return;
    setGalat(null);
    setSukses(null);
    try {
      await api(`/payroll/recaps/${id}${jalur}`, { method, csrf: info.csrfToken, body });
      setelah?.();
      await muat();
      setSukses(pesan);
    } catch (e) {
      setGalat((e as ApiError).message);
    }
  }
  async function koreksi(e: FormEvent) {
    e.preventDefault();
    if (!info) return;
    setGalat(null);
    try {
      const baru = await api<{ id: string }>(`/payroll/recaps/${id}/correct`, { method: 'POST', csrf: info.csrfToken, body: { reason: alasan } });
      router.push(`/staff/payroll/${baru.id}`);
    } catch (err) {
      setGalat((err as ApiError).message);
    }
  }

  const kind = r?.kind ?? 'PARTNER';
  const bisaSunting = !!r && r.status === 'DRAFT' && (punya(izinJenis(kind, 'create')) || punya(izinJenis(kind, 'update')));
  const bisaReview = !!r && punya(izinJenis(kind, 'review'));
  const bisaEkspor = !!r && punya(izinJenis(kind, 'export')) && ['DISETUJUI', 'DIFINALISASI'].includes(r.status);
  const terbaru = !!r && versi[0]?.id === r.id;
  const bisaKoreksi = !!r && terbaru && ['DISETUJUI', 'DIFINALISASI'].includes(r.status) && punya(izinJenis(kind, 'create'));

  return (
    <Halaman judul={r ? `Rekap ${r.label}` : 'Rekap payroll'}>
      <Galat pesan={galatSesi ?? galat} />
      <Sukses pesan={sukses} />
      {r ? (
        <>
          <div className="kartu">
            <p>
              <Lencana status={r.status} /> <strong>{LABEL_STATUS_REKAP[r.status] ?? r.status}</strong> · versi {r.versionNo}
              {r.recapNumber ? ` (${r.recapNumber})` : ''}
            </p>
            <p className="bantuan">
              Rekap {LABEL_JENIS_REKAP[r.kind] ?? r.kind} · {formatTanggalIso(r.startDate)} – {formatTanggalIso(r.endDate)}
            </p>
            {r.correctionReason ? <p className="bantuan">Alasan koreksi: {r.correctionReason}</p> : null}
            <p className="bantuan">
              Subtotal masukan — Tunjangan {r.totals.TUNJANGAN} · Potongan {r.totals.POTONGAN} · Insentif {r.totals.INSENTIF}. Ini bukan gaji: tidak ada perhitungan gaji, PPh 21, BPJS, atau slip.
            </p>
            {r.pendingCount > 0 ? <p className="bantuan">Ada {r.pendingCount} rekaman absensi menunggu verifikasi pada snapshot ini.</p> : null}
            <p className="bantuan">Pembuat, pemeriksa, penyetuju, dan finalisator harus orang berbeda; sistem menegakkannya.</p>
          </div>

          <div className="aksi">
            {bisaSunting && r.kind === 'PARTNER' ? (
              <button className="tombol-sekunder" type="button" onClick={() => void kirim('/pull', 'POST', undefined, 'Absensi ditarik. Komponen yang sudah diisi dipertahankan.')}>
                Tarik absensi
              </button>
            ) : null}
            {r.status === 'DRAFT' && bisaReview ? (
              <button className="tombol" type="button" onClick={() => void kirim('/verify', 'POST', undefined, 'Rekap diverifikasi.')}>
                Verifikasi rekap
              </button>
            ) : null}
            {r.status === 'DIVERIFIKASI' && punya('payroll_approval.approve') ? (
              <button className="tombol" type="button" onClick={() => void kirim('/approve', 'POST', undefined, 'Rekap disetujui.')}>
                Setujui rekap
              </button>
            ) : null}
            {r.status === 'DISETUJUI' && punya('payroll_approval.finalize') ? (
              <button className="tombol" type="button" onClick={() => void kirim('/finalize', 'POST', undefined, 'Rekap difinalisasi.')}>
                Finalisasi rekap
              </button>
            ) : null}
          </div>

          {r.status === 'DIVERIFIKASI' && bisaReview ? (
            <form onSubmit={(e) => { e.preventDefault(); void kirim('/return', 'POST', { reason: alasan }, 'Rekap dikembalikan ke draf.', () => setAlasan('')); }} className="kartu">
              <AreaTeks id="alasan-kembali" label="Alasan mengembalikan ke draf" value={alasan} onChange={setAlasan} maxLength={500} baris={2} />
              <button className="tombol-sekunder" type="submit">
                Kembalikan ke draf
              </button>
            </form>
          ) : null}

          {bisaEkspor ? (
            <div className="kartu" aria-label="Ekspor">
              <h3>Ekspor</h3>
              <div className="aksi">
                {(['csv', 'xlsx', 'pdf'] as const).map((f) => (
                  <a key={f} className="tombol-sekunder" href={`/api/payroll/recaps/${r.id}/export.${f}`}>
                    Ekspor {f === 'pdf' ? 'PDF' : f}
                  </a>
                ))}
              </div>
              <p className="bantuan">Setiap ekspor dicatat. Kolom bersifat sementara menunggu format final dari pemilik.</p>
            </div>
          ) : null}

          {r.lines.map((l) => (
            <div className="butir" key={l.id}>
              <h3>{l.workerName}</h3>
              <p className="baris-angka">
                <span>Hadir {l.daysPresent}</span><span>Tidak hadir {l.daysAbsent}</span><span>Izin {l.daysPermit}</span><span>Sakit {l.daysSick}</span><span>Cuti {l.daysLeave}</span>
                <span>Terlambat {l.lateCount}</span><span>Pulang cepat {l.earlyLeaveCount}</span><span>Jam kerja {l.hoursWorked}</span><span>Lembur {l.overtimeHours}</span>
              </p>
              {l.note ? <p className="bantuan">Catatan: {l.note}</p> : null}
              {l.components.map((c) => (
                <div className="komponen" key={c.id}>
                  <span>
                    {LABEL_KOMPONEN[c.kind] ?? c.kind}: {c.name}
                  </span>
                  <span>
                    {c.amount}{' '}
                    {bisaSunting ? (
                      <button className="tautan" type="button" onClick={() => void kirim(`/lines/${l.id}/components/${c.id}`, 'DELETE', undefined, 'Komponen dihapus.')}>
                        Hapus {c.name}
                      </button>
                    ) : null}
                  </span>
                </div>
              ))}
              <p className="bantuan">
                Subtotal — Tunjangan {l.subtotals.TUNJANGAN} · Potongan {l.subtotals.POTONGAN} · Insentif {l.subtotals.INSENTIF}
              </p>
              {bisaSunting ? (
                <div className="aksi">
                  <button className="tombol-sekunder" type="button" onClick={() => setK({ baris: l.id, kind: '', nama: '', nominal: '' })}>
                    Tambah komponen untuk {l.workerName}
                  </button>
                  <button className="tombol-sekunder" type="button" onClick={() => setM({ baris: l.id, cuti: String(l.daysLeave), lembur: l.overtimeHours, catatan: l.note ?? '' })}>
                    Ubah cuti, lembur, catatan {l.workerName}
                  </button>
                  {r.kind === 'INTERNAL' ? (
                    <button className="tombol-sekunder" type="button" onClick={() => window.confirm(`Hapus baris ${l.workerName}?`) && void kirim(`/lines/${l.id}`, 'DELETE', undefined, 'Baris dihapus.')}>
                      Hapus baris {l.workerName}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ))}
          {r.lines.length === 0 ? <p>Belum ada baris. {r.kind === 'PARTNER' ? 'Tarik absensi untuk mengisi baris.' : 'Tambahkan baris manual.'}</p> : null}

          {bisaSunting && k.baris ? (
            <form onSubmit={(e) => { e.preventDefault(); void kirim(`/lines/${k.baris}/components`, 'POST', { kind: k.kind, name: k.nama, amount: k.nominal }, 'Komponen ditambahkan.', () => setK({ baris: '', kind: '', nama: '', nominal: '' })); }} className="kartu">
              <h3>Komponen baru</h3>
              <Pilihan id="k-kind" label="Jenis komponen" value={k.kind} onChange={(v) => setK({ ...k, kind: v })} opsi={Object.entries(LABEL_KOMPONEN).map(([nilai, teks]) => ({ nilai, teks }))} />
              <Kolom id="k-nama" label="Nama komponen" value={k.nama} onChange={(v) => setK({ ...k, nama: v })} maxLength={80} />
              <Kolom id="k-nominal" label="Nominal" inputMode="decimal" value={k.nominal} onChange={(v) => setK({ ...k, nominal: v })} bantuan="Angka desimal dengan titik, maksimal 2 angka di belakang koma (contoh 1500000.50)." />
              <button className="tombol" type="submit">
                Simpan komponen
              </button>
            </form>
          ) : null}
          {bisaSunting && m.baris ? (
            <form onSubmit={(e) => { e.preventDefault(); void kirim(`/lines/${m.baris}`, 'PUT', { daysLeave: Number(m.cuti), overtimeHours: m.lembur, note: m.catatan || null }, 'Masukan disimpan.', () => setM({ baris: '', cuti: '', lembur: '', catatan: '' })); }} className="kartu">
              <h3>Masukan manual</h3>
              <Kolom id="m-cuti" label="Hari cuti" inputMode="numeric" value={m.cuti} onChange={(v) => setM({ ...m, cuti: v })} />
              <Kolom id="m-lembur" label="Jam lembur (masukan, tidak dihitung)" inputMode="decimal" value={m.lembur} onChange={(v) => setM({ ...m, lembur: v })} />
              <Kolom id="m-catatan" label="Catatan" value={m.catatan} onChange={(v) => setM({ ...m, catatan: v })} required={false} maxLength={300} />
              <button className="tombol" type="submit">
                Simpan masukan
              </button>
            </form>
          ) : null}
          {bisaSunting && r.kind === 'INTERNAL' ? (
            <details className="lipat">
              <summary>Tambah baris manual</summary>
              <form onSubmit={(e) => { e.preventDefault(); void kirim('/lines', 'POST', { personId: manual.personId, workerName: manual.nama }, 'Baris ditambahkan.', () => setManual({ personId: '', nama: '' })); }}>
                <Kolom id="b-orang" label="ID orang (UUID)" value={manual.personId} onChange={(v) => setManual({ ...manual, personId: v })} />
                <Kolom id="b-nama" label="Nama" value={manual.nama} onChange={(v) => setManual({ ...manual, nama: v })} maxLength={150} />
                <button className="tombol" type="submit">
                  Tambah baris
                </button>
              </form>
            </details>
          ) : null}

          {bisaKoreksi ? (
            <details className="lipat">
              <summary>Koreksi resmi (versi baru)</summary>
              <form onSubmit={koreksi}>
                <p className="bantuan">Membuat versi baru bernomor sebagai salinan draf. Versi ini tetap utuh sampai versi baru disetujui.</p>
                <AreaTeks id="alasan-koreksi" label="Alasan koreksi" value={alasan} onChange={setAlasan} maxLength={500} baris={3} />
                <button className="tombol" type="submit">
                  Buat versi koreksi
                </button>
              </form>
            </details>
          ) : null}

          <section className="bagian" aria-labelledby="h-versi">
            <h3 id="h-versi">Versi</h3>
            {versi.map((v) => (
              <p key={v.id}>
                <Link className="tautan" href={`/staff/payroll/${v.id}`}>
                  Versi {v.versionNo}
                  {v.recapNumber ? ` (${v.recapNumber})` : ''}
                </Link>{' '}
                <Lencana status={v.status} />
              </p>
            ))}
          </section>
          {ekspor.length ? (
            <section className="bagian" aria-labelledby="h-eks">
              <h3 id="h-eks">Riwayat ekspor</h3>
              {ekspor.map((e) => (
                <p className="bantuan" key={e.id}>
                  {e.format} · {e.rowCount} baris · {new Date(e.createdAt).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB
                </p>
              ))}
            </section>
          ) : null}
        </>
      ) : galat || galatSesi ? null : (
        <p role="status">Memuat…</p>
      )}
      <Link className="tombol-sekunder" href="/staff/payroll">
        Kembali ke daftar periode
      </Link>
    </Halaman>
  );
}
