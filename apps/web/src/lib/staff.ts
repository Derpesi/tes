'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ApiError, InfoSesi, ambilSesi, api } from './api';

/** Memuat sesi staff penuh (izin dari server). Menu hanya kemudahan; penegakan izin tetap di backend. */
export function useStaff(): { info: InfoSesi | null; galat: string | null; punya: (izin: string) => boolean } {
  const router = useRouter();
  const [info, setInfo] = useState<InfoSesi | null>(null);
  const [galat, setGalat] = useState<string | null>(null);
  useEffect(() => {
    (async () => {
      try {
        const s = await ambilSesi();
        if (!s) return router.replace('/staff/masuk');
        if (s.realm !== 'staff') return router.replace('/saya');
        if (s.state === 'MENUNGGU_ENROLL_MFA') return router.replace('/staff/daftar-mfa');
        if (s.state === 'MENUNGGU_MFA') return router.replace('/staff/masuk');
        setInfo(await api<InfoSesi>('/auth/me'));
      } catch (e) {
        setGalat((e as ApiError).message);
      }
    })();
  }, [router]);
  return { info, galat, punya: (izin) => info?.permissions?.includes(izin) ?? false };
}
