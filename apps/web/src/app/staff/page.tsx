'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Galat, Halaman } from '../../components/ui';
import { ApiError, InfoSesi, ambilSesi, api } from '../../lib/api';

interface Widget { id: string; title: string; link: string; items: { key: string; label: string; value: number }[] }

export default function BerandaStaff() {
  const router = useRouter();
  const [info, setInfo] = useState<InfoSesi | null>(null);
  const [galat, setGalat] = useState<string | null>(null);
  const [widgets, setWidgets] = useState<Widget[]>([]);

  useEffect(() => {
    (async () => {
      try {
        const s = await ambilSesi();
        if (!s) return router.replace('/staff/masuk');
        if (s.realm !== 'staff') return router.replace('/saya');
        if (s.state === 'MENUNGGU_ENROLL_MFA') return router.replace('/staff/daftar-mfa');
        if (s.state === 'MENUNGGU_MFA') return router.replace('/staff/masuk');
        setInfo(await api<InfoSesi>('/auth/me'));
        // Widget mengikuti izin (angka agregat, scope perusahaan lewat RLS di backend); kegagalan widget tidak menghalangi menu.
        api<{ widgets: Widget[] }>('/dashboard/staff').then((d) => setWidgets(d.widgets), () => undefined);
      } catch (e) {
        setGalat((e as ApiError).message);
      }
    })();
  }, [router]);

  async function keluar() {
    if (!info) return;
    try {
      await api('/auth/logout', { method: 'POST', csrf: info.csrfToken });
      router.replace('/staff/masuk');
    } catch (e) {
      setGalat((e as ApiError).message);
    }
  }

  return (
    <Halaman judul="Beranda staff">
      <Galat pesan={galat} />
      {info ? (
        <>
          <div className="kartu">
            <p>
              Masuk sebagai <strong>{info.user.email}</strong>
            </p>
            <p>Peran: {info.roles && info.roles.length ? info.roles.join(', ') : 'belum ada peran'}</p>
            <p className="bantuan">Izin aktif: {info.permissions?.length ?? 0}. Akses perusahaan: {info.allCompanies ? 'seluruh perusahaan' : `${info.companyIds?.length ?? 0} perusahaan`}.</p>
          </div>
          {widgets.length ? (
            <section aria-label="Ringkasan" className="bagian">
              {widgets.map((w) => (
                <div className="butir" key={w.id}>
                  <h3>
                    <Link className="tautan" href={w.link}>
                      {w.title}
                    </Link>
                  </h3>
                  {w.items.map((i) => (
                    <div className="komponen" key={i.key}>
                      <span>{i.label}</span>
                      <strong>{i.value}</strong>
                    </div>
                  ))}
                </div>
              ))}
            </section>
          ) : null}
          <nav className="menu" aria-label="Menu utama">
            {info.permissions?.includes('company.view') ? (
              <Link className="tombol-sekunder" href="/staff/perusahaan">
                Perusahaan
              </Link>
            ) : null}
            {info.permissions?.includes('partner.view') ? (
              <Link className="tombol-sekunder" href="/staff/rekanan">
                Rekanan
              </Link>
            ) : null}
            {info.permissions?.includes('member.view') ? (
              <Link className="tombol-sekunder" href="/staff/anggota">
                Database member
              </Link>
            ) : null}
            {info.permissions?.includes('vacancy_application.view') ? (
              <>
                <Link className="tombol-sekunder" href="/staff/lowongan">
                  Lowongan
                </Link>
                <Link className="tombol-sekunder" href="/staff/lamaran">
                  Lamaran
                </Link>
              </>
            ) : null}
            {info.permissions?.includes('pkwt.view') ? (
              <>
                <Link className="tombol-sekunder" href="/staff/pkwt">
                  Kontrak PKWT
                </Link>
                <Link className="tombol-sekunder" href="/staff/template-pkwt">
                  Template PKWT
                </Link>
              </>
            ) : null}
            {info.permissions?.includes('placement.view') ? (
              <>
                <Link className="tombol-sekunder" href="/staff/penempatan">
                  Penempatan
                </Link>
                <Link className="tombol-sekunder" href="/staff/karyawan">
                  Karyawan aktif
                </Link>
              </>
            ) : null}
            {['attendance_point.view', 'attendance_point.create', 'attendance_point.update', 'attendance_point.export'].some((i) => info.permissions?.includes(i)) ? (
              <Link className="tombol-sekunder" href="/staff/titik-absensi">
                Titik absensi (QR)
              </Link>
            ) : null}
            {info.permissions?.includes('placement.view') ? (
              <Link className="tombol-sekunder" href="/staff/jadwal">
                Shift dan jadwal
              </Link>
            ) : null}
            {['attendance_anomaly.view', 'attendance_anomaly.review', 'attendance_anomaly.approve'].some((i) => info.permissions?.includes(i)) ? (
              <Link className="tombol-sekunder" href="/staff/tinjauan-absensi">
                Tinjauan absensi
              </Link>
            ) : null}
            {['attendance_adjustment.view', 'attendance_adjustment.create', 'attendance_adjustment.update', 'attendance_adjustment.approve'].some((i) => info.permissions?.includes(i)) ? (
              <Link className="tombol-sekunder" href="/staff/koreksi-absensi">
                Koreksi absensi
              </Link>
            ) : null}
            {info.permissions?.includes('attendance_recap.view') ? (
              <Link className="tombol-sekunder" href="/staff/rekap-absensi">
                Rekap absensi
              </Link>
            ) : null}
            {['payroll_recap_partner.view', 'payroll_recap_partner.create', 'payroll_recap_partner.update', 'payroll_recap_partner.review', 'payroll_recap_partner.export', 'payroll_recap_internal.view', 'payroll_recap_internal.create', 'payroll_recap_internal.update', 'payroll_recap_internal.review', 'payroll_recap_internal.export', 'payroll_approval.approve', 'payroll_approval.finalize'].some((i) => info.permissions?.includes(i)) ? (
              <Link className="tombol-sekunder" href="/staff/payroll">
                Rekap payroll
              </Link>
            ) : null}
            {info.permissions?.includes('audit_log.view') ? (
              <Link className="tombol-sekunder" href="/staff/audit">
                Audit log
              </Link>
            ) : null}
            {info.permissions?.includes('user_role.view') ? (
              <Link className="tombol-sekunder" href="/staff/persetujuan">
                Persetujuan
              </Link>
            ) : null}
          </nav>
          <p className="bantuan">Modul kepegawaian lainnya akan tersedia pada tahap berikutnya.</p>
          <button className="tombol-sekunder" type="button" onClick={keluar}>
            Keluar
          </button>
        </>
      ) : galat ? null : (
        <p role="status">Memuat…</p>
      )}
    </Halaman>
  );
}
