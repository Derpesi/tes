'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Galat, Halaman, Kolom, Lencana, Sukses } from '../../../../components/ui';
import { ApiError, api } from '../../../../lib/api';
import { formatTanggalIso } from '../../../../lib/format';
import { useStaff } from '../../../../lib/staff';

interface Rekanan { id: string; name: string; city: string | null; status: string }
interface Kontak { id: string; name: string; roleTitle: string | null; phone: string | null; isPrimary: boolean; status: string }
interface Lokasi { id: string; name: string; latitude: number | null; longitude: number | null; geofenceRadiusM: number; status: string }
interface Kontrak { id: string; contractNumber: string; serviceType: string; startDate: string; endDate: string; status: string; createdBy: string }

export default function DetailRekanan() {
  const { id } = useParams<{ id: string }>();
  const { info, galat: galatSesi, punya } = useStaff();
  const [rekanan, setRekanan] = useState<Rekanan | null>(null);
  const [kontak, setKontak] = useState<Kontak[]>([]);
  const [lokasi, setLokasi] = useState<Lokasi[]>([]);
  const [kontrak, setKontrak] = useState<Kontrak[]>([]);
  const [galat, setGalat] = useState<string | null>(null);
  const [sukses, setSukses] = useState<string | null>(null);
  const [f, setF] = useState({ kontakNama: '', kontakTelp: '', lokNama: '', lokLat: '', lokLng: '', lokRadius: '100', ktrNomor: '', ktrJenis: '', ktrMulai: '', ktrAkhir: '' });
  const set = (k: keyof typeof f) => (v: string) => setF((x) => ({ ...x, [k]: v }));

  const muat = useCallback(async () => {
    try {
      setRekanan(await api<Rekanan>(`/partners/${id}`));
      setKontak((await api<{ items: Kontak[] }>(`/partners/${id}/contacts`)).items);
      setLokasi((await api<{ items: Lokasi[] }>(`/partners/${id}/locations`)).items);
      try {
        setKontrak((await api<{ items: Kontrak[] }>(`/partner-contracts?partnerId=${id}`)).items);
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 403)) throw e; // tanpa izin kontrak: bagian disembunyikan
      }
    } catch (e) {
      setGalat((e as ApiError).message);
    }
  }, [id]);
  useEffect(() => {
    if (info) void muat();
  }, [info]); // eslint-disable-line react-hooks/exhaustive-deps

  async function kirim(e: FormEvent, path: string, body: unknown, pesan: string, reset: Partial<typeof f>) {
    e.preventDefault();
    if (!info) return;
    setGalat(null);
    setSukses(null);
    try {
      await api(path, { method: 'POST', csrf: info.csrfToken, body });
      setF((x) => ({ ...x, ...reset }));
      await muat();
      setSukses(pesan);
    } catch (err) {
      setGalat((err as ApiError).message);
    }
  }
  const angka = (v: string) => (v.trim() === '' ? undefined : Number(v.replace(',', '.')));

  async function ubahKontrak(kontrakId: string, aksi: 'activate' | 'end' | 'cancel', pesan: string) {
    if (!info) return;
    setGalat(null);
    setSukses(null);
    try {
      await api(`/partner-contracts/${kontrakId}/${aksi}`, { method: 'POST', csrf: info.csrfToken, body: {} });
      await muat();
      setSukses(pesan);
    } catch (err) {
      setGalat((err as ApiError).message);
    }
  }

  return (
    <Halaman judul={rekanan?.name ?? 'Detail rekanan'}>
      <Galat pesan={galatSesi ?? galat} />
      <Sukses pesan={sukses} />
      {rekanan ? (
        <p>
          {rekanan.city ?? 'Kota belum diisi'} <Lencana status={rekanan.status} />
        </p>
      ) : null}

      <section className="bagian" aria-labelledby="h-kontak">
        <h3 id="h-kontak">Kontak (PIC)</h3>
        {kontak.map((k) => (
          <article className="butir" key={k.id}>
            <p>
              <strong>{k.name}</strong> {k.isPrimary ? '(utama)' : ''}
            </p>
            <p className="bantuan">{[k.roleTitle, k.phone].filter(Boolean).join(' · ') || 'Tanpa keterangan'}</p>
          </article>
        ))}
        {punya('partner.create') ? (
          <details className="lipat">
            <summary>Tambah kontak</summary>
            <form onSubmit={(e) => kirim(e, `/partners/${id}/contacts`, { name: f.kontakNama, ...(f.kontakTelp ? { phone: f.kontakTelp } : {}) }, 'Kontak ditambahkan.', { kontakNama: '', kontakTelp: '' })}>
              <Kolom id="kontak-nama" label="Nama kontak" value={f.kontakNama} onChange={set('kontakNama')} maxLength={100} />
              <Kolom id="kontak-telp" label="Telepon (opsional)" value={f.kontakTelp} onChange={set('kontakTelp')} inputMode="numeric" required={false} maxLength={25} />
              <button className="tombol" type="submit">
                Simpan kontak
              </button>
            </form>
          </details>
        ) : null}
      </section>

      <section className="bagian" aria-labelledby="h-lokasi">
        <h3 id="h-lokasi">Lokasi kerja</h3>
        {lokasi.map((l) => (
          <article className="butir" key={l.id}>
            <p>
              <strong>{l.name}</strong> <Lencana status={l.status} />
            </p>
            <p className="bantuan">{l.latitude !== null ? `Koordinat ${l.latitude}, ${l.longitude} · radius ${l.geofenceRadiusM} m` : `Koordinat belum diisi · radius ${l.geofenceRadiusM} m`}</p>
          </article>
        ))}
        {punya('partner.create') ? (
          <details className="lipat">
            <summary>Tambah lokasi</summary>
            <form
              onSubmit={(e) =>
                kirim(e, `/partners/${id}/locations`, { name: f.lokNama, latitude: angka(f.lokLat), longitude: angka(f.lokLng), geofenceRadiusM: angka(f.lokRadius) }, 'Lokasi ditambahkan.', { lokNama: '', lokLat: '', lokLng: '' })
              }
            >
              <Kolom id="lok-nama" label="Nama lokasi" value={f.lokNama} onChange={set('lokNama')} maxLength={150} />
              <Kolom id="lok-lat" label="Lintang (opsional)" value={f.lokLat} onChange={set('lokLat')} inputMode="decimal" required={false} bantuan="Contoh: -6.175392. Isi bersama bujur." />
              <Kolom id="lok-lng" label="Bujur (opsional)" value={f.lokLng} onChange={set('lokLng')} inputMode="decimal" required={false} />
              <Kolom id="lok-radius" label="Radius (meter)" value={f.lokRadius} onChange={set('lokRadius')} inputMode="numeric" bantuan="20–1000 meter." />
              <button className="tombol" type="submit">
                Simpan lokasi
              </button>
            </form>
          </details>
        ) : null}
      </section>

      {punya('partner_contract.view') ? (
        <section className="bagian" aria-labelledby="h-kontrak">
          <h3 id="h-kontrak">Kontrak layanan</h3>
          {kontrak.map((k) => (
            <article className="butir" key={k.id}>
              <p>
                <strong>{k.contractNumber}</strong> <Lencana status={k.status} />
              </p>
              <p className="bantuan">
                {k.serviceType} · {formatTanggalIso(k.startDate)} – {formatTanggalIso(k.endDate)}
              </p>
              <div className="aksi">
                {k.status === 'DRAFT' && punya('partner_contract.approve') && k.createdBy !== info?.user.id ? (
                  <button className="tombol" type="button" onClick={() => ubahKontrak(k.id, 'activate', 'Kontrak diaktifkan.')}>
                    Aktifkan kontrak {k.contractNumber}
                  </button>
                ) : null}
                {k.status === 'AKTIF' && punya('partner_contract.approve') ? (
                  <button className="tombol-sekunder" type="button" onClick={() => ubahKontrak(k.id, 'end', 'Kontrak diakhiri.')}>
                    Akhiri kontrak {k.contractNumber}
                  </button>
                ) : null}
                {k.status === 'DRAFT' && punya('partner_contract.update') ? (
                  <button className="tombol-sekunder" type="button" onClick={() => ubahKontrak(k.id, 'cancel', 'Kontrak dibatalkan.')}>
                    Batalkan kontrak {k.contractNumber}
                  </button>
                ) : null}
              </div>
            </article>
          ))}
          {punya('partner_contract.create') ? (
            <details className="lipat">
              <summary>Tambah kontrak</summary>
              <form onSubmit={(e) => kirim(e, '/partner-contracts', { partnerId: id, contractNumber: f.ktrNomor, serviceType: f.ktrJenis, startDate: f.ktrMulai, endDate: f.ktrAkhir }, 'Kontrak dibuat sebagai DRAFT dan menunggu aktivasi Direktur.', { ktrNomor: '', ktrJenis: '', ktrMulai: '', ktrAkhir: '' })}>
                <Kolom id="ktr-nomor" label="Nomor kontrak" value={f.ktrNomor} onChange={set('ktrNomor')} maxLength={80} />
                <Kolom id="ktr-jenis" label="Jenis layanan" value={f.ktrJenis} onChange={set('ktrJenis')} maxLength={100} />
                <Kolom id="ktr-mulai" label="Tanggal mulai" type="date" value={f.ktrMulai} onChange={set('ktrMulai')} />
                <Kolom id="ktr-akhir" label="Tanggal berakhir" type="date" value={f.ktrAkhir} onChange={set('ktrAkhir')} />
                <button className="tombol" type="submit">
                  Simpan kontrak
                </button>
              </form>
            </details>
          ) : null}
        </section>
      ) : null}
      <Link className="tautan" href="/staff/rekanan">
        Kembali ke daftar rekanan
      </Link>
    </Halaman>
  );
}
