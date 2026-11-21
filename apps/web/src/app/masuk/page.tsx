import { Galat, Halaman } from '../../components/ui';
import { pesanGalatMasuk } from '../../lib/teks';

/** Hanya jalur relatif satu-origin; backend memvalidasi ulang (cegah open redirect). */
const returnToAman = (v?: string) => (v && v.startsWith('/') && !v.startsWith('//') && !v.includes('\\') && v.length <= 200 ? v : null);

export default async function Masuk({ searchParams }: { searchParams: Promise<{ galat?: string; returnTo?: string }> }) {
  const { galat, returnTo } = await searchParams;
  const tujuan = returnToAman(returnTo);
  return (
    <Halaman judul="Masuk sebagai member">
      <Galat pesan={pesanGalatMasuk(galat)} />
      <p>Member masuk menggunakan akun Google. Kami tidak pernah meminta kata sandi Google Anda.</p>
      {/* Navigasi penuh (bukan Link): server mengalihkan ke Google. */}
      <a className="tombol" href={`/api/auth/member/google/start${tujuan ? `?returnTo=${encodeURIComponent(tujuan)}` : ''}`}>
        Masuk dengan Google
      </a>
      <p className="bantuan">Staff internal? Gunakan halaman masuk staff.</p>
      <a className="tombol-sekunder" href="/staff/masuk">
        Masuk sebagai staff internal
      </a>
    </Halaman>
  );
}
