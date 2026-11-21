'use client';

import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Galat, Halaman, Kolom, Pilihan, Sukses } from '../../../components/ui';
import { ApiError, api, unggah } from '../../../lib/api';
import { LABEL_STATUS_MEMBER, useMember } from '../../../lib/member';

interface Profil { status: string; fullName: string | null; nik: string | null; birthPlace: string | null; birthDate: string | null; gender: string | null; address: string | null; city: string | null; province: string | null; phone: string | null; education: string | null; emergencyContactName: string | null; emergencyContactPhone: string | null; reviewNote: string | null }
interface Dokumen { id: string; kind: string; originalFilename: string }
const PENDIDIKAN = ['SD', 'SMP', 'SMA/SMK', 'D1-D3', 'D4/S1', 'S2', 'S3'];
const JENIS = [{ nilai: 'KTP', teks: 'KTP' }, { nilai: 'FOTO_DIRI', teks: 'Foto diri' }, { nilai: 'IJAZAH', teks: 'Ijazah' }, { nilai: 'LAINNYA', teks: 'Dokumen lain' }];
const KOSONG = { fullName: '', nik: '', birthPlace: '', birthDate: '', gender: '', address: '', city: '', province: '', phone: '', education: '', emergencyContactName: '', emergencyContactPhone: '' };

