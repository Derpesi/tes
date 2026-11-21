import Link from 'next/link';
import { Halaman } from '../components/ui';

export default function Beranda() {
  return (
    <Halaman judul="Selamat datang">
      <p>Pilih cara masuk sesuai peran Anda.</p>
      <Link className="tombol" href="/masuk">
        Masuk sebagai member / tenaga kerja
      </Link>
      <Link className="tombol-sekunder" href="/staff/masuk">
        Masuk sebagai staff internal
      </Link>
    </Halaman>
  );
}
