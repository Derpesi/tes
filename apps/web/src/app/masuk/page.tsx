import { Galat, Halaman } from '../../components/ui';
import { pesanGalatMasuk } from '../../lib/teks';

export default async function Masuk({ searchParams }: { searchParams: Promise<{ galat?: string }> }) {
  const { galat } = await searchParams;
  return (
    <Halaman judul="Masuk sebagai member">
      <Galat pesan={pesanGalatMasuk(galat)} />
      <p>Member masuk menggunakan akun Google. Kami tidak pernah meminta kata sandi Google Anda.</p>
      {/* Navigasi penuh (bukan Link): server mengalihkan ke Google. */}
      <a className="tombol" href="/api/auth/member/google/start">
        Masuk dengan Google
      </a>
      <p className="bantuan">Staff internal? Gunakan halaman masuk staff.</p>
      <a className="tombol-sekunder" href="/staff/masuk">
        Masuk sebagai staff internal
      </a>
    </Halaman>
  );
}
