'use client';

import Link from 'next/link';
import { FormEvent, useState } from 'react';
import { Galat, Halaman, Kolom, Sukses } from '../../../components/ui';
import { ApiError, api } from '../../../lib/api';

export default function LupaPassword() {
  const [email, setEmail] = useState('');
  const [pesan, setPesan] = useState<string | null>(null);
  const [galat, setGalat] = useState<string | null>(null);
  const [sibuk, setSibuk] = useState(false);

  async function kirim(e: FormEvent) {
    e.preventDefault();
    setGalat(null);
    setSibuk(true);
    try {
      const r = await api<{ pesan: string }>('/auth/staff/password/forgot', { method: 'POST', body: { email } });
      setPesan(r.pesan);
    } catch (err) {
      setGalat((err as ApiError).message);
    } finally {
      setSibuk(false);
    }
  }

  return (
    <Halaman judul="Lupa kata sandi">
      <Galat pesan={galat} />
      <Sukses pesan={pesan} />
      <form onSubmit={kirim}>
        <Kolom id="email" label="Email staff" type="email" value={email} onChange={setEmail} autoComplete="username" inputMode="email" />
        <button className="tombol" type="submit" disabled={sibuk}>
          {sibuk ? 'Mengirim…' : 'Kirim tautan atur ulang'}
        </button>
      </form>
      <Link className="tautan" href="/staff/masuk">
        Kembali ke halaman masuk
      </Link>
    </Halaman>
  );
}
