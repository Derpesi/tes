'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { FormEvent, Suspense, useEffect, useState } from 'react';
import { Galat, Halaman, Kolom } from '../../components/ui';
import { ApiError, api } from '../../lib/api';

function FormUndangan() {
  const router = useRouter();
  const params = useSearchParams();
  // Token dibaca SEKALI ke state awal. Setelah dibuang dari URL, useSearchParams ikut berubah; token tidak boleh ikut hilang.
  const [token] = useState<string | null>(() => params.get('token'));
  const [password, setPassword] = useState('');
  const [ulang, setUlang] = useState('');
  const [galat, setGalat] = useState<string | null>(null);
  const [sibuk, setSibuk] = useState(false);

  useEffect(() => {
    if (token) window.history.replaceState(null, '', '/undangan'); // buang token dari URL/riwayat
  }, [token]);

  async function kirim(e: FormEvent) {
    e.preventDefault();
    setGalat(null);
    if (password.length < 12) return setGalat('Kata sandi minimal 12 karakter.');
    if (password !== ulang) return setGalat('Pengulangan kata sandi tidak sama.');
    setSibuk(true);
    try {
      await api('/auth/staff/invitation/accept', { method: 'POST', body: { token, password } });
      router.push('/staff/daftar-mfa');
    } catch (err) {
      setGalat((err as ApiError).message);
    } finally {
      setSibuk(false);
    }
  }

  if (!token) return <Galat pesan="Tautan undangan tidak valid. Minta undangan baru kepada administrator." />;
  return (
    <form onSubmit={kirim}>
      <p>Buat kata sandi khusus aplikasi ini. Jangan memakai kata sandi Gmail Anda.</p>
      <Galat pesan={galat} />
      <Kolom id="password" label="Kata sandi baru" type="password" value={password} onChange={setPassword} autoComplete="new-password" bantuan="Minimal 12 karakter. Kalimat panjang lebih aman daripada simbol acak." />
      <Kolom id="ulang" label="Ulangi kata sandi" type="password" value={ulang} onChange={setUlang} autoComplete="new-password" />
      <button className="tombol" type="submit" disabled={sibuk}>
        {sibuk ? 'Menyimpan…' : 'Lanjut'}
      </button>
    </form>
  );
}

export default function Undangan() {
  return (
    <Halaman judul="Terima undangan">
      <Suspense fallback={<p role="status">Memuat…</p>}>
        <FormUndangan />
      </Suspense>
    </Halaman>
  );
}
