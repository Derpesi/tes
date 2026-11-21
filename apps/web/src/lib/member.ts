'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ApiError, InfoSesi, ambilSesi } from './api';

/** Memuat sesi member penuh; belum masuk -> /masuk, staff -> /staff. Penegakan akses tetap di backend. */
export function useMember(): { sesi: InfoSesi | null; galat: string | null } {
  const router = useRouter();
  const [sesi, setSesi] = useState<InfoSesi | null>(null);
  const [galat, setGalat] = useState<string | null>(null);
  useEffect(() => {
    ambilSesi()
      .then((s) => {
        if (!s) return router.replace('/masuk');
        if (s.realm !== 'member') return router.replace('/staff');
        setSesi(s);
      })
      .catch((e: ApiError) => setGalat(e.message));
  }, [router]);
  return { sesi, galat };
}

export const LABEL_STATUS_MEMBER: Record<string, string> = {
  TERDAFTAR: 'Terdaftar',
  PROFIL_BELUM_LENGKAP: 'Profil belum lengkap',
  MENUNGGU_VERIFIKASI: 'Menunggu verifikasi HRD',
  TERVERIFIKASI: 'Terverifikasi',
  BELUM_DITEMPATKAN: 'Terverifikasi, belum ditempatkan',
  KARYAWAN_AKTIF: 'Karyawan aktif',
  KONTRAK_AKAN_BERAKHIR: 'Kontrak akan berakhir',
  KONTRAK_BERAKHIR: 'Kontrak berakhir',
  NONAKTIF: 'Nonaktif',
};