export default function BiodataMember() {
  const { sesi, galat: galatSesi } = useMember();
  const [profil, setProfil] = useState<Profil | null>(null);
  const [dokumen, setDokumen] = useState<Dokumen[]>([]);
  const [f, setF] = useState(KOSONG);
  const [jenis, setJenis] = useState('KTP');
  const [galat, setGalat] = useState<string | null>(null);
  const [sukses, setSukses] = useState<string | null>(null);
  const set = (k: keyof typeof KOSONG) => (v: string) => setF((x) => ({ ...x, [k]: v }));
  const terkunci = profil ? !['TERDAFTAR', 'PROFIL_BELUM_LENGKAP', 'MENUNGGU_VERIFIKASI'].includes(profil.status) : false;

  const muat = useCallback(async () => {
    try {
      const p = await api<Profil>('/member/profile');
      setProfil(p);
      setF((x) => ({ ...x, fullName: p.fullName ?? '', birthPlace: p.birthPlace ?? '', birthDate: p.birthDate ? String(p.birthDate).slice(0, 10) : '', gender: p.gender ?? '', address: p.address ?? '', city: p.city ?? '', province: p.province ?? '', phone: p.phone ?? '', education: p.education ?? '', emergencyContactName: p.emergencyContactName ?? '', emergencyContactPhone: p.emergencyContactPhone ?? '' }));
      setDokumen((await api<{ items: Dokumen[] }>('/member/documents')).items);
    } catch (e) {
      setGalat((e as ApiError).message);
    }
  }, []);
  useEffect(() => {
    if (sesi) void muat();
  }, [sesi, muat]);

  async function simpan(e: FormEvent) {
    e.preventDefault();
    if (!sesi) return;
    setGalat(null);
    setSukses(null);
    const body: Record<string, string> = {};
    for (const [k, v] of Object.entries(f)) if (v.trim() !== '') body[k] = v.trim();
    try {
      await api('/member/profile', { method: 'PUT', csrf: sesi.csrfToken, body });
      setF((x) => ({ ...x, nik: '' }));
      await muat();
      setSukses('Biodata disimpan.');
    } catch (err) {
      setGalat((err as ApiError).message);
    }
  }

  async function kirimBerkas(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!sesi) return;
    setGalat(null);
    setSukses(null);
    const input = e.currentTarget.elements.namedItem('berkas') as HTMLInputElement;
    if (!input.files?.[0]) return setGalat('Pilih berkas terlebih dahulu');
    const data = new FormData();
    data.set('kind', jenis);
    data.set('berkas', input.files[0]);
    try {
      await unggah('/member/documents', data, sesi.csrfToken);
      input.value = '';
      await muat();
      setSukses('Dokumen diunggah.');
    } catch (err) {
      setGalat((err as ApiError).message);
    }
  }

  async function hapus(id: string) {
    if (!sesi) return;
    setGalat(null);
    setSukses(null);
    try {
      await api(`/member/documents/${id}`, { method: 'DELETE', csrf: sesi.csrfToken });
      await muat();
      setSukses('Dokumen dihapus.');
    } catch (err) {
      setGalat((err as ApiError).message);
    }
  }

  async function ajukan() {
    if (!sesi) return;
    setGalat(null);
    setSukses(null);
    try {
      await api('/member/profile/submit', { method: 'POST', csrf: sesi.csrfToken, body: {} });
      await muat();
      setSukses('Biodata diajukan. Menunggu verifikasi HRD.');
    } catch (err) {
      setGalat((err as ApiError).message);
    }
  }

  return (
    <Halaman judul="Biodata dan dokumen">
      <Galat pesan={galatSesi ?? galat} />
      <Sukses pesan={sukses} />
      {profil ? (
        <>
          <p>
            Status: <strong>{LABEL_STATUS_MEMBER[profil.status] ?? profil.status}</strong>
          </p>
          {profil.status === 'PROFIL_BELUM_LENGKAP' && profil.reviewNote ? (
            <div className="galat" role="alert">
              Catatan HRD: {profil.reviewNote}
            </div>
          ) : null}
          {terkunci ? <p className="bantuan">Data sudah terverifikasi. Hubungi HRD untuk mengubahnya.</p> : null}
          <form onSubmit={simpan}>
            <Kolom id="nama" label="Nama lengkap" value={f.fullName} onChange={set('fullName')} required={false} maxLength={150} />
            <Kolom id="nik" label="NIK (16 digit)" value={f.nik} onChange={set('nik')} required={false} inputMode="numeric" maxLength={16} bantuan={profil.nik ? `Tersimpan: ${profil.nik}. Isi hanya bila ingin mengganti.` : undefined} />
            <Kolom id="tempat" label="Tempat lahir" value={f.birthPlace} onChange={set('birthPlace')} required={false} maxLength={100} />
            <Kolom id="lahir" label="Tanggal lahir" type="date" value={f.birthDate} onChange={set('birthDate')} required={false} />
            <Pilihan id="gender" label="Jenis kelamin" value={f.gender} onChange={set('gender')} required={false} opsi={[{ nilai: 'L', teks: 'Laki-laki' }, { nilai: 'P', teks: 'Perempuan' }]} />
            <Kolom id="alamat" label="Alamat domisili" value={f.address} onChange={set('address')} required={false} maxLength={300} />
            <Kolom id="kota" label="Kota" value={f.city} onChange={set('city')} required={false} maxLength={100} />
            <Kolom id="provinsi" label="Provinsi" value={f.province} onChange={set('province')} required={false} maxLength={100} />
            <Kolom id="telepon" label="Nomor telepon" value={f.phone} onChange={set('phone')} required={false} inputMode="numeric" maxLength={25} />
            <Pilihan id="pendidikan" label="Pendidikan terakhir" value={f.education} onChange={set('education')} required={false} opsi={PENDIDIKAN.map((p) => ({ nilai: p, teks: p }))} />
            <Kolom id="darurat-nama" label="Nama kontak darurat" value={f.emergencyContactName} onChange={set('emergencyContactName')} required={false} maxLength={100} />
            <Kolom id="darurat-telp" label="Telepon kontak darurat" value={f.emergencyContactPhone} onChange={set('emergencyContactPhone')} required={false} inputMode="numeric" maxLength={25} />
            <button className="tombol" type="submit" disabled={terkunci}>
              Simpan biodata
            </button>
          </form>

          <section className="bagian" aria-labelledby="h-dokumen">
            <h3 id="h-dokumen">Dokumen identitas</h3>
            {dokumen.map((d) => (
              <article className="butir" key={d.id}>
                <p>
                  <strong>{JENIS.find((j) => j.nilai === d.kind)?.teks ?? d.kind}</strong>
                </p>
                <p className="bantuan">{d.originalFilename}</p>
                {!terkunci ? (
                  <button className="tombol-sekunder" type="button" onClick={() => hapus(d.id)}>
                    Hapus {d.originalFilename}
                  </button>
                ) : null}
              </article>
            ))}
            {!terkunci ? (
              <form onSubmit={kirimBerkas}>
                <Pilihan id="jenis" label="Jenis dokumen" value={jenis} onChange={setJenis} opsi={JENIS} />
                <div className="kolom">
                  <label htmlFor="berkas">Berkas (PDF, PNG, atau JPEG; maksimal 10 MB)</label>
                  <input id="berkas" name="berkas" type="file" accept="application/pdf,image/png,image/jpeg" />
                </div>
                <button className="tombol" type="submit">
                  Unggah dokumen
                </button>
              </form>
            ) : null}
          </section>

          {profil.status === 'PROFIL_BELUM_LENGKAP' ? (
            <button className="tombol" type="button" onClick={ajukan}>
              Ajukan verifikasi
            </button>
          ) : null}
        </>
      ) : galat || galatSesi ? null : (
        <p role="status">Memuat…</p>
      )}
      <Link className="tautan" href="/saya">
        Kembali
      </Link>
    </Halaman>
  );
}
