'use client';

import { useRouter } from 'next/navigation';
import QRCode from 'qrcode';
import { FormEvent, useEffect, useRef, useState } from 'react';
import { Galat, Halaman, Kolom } from '../../../components/ui';
import { ApiError, ambilSesi, api } from '../../../lib/api';

export default function DaftarMfa() {
  const router = useRouter();
  const mulai = useRef(false);
  const [csrf, setCsrf] = useState('');
  const [secret, setSecret] = useState('');
  const [qr, setQr] = useState('');
  const [kode, setKode] = useState('');
  const [kodePemulihan, setKodePemulihan] = useState<string[] | null>(null);
  const [tersimpan, setTersimpan] = useState(false);
  const [galat, setGalat] = useState<string | null>(null);
  const [sibuk, setSibuk] = useState(false);

  useEffect(() => {
    if (mulai.current) return;
    mulai.current = true;
    (async () => {
      try {
        const s = await ambilSesi();
        if (!s || s.state !== 'MENUNGGU_ENROLL_MFA') return router.replace('/staff/masuk');
        setCsrf(s.csrfToken);
        const r = await api<{ secret: string; otpauthUri: string }>('/auth/staff/mfa/enroll/start', { method: 'POST', csrf: s.csrfToken });
        setSecret(r.secret);
        setQr(await QRCode.toDataURL(r.otpauthUri, { margin: 1, width: 220 }));
      } catch (e) {
        setGalat((e as ApiError).message);
      }
    })();
  }, [router]);

  async function konfirmasi(e: FormEvent) {
    e.preventDefault();
    setGalat(null);
    setSibuk(true);
    try {
      const r = await api<{ recoveryCodes: string[]; csrfToken: string }>('/auth/staff/mfa/enroll/confirm', { method: 'POST', body: { code: kode }, csrf });
      setCsrf(r.csrfToken);
      setKodePemulihan(r.recoveryCodes);
    } catch (err) {
      setGalat((err as ApiError).message);
      setKode('');
    } finally {
      setSibuk(false);
    }
  }

  if (kodePemulihan) {
    return (
      <Halaman judul="Simpan kode pemulihan">
        <p>Kode pemulihan dipakai bila Anda kehilangan ponsel. Setiap kode hanya berlaku sekali dan <strong>hanya ditampilkan sekarang</strong>. Simpan di tempat aman.</p>
        <ul className="daftar-kode" aria-label="Kode pemulihan">
          {kodePemulihan.map((k) => (
            <li key={k}>{k}</li>
          ))}
        </ul>
        <div className="cek">
          <input id="tersimpan" type="checkbox" checked={tersimpan} onChange={(e) => setTersimpan(e.target.checked)} />
          <label htmlFor="tersimpan">Saya sudah menyimpan kode pemulihan ini.</label>
        </div>
        <button className="tombol" type="button" disabled={!tersimpan} onClick={() => router.push('/staff')}>
          Lanjut
        </button>
      </Halaman>
    );
  }

  return (
    <Halaman judul="Aktifkan verifikasi dua langkah">
      <Galat pesan={galat} />
      <ol>
        <li>Pasang aplikasi autentikator (mis. Google Authenticator atau Aegis) di ponsel Anda.</li>
        <li>Pindai kode QR di bawah, atau masukkan kunci manual.</li>
        <li>Masukkan kode 6 digit yang muncul.</li>
      </ol>
      {qr ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="qr" src={qr} width={220} height={220} alt="Kode QR untuk aplikasi autentikator" />
      ) : galat ? null : (
        <p role="status">Menyiapkan kode QR…</p>
      )}
      {secret ? (
        <p>
          Kunci manual: <span className="rahasia">{secret}</span>
        </p>
      ) : null}
      <form onSubmit={konfirmasi}>
        <Kolom id="kode" label="Kode 6 digit" value={kode} onChange={setKode} autoComplete="one-time-code" inputMode="numeric" maxLength={6} />
        <button className="tombol" type="submit" disabled={sibuk || !secret}>
          {sibuk ? 'Memeriksa…' : 'Aktifkan'}
        </button>
      </form>
    </Halaman>
  );
}
