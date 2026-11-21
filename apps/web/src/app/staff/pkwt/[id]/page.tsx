'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Galat, Halaman, Kolom, Lencana, Sukses } from '../../../../components/ui';
import { ApiError, api, unggah } from '../../../../lib/api';
import { formatTanggalIso } from '../../../../lib/format';
import { LABEL_KONTRAK } from '../../../../lib/pkwt';
import { useStaff } from '../../../../lib/staff';

interface Dokumen { id: string; originalFilename: string; status: string; rejectReason: string | null }
interface Detail {
  id: string; contractNumber: string; applicantName: string | null; position: string; startDate: string; endDate: string; status: string; templateName: string; templateVersion: number;
  versions: { versionNo: number; reason: string | null }[]; documents: Dokumen[]; history: { to: string; reason: string | null }[];
}

export default function DetailPkwt() {
  const { id } = useParams<{ id: string }>();
  const { info, galat: galatSesi, punya } = useStaff();
  const [d, setD] = useState<Detail | null>(null);
  const [alasan, setAlasan] = useState('');
  const [galat, setGalat] = useState<string | null>(null);
  const [sukses, setSukses] = useState<string | null>(null);

  const muat = useCallback(async () => {
    try {
      setD(await api<Detail>(`/pkwt/${id}`));
    } catch (e) {
      setGalat((e as ApiError).message);
    }
  }, [id]);
  useEffect(() => {
    if (info) void muat();
  }, [info, muat]);

  async function aksi(path: string, body: unknown, pesan: string) {
    if (!info) return;
    setGalat(null);
    setSukses(null);
    try {
      await api(`/pkwt/${id}/${path}`, { method: 'POST', csrf: info.csrfToken, body });
      setAlasan('');
      await muat();
      setSukses(pesan);
    } catch (e) {
      setGalat((e as ApiError).message);
    }
  }
  async function kirimScan(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!info) return;
    setGalat(null);
    setSukses(null);
    const input = e.currentTarget.elements.namedItem('berkas') as HTMLInputElement;
    if (!input.files?.[0]) return setGalat('Pilih berkas scan terlebih dahulu');
    const data = new FormData();
    data.set('berkas', input.files[0]);
    try {
      await unggah(`/pkwt/${id}/documents`, data, info.csrfToken);
      input.value = '';
      await muat();
      setSukses('Scan diunggah dan menunggu verifikasi HRD.');
    } catch (err) {
      setGalat((err as ApiError).message);
    }
  }
  const dengan = (jalur: string, pesan: string) => (e: FormEvent) => {
    e.preventDefault();
    void aksi(jalur, { reason: alasan }, pesan);
  };

  const s = d?.status ?? '';
  return (
    <Halaman judul={d?.contractNumber ?? 'Detail kontrak'}>
      <Galat pesan={galatSesi ?? galat} />
      <Sukses pesan={sukses} />
      {d ? (
        <>
          <div className="kartu">
            <p>
              {d.applicantName ?? 'Pekerja'} · {d.position}
            </p>
            <p>
              <Lencana status={d.status} /> {LABEL_KONTRAK[d.status] ?? d.status}
            </p>
            <p className="bantuan">
              {formatTanggalIso(d.startDate)} – {formatTanggalIso(d.endDate)} · Template {d.templateName} v{d.templateVersion} · Versi kontrak {d.versions[0]?.versionNo}
            </p>
            <p className="bantuan">Persetujuan di sistem bukan tanda tangan sah. Kontrak sah setelah scan bertanda tangan basah diverifikasi HRD.</p>
          </div>

          <div className="aksi">
            {s === 'DRAFT' && punya('pkwt.update') ? (
              <button className="tombol" type="button" onClick={() => aksi('submit', {}, 'Kontrak diajukan untuk diperiksa.')}>
                Ajukan untuk diperiksa
              </button>
            ) : null}
            {s === 'REVIEW' && punya('pkwt.review') ? (
              <button className="tombol" type="button" onClick={() => aksi('review', {}, 'Kontrak diperiksa dan menunggu persetujuan.')}>
                Periksa dan teruskan
              </button>
            ) : null}
            {s === 'PERSETUJUAN' && punya('pkwt.approve') ? (
              <button className="tombol" type="button" onClick={() => aksi('approve', {}, 'Kontrak disetujui untuk ditandatangani basah.')}>
                Setujui kontrak
              </button>
            ) : null}
            {punya('pkwt.export') && s !== 'DIBATALKAN' ? (
              <a className="tombol-sekunder" href={`/api/pkwt/${id}/pdf`}>
                Unduh PDF kontrak
              </a>
            ) : null}
          </div>

          {(s === 'REVIEW' && punya('pkwt.review')) || (s === 'PERSETUJUAN' && punya('pkwt.approve')) ? (
            <form onSubmit={dengan(s === 'REVIEW' ? 'review/reject' : 'approve/reject', 'Kontrak dikembalikan ke draf.')}>
              <Kolom id="alasan-kembali" label="Alasan pengembalian ke draf" value={alasan} onChange={setAlasan} maxLength={500} />
              <button className="tombol-sekunder" type="submit">
                Kembalikan ke draf
              </button>
            </form>
          ) : null}

          {s === 'PENANDATANGANAN' && punya('pkwt.update') ? (
            <section className="bagian" aria-labelledby="h-scan">
              <h3 id="h-scan">Unggah scan bertanda tangan</h3>
              <form onSubmit={kirimScan}>
                <div className="kolom">
                  <label htmlFor="berkas">Berkas scan (PDF, PNG, atau JPEG; maksimal 10 MB)</label>
                  <input id="berkas" name="berkas" type="file" accept="application/pdf,image/png,image/jpeg" />
                </div>
                <button className="tombol" type="submit">
                  Unggah scan
                </button>
              </form>
            </section>
          ) : null}

          <section className="bagian" aria-labelledby="h-dok">
            <h3 id="h-dok">Dokumen scan</h3>
            {d.documents.map((x) => (
              <article className="butir" key={x.id}>
                <p>
                  <strong>{x.originalFilename}</strong> <Lencana status={x.status === 'MENUNGGU_VERIFIKASI' ? 'MENUNGGU' : x.status} />
                </p>
                {x.rejectReason ? <p className="bantuan">Ditolak: {x.rejectReason}</p> : null}
                {punya('pkwt_document.review') ? (
                  <div className="aksi">
                    <a className="tombol-sekunder" href={`/api/pkwt/${id}/documents/${x.id}/download`}>
                      Unduh {x.originalFilename}
                    </a>
                    {x.status === 'MENUNGGU_VERIFIKASI' ? (
                      <>
                        <button className="tombol" type="button" onClick={() => aksi(`documents/${x.id}/verify`, {}, 'Scan diverifikasi. Kontrak sah.')}>
                          Verifikasi scan {x.originalFilename}
                        </button>
                        <form onSubmit={dengan(`documents/${x.id}/reject`, 'Scan ditolak; unggah ulang diperlukan.')}>
                          <Kolom id={`tolak-${x.id}`} label="Alasan penolakan scan" value={alasan} onChange={setAlasan} maxLength={500} />
                          <button className="tombol-sekunder" type="submit">
                            Tolak scan {x.originalFilename}
                          </button>
                        </form>
                      </>
                    ) : null}
                  </div>
                ) : null}
              </article>
            ))}
            {d.documents.length === 0 ? <p className="bantuan">Belum ada scan.</p> : null}
          </section>

          {['DRAFT', 'REVIEW', 'PERSETUJUAN', 'PENANDATANGANAN', 'MENUNGGU_VERIFIKASI_DOKUMEN'].includes(s) && punya('pkwt.update') ? (
            <form onSubmit={dengan('cancel', 'Kontrak dibatalkan.')}>
              <Kolom id="alasan-batal" label="Alasan pembatalan" value={alasan} onChange={setAlasan} maxLength={500} />
              <button className="tombol-sekunder" type="submit">
                Batalkan kontrak
              </button>
            </form>
          ) : null}
          {s === 'AKTIF' && punya('pkwt.approve') ? (
            <form onSubmit={dengan('terminate', 'Kontrak diakhiri lebih awal.')}>
              <Kolom id="alasan-akhir" label="Alasan mengakhiri lebih awal" value={alasan} onChange={setAlasan} maxLength={500} />
              <button className="tombol-sekunder" type="submit">
                Akhiri kontrak lebih awal
              </button>
            </form>
          ) : null}

          <section className="bagian" aria-labelledby="h-riw">
            <h3 id="h-riw">Riwayat</h3>
            {d.history.map((h, i) => (
              <p className="bantuan" key={i}>
                {LABEL_KONTRAK[h.to] ?? h.to}
                {h.reason ? ` — ${h.reason}` : ''}
              </p>
            ))}
          </section>
        </>
      ) : galat || galatSesi ? null : (
        <p role="status">Memuat…</p>
      )}
      <Link className="tautan" href="/staff/pkwt">
        Kembali ke daftar kontrak
      </Link>
    </Halaman>
  );
}
