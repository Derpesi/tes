'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Galat, Halaman, Lencana } from '../../components/ui';
import { LABEL_FLAG, LABEL_STATUS_ABSEN } from '../../lib/absensi';
import { ApiError, InfoSesi, ambilSesi, api, unggah } from '../../lib/api';

interface Hasil { id: string; kind: string; status: string; message: string; flags: string[]; rejectReason: string | null }
interface Lokasi { latitude: number; longitude: number; akurasi: number }

const POLA_KODE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BATAS_FOTO = 280 * 1024; // di bawah batas server 300 KB
const acak = () => crypto.randomUUID().replace(/-/g, '');

/** Id perangkat acak per browser (bukan data pribadi). Server hanya menyimpan HMAC-nya. */
function idPerangkat(): string {
  const kunci = 'hris_perangkat';
  let v = window.localStorage.getItem(kunci);
  if (!v) {
    v = acak();
    window.localStorage.setItem(kunci, v);
  }
  return v;
}

const PESAN_GPS: Record<number, string> = {
  1: 'Izin lokasi ditolak. Aktifkan izin lokasi untuk situs ini di pengaturan browser, lalu coba lagi.',
  2: 'Lokasi tidak dapat ditentukan. Pindah ke area terbuka dan pastikan GPS aktif.',
  3: 'Waktu habis saat mencari lokasi. Coba lagi.',
};

