'use client';

import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Galat, Halaman, Kolom, Lencana, Pilihan } from '../../../components/ui';
import { ApiError, api } from '../../../lib/api';
import { formatWaktuWib } from '../../../lib/absensi';
import { useStaff } from '../../../lib/staff';

interface Entri { id: string; occurredAt: string; action: string; category: string; actorId: string | null; companyId: string | null; objectType: string | null; objectId: string | null; detail: Record<string, unknown> | null }
const LABEL_KATEGORI: Record<string, string> = { TEKNIS: 'Teknis', TRANSAKSI: 'Transaksi', OPERASIONAL: 'Operasional' };

export default function PenampilAudit() {
  const { info, galat: galatSesi, punya } = useStaff();
  const [items, setItems] = useState<Entri[]>([]);
  const [kursor, setKursor] = useState<string | null>(null);
  const [galat, setGalat] = useState<string | null>(null);
  const [sudah, setSudah] = useState(false);
  const [f, setF] = useState({ aksi: '', kategori: '', objek: '' });

  const muat = useCallback(async (lanjut?: string) => {
    setGalat(null);
    const q = new URLSearchParams({ limit: '30' });
    if (f.aksi.trim()) q.set('action', f.aksi.trim());
    if (f.kategori) q.set('kategori', f.kategori);
    if (f.objek.trim()) q.set('objectType', f.objek.trim());
    if (lanjut) q.set('cursor', lanjut);
    try {
      const r = await api<{ items: Entri[]; nextCursor: string | null }>(`/audit-logs?${q.toString()}`);
      setItems((d) => (lanjut ? [...d, ...r.items] : r.items));
      setKursor(r.nextCursor);
      setSudah(true);
    } catch (e) {
      setGalat((e as ApiError).message);
    }
  }, [f]);
  useEffect(() => {
    if (info && punya('audit_log.view')) void muat();
  }, [info]); // eslint-disable-line react-hooks/exhaustive-deps

  function cari(e: FormEvent) {
    e.preventDefault();
    void muat();
  }

  return (
    <Halaman judul="Audit log">
      <Galat pesan={galatSesi ?? galat} />
      {info && !punya('audit_log.view') ? <Galat pesan="Anda tidak memiliki izin untuk melihat audit log." /> : null}
      <p className="bantuan">Audit bersifat hanya-tambah. Anda hanya melihat kategori dan perusahaan sesuai peran dan scope. Rincian tidak memuat data pribadi.</p>
      <form onSubmit={cari}>
        <Kolom id="aksi" label="Awalan aksi" required={false} value={f.aksi} onChange={(v) => setF({ ...f, aksi: v })} bantuan="Contoh: payroll. atau auth.login" maxLength={100} />
        <Pilihan id="kategori" label="Kategori" required={false} value={f.kategori} onChange={(v) => setF({ ...f, kategori: v })} opsi={Object.entries(LABEL_KATEGORI).map(([nilai, teks]) => ({ nilai, teks }))} />
        <Kolom id="objek" label="Jenis objek" required={false} value={f.objek} onChange={(v) => setF({ ...f, objek: v })} maxLength={60} />
        <button className="tombol" type="submit">
          Tampilkan
        </button>
      </form>
      {sudah && items.length === 0 ? <p>Tidak ada entri audit yang cocok.</p> : null}
      {items.map((x) => (
        <div className="butir" key={x.id}>
          <h3>{x.action}</h3>
          <p>
            <Lencana status={x.category === 'TEKNIS' ? 'diverifikasi' : x.category === 'TRANSAKSI' ? 'menunggu' : 'aktif'} /> {LABEL_KATEGORI[x.category] ?? x.category}
          </p>
          <p className="bantuan">{formatWaktuWib(x.occurredAt)}</p>
          {x.objectType ? <p className="bantuan">Objek: {x.objectType}{x.objectId ? ` · ${x.objectId.slice(0, 36)}` : ''}</p> : null}
          {x.actorId ? <p className="bantuan">Aktor: {x.actorId.slice(0, 8)}…</p> : <p className="bantuan">Aktor: sistem</p>}
          {x.detail && Object.keys(x.detail).length ? (
            <details className="lipat">
              <summary>Rincian</summary>
              <p className="rahasia">{JSON.stringify(x.detail)}</p>
            </details>
          ) : null}
        </div>
      ))}
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
