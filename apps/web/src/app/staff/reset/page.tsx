'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { FormEvent, Suspense, useEffect, useState } from 'react';
import { Galat, Halaman, Kolom, Sukses } from '../../../components/ui';
import { ApiError, api } from '../../../lib/api';

function FormReset() {
  const params = useSearchParams();
  // Token dibaca SEKALI ke state awal. Setelah dibuang dari URL, useSearchParams ikut berubah; token tidak boleh ikut hilang.
  const [token] = useState<string | null>(() => params.get('token'));
  const [password, setPassword] = useState('');
  const [ulang, setUlang] = useState('');
  const [pesan, setPesan] = useState<string | null>(null);
  const [galat, setGalat] = useState<string | null>(null);
  const [sibuk, setSibuk] = useState(false);

  useEffect(() => {
    if (token) window.history.replaceState(null, '', '/staff/reset'); // buang token dari URL/riwayat
  }, [token]);

  async function kirim(e: FormEvent) {
    e.preventDefault();
    setGalat(null);
    if (password.length < 12) return setGalat('Kata sandi minimal 12 karakter.');
    if (password !== ulang) return setGalat('Pengulangan kata sandi tidak sama.');
    setSibuk(true);
    try {
      const r = await api<{ pesan: string }>('/auth/staff/password/reset', { method: 'POST', body: { token, password } });
      setPesan(r.pesan);
    } catch (err) {
      setGalat((err as ApiError).message);
    } finally {
      setSibuk(false);
    }
  }

  if (pesan) {
    return (
      <>
        <Sukses pesan={pesan} />
        <Link className="tombol" href="/staff/masuk">
          Masuk
        </Link>
      </>
    );
  }
  if (!token) return <Galat pesan="Tautan atur ulang tidak valid. Minta tautan baru." />;
  return (
    <form onSubmit={kirim}>
      <Galat pesan={galat} />
      <Kolom id="password" label="Kata sandi baru" type="password" value={password} onChange={setPassword} autoComplete="new-password" bantuan="Minimal 12 karakter." />
      <Kolom id="ulang" label="Ulangi kata sandi" type="password" value={ulang} onChange={setUlang} autoComplete="new-password" />
      <button className="tombol" type="submit" disabled={sibuk}>
        {sibuk ? 'Menyimpan…' : 'Simpan kata sandi'}
      </button>
    </form>
  );
}

export default function Reset() {
  return (
    <Halaman judul="Atur ulang kata sandi">
      <Suspense fallback={<p role="status">Memuat…</p>}>
        <FormReset />
      </Suspense>
    </Halaman>
  );
}