function Absen() {
  const router = useRouter();
  const kode = useSearchParams().get('t') ?? '';
  const kodeSah = POLA_KODE.test(kode);
  const [sesi, setSesi] = useState<InfoSesi | null>(null);
  const [galat, setGalat] = useState<string | null>(null);
  const [jenis, setJenis] = useState<'MASUK' | 'PULANG'>('MASUK');
  const [lokasi, setLokasi] = useState<Lokasi | null>(null);
  const [mencari, setMencari] = useState(false);
  // null = belum diketahui. Selfie ditiadakan sementara di server (ABSENSI_SELFIE=off, bawaan); UI mengikuti keputusan server.
  const [selfieAktif, setSelfieAktif] = useState<boolean | null>(null);
  const [kameraAktif, setKameraAktif] = useState(false);
  const [foto, setFoto] = useState<Blob | null>(null);
  const [fotoUrl, setFotoUrl] = useState<string | null>(null);
  const [kunci, setKunci] = useState(() => acak());
  const [mengirim, setMengirim] = useState(false);
  const [hasil, setHasil] = useState<Hasil | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const aliran = useRef<MediaStream | null>(null);

  useEffect(() => {
    ambilSesi()
      .then((s) => {
        if (!s) return router.replace(`/masuk?returnTo=${encodeURIComponent(`/absen${kode ? `?t=${kode}` : ''}`)}`);
        if (s.realm !== 'member') return router.replace('/staff');
        setSesi(s);
        return api<{ selfieAktif: boolean }>('/member/attendance/today').then((h) => setSelfieAktif(h.selfieAktif));
      })
      .catch((e: ApiError) => setGalat(e.message));
  }, [router, kode]);

  const hentikanKamera = useCallback(() => {
    aliran.current?.getTracks().forEach((t) => t.stop());
    aliran.current = null;
    setKameraAktif(false);
  }, []);
  useEffect(() => () => hentikanKamera(), [hentikanKamera]);
  // Menyambungkan aliran kamera setelah elemen <video> dirender (deterministik, tanpa bergantung pada penjadwalan frame).
  useEffect(() => {
    if (kameraAktif && video.current && aliran.current) {
      video.current.srcObject = aliran.current;
      void video.current.play().catch(() => undefined);
    }
  }, [kameraAktif]);
  useEffect(() => () => { if (fotoUrl) URL.revokeObjectURL(fotoUrl); }, [fotoUrl]);

  function ambilLokasi() {
    setGalat(null);
    if (!('geolocation' in navigator)) return setGalat('Perangkat Anda tidak mendukung lokasi. Gunakan browser terbaru.');
    setMencari(true);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setLokasi({ latitude: p.coords.latitude, longitude: p.coords.longitude, akurasi: p.coords.accuracy });
        setKunci(acak());
        setMencari(false);
      },
      (e) => {
        setGalat(PESAN_GPS[e.code] ?? 'Lokasi tidak dapat diambil.');
        setMencari(false);
      },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 },
    );
  }

  async function bukaKamera() {
    setGalat(null);
    if (!navigator.mediaDevices?.getUserMedia) return setGalat('Kamera tidak tersedia di browser ini. Gunakan browser terbaru lewat HTTPS.');
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 640 } }, audio: false });
      aliran.current = s;
      setKameraAktif(true);
    } catch {
      setGalat('Kamera tidak dapat dibuka. Izinkan akses kamera untuk situs ini, lalu coba lagi. Selfie wajib diambil langsung dari kamera.');
    }
  }

  async function ambilFoto() {
    const v = video.current;
    if (!v || !v.videoWidth) return setGalat('Kamera belum siap. Tunggu sebentar lalu coba lagi.');
    const sisi = Math.min(640, Math.min(v.videoWidth, v.videoHeight));
    const c = document.createElement('canvas');
    c.width = sisi;
    c.height = sisi;
    const ctx = c.getContext('2d');
    if (!ctx) return setGalat('Foto tidak dapat diproses di perangkat ini.');
    const sx = (v.videoWidth - sisi) / 2;
    const sy = (v.videoHeight - sisi) / 2;
    ctx.drawImage(v, sx, sy, sisi, sisi, 0, 0, sisi, sisi);
    let blob: Blob | null = null;
    for (const q of [0.8, 0.7, 0.6, 0.5, 0.4]) {
      blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', q));
      if (blob && blob.size <= BATAS_FOTO) break;
    }
    if (!blob || blob.size > BATAS_FOTO) return setGalat('Ukuran foto terlalu besar. Coba lagi di tempat yang lebih terang.');
    hentikanKamera();
    setFoto(blob);
    setFotoUrl(URL.createObjectURL(blob));
    setKunci(acak());
  }

  async function kirim() {
    if (!sesi || !lokasi || selfieAktif === null || (selfieAktif && !foto)) return;
    setGalat(null);
    setMengirim(true);
    const f = new FormData();
    f.set('code', kode);
    f.set('kind', jenis);
    f.set('latitude', String(lokasi.latitude));
    f.set('longitude', String(lokasi.longitude));
    f.set('accuracy', String(Math.round(lokasi.akurasi)));
    f.set('clientTime', new Date().toISOString());
    f.set('deviceId', idPerangkat());
    f.set('idempotencyKey', kunci); // pengiriman ulang dengan kunci sama tidak membuat rekaman ganda
    if (selfieAktif && foto) f.set('selfie', foto, 'selfie.jpg');
    try {
      setHasil(await unggah<Hasil>('/member/attendance', f, sesi.csrfToken));
    } catch (e) {
      const err = e as ApiError;
      setGalat(
        err.status === 0
          ? 'Tidak ada koneksi internet. Absensi hanya dapat dilakukan saat online dan tidak ada absensi offline. Cari sinyal lalu coba lagi; bila tetap gagal, hubungi petugas absensi untuk koreksi.'
          : err.message,
      );
    } finally {
      setMengirim(false);
    }
  }

  function ulang() {
    setHasil(null);
    setFoto(null);
    setFotoUrl(null);
    setKunci(acak());
  }

  if (!kodeSah) {
    return (
      <Halaman judul="Absensi">
        <div className="kartu">
          <p>Pindai QR di lokasi kerja menggunakan kamera ponsel Anda. Tautan yang terbuka akan membawa Anda ke halaman ini.</p>
          <p className="bantuan">Kode titik absensi tidak ditemukan pada alamat ini.</p>
        </div>
        <Link className="tombol-sekunder" href="/saya">
          Kembali ke akun saya
        </Link>
      </Halaman>
    );
  }

  return (
    <Halaman judul="Absensi">
      <Galat pesan={galat} />
      {!sesi ? (
        galat ? null : <p role="status">Memuat…</p>
      ) : hasil ? (
        <div className="kartu" role="status" aria-live="polite">
          <p>
            <Lencana status={hasil.status} /> <strong>{LABEL_STATUS_ABSEN[hasil.status] ?? hasil.status}</strong>
          </p>
          <p>{hasil.message}</p>
          {hasil.flags.length ? <p className="bantuan">Catatan: {hasil.flags.map((f) => LABEL_FLAG[f] ?? f).join(', ')}.</p> : null}
          {hasil.status === 'DITOLAK' ? (
            <button className="tombol" type="button" onClick={ulang}>
              Coba lagi
            </button>
          ) : null}
          <Link className="tombol-sekunder" href="/saya/absensi">
            Lihat riwayat absensi
          </Link>
        </div>
      ) : (
        <div style={{ counterReset: 'langkah' }}>
          <fieldset className="kartu langkah" style={{ border: '1px solid #d5dbe5' }}>
            <legend>Jenis absen</legend>
            <div className="pilihan-jenis">
              {(['MASUK', 'PULANG'] as const).map((j) => (
                <label key={j} htmlFor={`jenis-${j}`}>
                  <input id={`jenis-${j}`} type="radio" name="jenis" value={j} checked={jenis === j} onChange={() => setJenis(j)} />
                  <span>{j === 'MASUK' ? 'Absen masuk' : 'Absen pulang'}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <section className="kartu langkah" aria-labelledby="h-lokasi">
            <h3 id="h-lokasi">Lokasi</h3>
            {lokasi ? <p className="bantuan">Lokasi terambil (akurasi ±{Math.round(lokasi.akurasi)} m).</p> : <p className="bantuan">Izinkan akses lokasi saat diminta browser.</p>}
            <button className="tombol-sekunder" type="button" onClick={ambilLokasi} disabled={mencari}>
              {mencari ? 'Mencari lokasi…' : lokasi ? 'Ambil ulang lokasi' : 'Ambil lokasi saya'}
            </button>
          </section>
          {selfieAktif ? (
          <section className="kartu langkah" aria-labelledby="h-selfie">
            <h3 id="h-selfie">Selfie</h3>
            <p className="bantuan">Selfie diambil langsung dari kamera dan hanya dilihat petugas berwenang. Tidak ada pengenalan wajah otomatis.</p>
            {kameraAktif ? (
              <>
                <video ref={video} className="kamera" playsInline muted aria-label="Pratinjau kamera" />
                <button className="tombol" type="button" onClick={ambilFoto}>
                  Ambil foto
                </button>
              </>
            ) : fotoUrl ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className="kamera" src={fotoUrl} alt="Selfie yang akan dikirim" />
                <button className="tombol-sekunder" type="button" onClick={() => { setFoto(null); setFotoUrl(null); void bukaKamera(); }}>
                  Ulangi foto
                </button>
              </>
            ) : (
              <button className="tombol-sekunder" type="button" onClick={bukaKamera}>
                Buka kamera
              </button>
            )}
          </section>
          ) : null}
          <button className="tombol" type="button" onClick={kirim} disabled={!lokasi || selfieAktif === null || (selfieAktif && !foto) || mengirim}>
            {mengirim ? 'Mengirim…' : `Kirim absen ${jenis === 'MASUK' ? 'masuk' : 'pulang'}`}
          </button>
          <p className="bantuan">Waktu absen dicatat oleh server (WIB), bukan jam perangkat. Absensi hanya dapat dilakukan saat online.</p>
        </div>
      )}
    </Halaman>
  );
}

export default function Halaman_Absen() {
  return (
    <Suspense fallback={<p role="status">Memuat…</p>}>
      <Absen />
    </Suspense>
  );
}
