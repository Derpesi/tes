import { createHash } from 'node:crypto';
import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { PDFDocument, PDFFont, StandardFonts, rgb } from 'pdf-lib';
import { AuditService } from '../audit/audit.service';
import { JAM_ABSENSI, JamAbsensi } from '../attendance/jam';
import { dokumenCsv } from '../attendance/csv';
import type { Akses } from '../rbac/akses.service';
import { AlurService } from './alur.service';
import { JenisRekap, wajibIzin } from './akses';
import { PayrollService } from './payroll.service';
import { hashSnapshot } from './uang';
import { buatXlsx, SelXlsx } from './xlsx';

export type FormatEkspor = 'CSV' | 'XLSX' | 'PDF';
const MIME: Record<FormatEkspor, string> = { CSV: 'text/csv; charset=utf-8', XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', PDF: 'application/pdf' };
const EKSTENSI: Record<FormatEkspor, string> = { CSV: 'csv', XLSX: 'xlsx', PDF: 'pdf' };

/** Kolom SEMENTARA (A-42): format final menunggu pemilik. Mengubahnya tidak memerlukan migrasi. */
const KEPALA = ['No', 'Nama', 'Sumber', 'Hari Hadir', 'Hari Tidak Hadir', 'Izin', 'Sakit', 'Cuti', 'Terlambat', 'Pulang Cepat', 'Jam Kerja', 'Jam Lembur', 'Tunjangan', 'Potongan', 'Insentif', 'Catatan'];
const KOLOM_ANGKA = new Set([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]); // indeks kolom bernilai angka (untuk xlsx)
const LABEL_JENIS: Record<string, string> = { PARTNER: 'Rekanan', INTERNAL: 'Internal' };
const CATATAN_KAKI = 'Rekap masukan payroll tahap awal. Dokumen ini BUKAN slip gaji dan tidak menghitung gaji, PPh 21, atau BPJS.';

type Rekap = Awaited<ReturnType<PayrollService['detailRekap']>>;

/** Satu sumber isi tabel untuk ketiga format (nominal berupa teks desimal; tidak ada perhitungan float). */
function susunTabel(r: Rekap): (string | number)[][] {
  return r.lines.map((l, i) => [
    i + 1, l.workerName, l.source === 'ATTENDANCE' ? 'Absensi' : 'Manual', l.daysPresent, l.daysAbsent, l.daysPermit, l.daysSick, l.daysLeave, l.lateCount, l.earlyLeaveCount,
    l.hoursWorked as string, l.overtimeHours as string, l.subtotals.TUNJANGAN, l.subtotals.POTONGAN, l.subtotals.INSENTIF, l.note ?? '',
  ]);
}

/**
 * Ekspor rekap payroll (CSV, xlsx, PDF) hanya untuk rekap DISETUJUI/DIFINALISASI. Dibangkitkan sesuai permintaan (tidak disimpan) dan dicatat di
 * `payroll_exports` + audit. Sel berawalan = + - @ TAB CR dinetralkan di semua format. Integritas isi dicek terhadap hash saat disetujui.
 * Ukuran kecil (<= 5.000 baris) sehingga sinkron; antrean latar dan bucket privat menyusul bila beban menuntut (dicatat di ADR-0009).
 */
@Injectable()
export class ExportService {
  constructor(
    private readonly pay: PayrollService,
    private readonly alur: AlurService,
    private readonly audit: AuditService,
    @Inject(JAM_ABSENSI) private readonly jam: JamAbsensi,
  ) {}

  async riwayat(a: Akses, id: string) {
    return this.pay.tx(a, async (c) => {
      await this.pay.muatRekap(c, a, id);
      const r = await c.query(`SELECT id, format, row_count, sha256, exported_by, created_at FROM payroll_exports WHERE recap_id = $1 ORDER BY created_at DESC, id DESC LIMIT 100`, [id]);
      return { items: r.rows.map((x) => ({ id: x.id, format: x.format, rowCount: x.row_count, sha256: x.sha256, exportedBy: x.exported_by, createdAt: x.created_at })) };
    });
  }

  async ekspor(a: Akses, id: string, format: FormatEkspor): Promise<{ data: Buffer; mime: string; namaBerkas: string }> {
    const hasil = await this.pay.tx(a, async (c) => {
      const r = await this.pay.muatRekap(c, a, id, true);
      wajibIzin(a, r.kind as JenisRekap, 'export');
      if (r.status === 'DIGANTIKAN') throw new ConflictException({ kode: 'REKAP_DIGANTIKAN', message: 'Versi rekap ini sudah digantikan oleh versi koreksi; ekspor versi terbaru' });
      if (!['DISETUJUI', 'DIFINALISASI'].includes(r.status as string)) throw new ConflictException({ kode: 'REKAP_BELUM_DISETUJUI', message: 'Ekspor hanya untuk rekap yang sudah disetujui' });
      if (hashSnapshot(await this.alur.snapshot(c, id)) !== r.snapshot_hash) throw new ConflictException({ kode: 'INTEGRITAS_REKAP_GAGAL', message: 'Isi rekap tidak lagi sama dengan yang disetujui. Hentikan dan hubungi administrator' });
      const penuh = await this.pay.penuh(c, r);
      const data = await this.bangun(penuh, format);
      const sha = createHash('sha256').update(data).digest('hex');
      await c.query(`INSERT INTO payroll_exports (company_id, recap_id, format, row_count, sha256, exported_by) VALUES ($1, $2, $3, $4, $5, $6)`, [r.company_id, id, format, penuh.lineCount, sha, a.userId]);
      return { r, penuh, data, sha };
    });
    await this.audit.catat({
      aksi: 'payroll.recap.exported', aktorId: a.userId, companyId: hasil.r.company_id as string, objek: 'payroll_recap', objekId: id,
      detail: { format, jumlahBaris: hasil.penuh.lineCount, versi: hasil.r.version_no, sha256: hasil.sha },
    });
    const namaBerkas = `rekap-payroll-${String(hasil.r.kind).toLowerCase()}-${hasil.r.start_date}_${hasil.r.end_date}-v${hasil.r.version_no}.${EKSTENSI[format]}`;
    return { data: hasil.data, mime: MIME[format], namaBerkas };
  }

  private async bangun(r: Rekap, format: FormatEkspor): Promise<Buffer> {
    const tabel = susunTabel(r);
    if (format === 'CSV') return Buffer.from(dokumenCsv(KEPALA, tabel), 'utf8');
    if (format === 'XLSX') {
      const baris: SelXlsx[][] = tabel.map((b) => b.map((v, i) => (KOLOM_ANGKA.has(i) ? { angka: String(v) } : v)));
      const komponen: SelXlsx[][] = [['Nama', 'Jenis', 'Nama komponen', 'Nominal']];
      for (const l of r.lines) for (const k of l.components) komponen.push([l.workerName, k.kind, k.name, { angka: k.amount }]);
      const info: SelXlsx[][] = [
        ['Jenis rekap', LABEL_JENIS[r.kind as string] ?? String(r.kind)], ['Periode', `${r.label}`], ['Tanggal mulai', r.startDate as string], ['Tanggal akhir', r.endDate as string], ['Versi', r.versionNo as number],
        ['Nomor koreksi', (r.recapNumber as string | null) ?? ''], ['Status', r.status as string], ['Hash isi (SHA-256)', (r.snapshotHash as string | null) ?? ''],
        ['Subtotal Tunjangan', { angka: r.totals.TUNJANGAN }], ['Subtotal Potongan', { angka: r.totals.POTONGAN }], ['Subtotal Insentif', { angka: r.totals.INSENTIF }], ['Catatan', CATATAN_KAKI],
      ];
      return buatXlsx([{ nama: 'Rekap', baris: [KEPALA, ...baris] }, { nama: 'Komponen', baris: komponen }, { nama: 'Info', baris: info }]);
    }
    return this.pdf(r, tabel);
  }

  private async pdf(r: Rekap, tabel: (string | number)[][]): Promise<Buffer> {
    const doc = await PDFDocument.create();
    const biasa = await doc.embedFont(StandardFonts.Helvetica);
    const tebal = await doc.embedFont(StandardFonts.HelveticaBold);
    const L = 841.89;
    const T = 595.28;
    const tepi = 28;
    const bersih = (f: PDFFont, t: string) => { const ok = new Set(f.getCharacterSet()); return [...t].map((ch) => (ok.has(ch.codePointAt(0)!) ? ch : '?')).join(''); };
    const potong = (f: PDFFont, t: string, ukuran: number, lebar: number) => {
      let s = bersih(f, t);
      while (s.length > 1 && f.widthOfTextAtSize(s, ukuran) > lebar) s = s.slice(0, -1);
      return s;
    };
    // Lebar kolom (jumlah = L - 2*tepi = 785,89): nama lebih lebar.
    const lebar = [22, 140, 42, 36, 40, 26, 30, 28, 40, 44, 42, 42, 74, 74, 74, 31.89];
    const tampil = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]; // catatan tidak ditampilkan di PDF (ruang); tetap ada di CSV/xlsx
    const judul = `Rekap Payroll ${LABEL_JENIS[r.kind as string] ?? ''} - ${bersih(biasa, String(r.label))}`;
    const sub = `Periode ${r.startDate} s.d. ${r.endDate} · Versi ${r.versionNo}${r.recapNumber ? ` (${r.recapNumber})` : ''} · Status ${r.status} · Hash ${String(r.snapshotHash).slice(0, 16)}`;
    let hal = doc.addPage([L, T]);
    let y = T - tepi;
    const kepala = () => {
      hal.drawText(bersih(tebal, judul), { x: tepi, y, size: 13, font: tebal, color: rgb(0.04, 0.12, 0.23) });
      y -= 15;
      hal.drawText(bersih(biasa, sub), { x: tepi, y, size: 8, font: biasa });
      y -= 18;
      let x = tepi;
      tampil.forEach((i) => { hal.drawText(potong(tebal, KEPALA[i], 7, lebar[i] - 3), { x, y, size: 7, font: tebal }); x += lebar[i]; });
      y -= 4;
      hal.drawLine({ start: { x: tepi, y }, end: { x: L - tepi, y }, thickness: 0.6 });
      y -= 11;
    };
    kepala();
    for (const b of tabel) {
      if (y < tepi + 40) { hal = doc.addPage([L, T]); y = T - tepi; kepala(); }
      let x = tepi;
      tampil.forEach((i) => { hal.drawText(potong(biasa, String(b[i]), 7, lebar[i] - 3), { x, y, size: 7, font: biasa }); x += lebar[i]; });
      y -= 10;
    }
    if (y < tepi + 70) { hal = doc.addPage([L, T]); y = T - tepi; }
    y -= 8;
    hal.drawLine({ start: { x: tepi, y }, end: { x: L - tepi, y }, thickness: 0.6 });
    y -= 12;
    hal.drawText(`Subtotal (masukan, bukan gaji): Tunjangan ${r.totals.TUNJANGAN} · Potongan ${r.totals.POTONGAN} · Insentif ${r.totals.INSENTIF}`, { x: tepi, y, size: 8, font: tebal });
    y -= 12;
    hal.drawText(bersih(biasa, `Diekspor ${new Intl.DateTimeFormat('id-ID', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Asia/Jakarta' }).format(this.jam())} WIB. ${CATATAN_KAKI}`), { x: tepi, y, size: 7, font: biasa });
    return Buffer.from(await doc.save());
  }
}
