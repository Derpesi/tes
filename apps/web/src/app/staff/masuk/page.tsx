'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FormEvent, useState } from 'react';
import { Galat, Halaman, Kolom } from '../../../components/ui';
import { ApiError, api } from '../../../lib/api';

export default function MasukStaff() {
  const router = useRouter();
  const [langkah, setLangkah] = useState<'KREDENSIAL' | 'MFA'>('KREDENSIAL');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [kode, setKode] = useState('');
  const [csrf, setCsrf] = useState('');
  const [galat, setGalat] = useState<string | null>(null);
  const [sibuk, setSibuk] = useState(false);

  async function kirimKredensial(e: FormEvent) {
    e.preventDefault();
    setGalat(null);
    setSibuk(true);
    try {
      const r = await api<{ nextStep: 'MFA' | 'ENROLL_MFA'; csrfToken: string }>('/auth/staff/login', { method: 'POST', body: { email, password } });
      setPassword('');
      setCsrf(r.csrfToken);
      if (r.nextStep === 'ENROLL_MFA') router.push('/staff/daftar-mfa');
      else setLangkah('MFA');
    } catch (err) {
      setGalat((err as ApiError).message);
    } finally {
      setSibuk(false);
    }
  }

  async function kirimKode(e: FormEvent) {
    e.preventDefault();
    setGalat(null);
    setSibuk(true);
    try {
      await api('/auth/staff/mfa/verify', { method: 'POST', body: { code: kode }, csrf });
      router.push('/staff');
    } catch (err) {
      setGalat((err as ApiError).message);
      setKode('');
    } finally {
      setSibuk(false);
    }
  }

  return (
    <Halaman judul={langkah === 'KREDENSIAL' ? 'Masuk sebagai staff' : 'Verifikasi dua langkah'}>
      <Galat pesan={galat} />
      {langkah === 'KREDENSIAL' ? (
        <form onSubmit={kirimKredensial}>
          <Kolom id="email" label="Email" type="email" value={email} onChange={setEmail} autoComplete="username" inputMode="email" />
          <Kolom id="password" label="Kata sandi" type="password" value={password} onChange={setPassword} autoComplete="current-password" />
          <button className="tombol" type="submit" disabled={sibuk}>
            {sibuk ? 'Memeriksa…' : 'Lanjut'}
          </button>
          <Link className="tautan" href="/staff/lupa-password">
            Lupa kata sandi?
          </Link>
        </form>
      ) : (
        <form onSubmit={kirimKode}>
          <p>Masukkan kode 6 digit dari aplikasi autentikator Anda, atau kode pemulihan.</p>
          <Kolom id="kode" label="Kode verifikasi" value={kode} onChange={setKode} autoComplete="one-time-code" inputMode="numeric" maxLength={32} />
          <button className="tombol" type="submit" disabled={sibuk}>
            {sibuk ? 'Memeriksa…' : 'Masuk'}
          </button>
        </form>
      )}
    </Halaman>
  );
}
