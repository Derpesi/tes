-- Up Migration
-- Fase 8: rekap payroll TAHAP AWAL (periode, snapshot absensi, komponen masukan, verifikasi, persetujuan, finalisasi, koreksi, ekspor). ADR-0009.
-- DILARANG di tahap ini (sengaja tidak ada): hitung gaji final, PPh 21, BPJS, slip, pembayaran/transfer, aturan regulasi.
-- Uang selalu NUMERIC (tidak pernah float).

CREATE TABLE payroll_periods (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies (id),
  kind       text NOT NULL CHECK (kind IN ('PARTNER', 'INTERNAL')),
  label      text NOT NULL CHECK (length(btrim(label)) > 0 AND length(label) <= 100),
  start_date date NOT NULL,
  end_date   date NOT NULL,
  created_by uuid NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payroll_periods_id_company_unik UNIQUE (id, company_id),
  CONSTRAINT payroll_periods_rentang CHECK (end_date >= start_date AND end_date - start_date <= 92),
  -- Periode untuk satu perusahaan dan jenis tidak boleh tumpang tindih (dijaga database).
  CONSTRAINT payroll_periods_tanpa_tumpang_tindih EXCLUDE USING gist (company_id WITH =, kind WITH =, daterange(start_date, end_date, '[]') WITH &&)
);
CREATE INDEX payroll_periods_company_idx ON payroll_periods (company_id, created_at DESC, id DESC);

CREATE TABLE payroll_recaps (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL,
  period_id         uuid NOT NULL,
  version_no        integer NOT NULL CHECK (version_no >= 1),
  recap_number      text CHECK (recap_number IS NULL OR length(btrim(recap_number)) > 0),
  correction_reason text CHECK (correction_reason IS NULL OR (length(btrim(correction_reason)) > 0 AND length(correction_reason) <= 500)),
  status            text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'DIVERIFIKASI', 'DISETUJUI', 'DIFINALISASI', 'DIGANTIKAN')),
  created_by        uuid NOT NULL REFERENCES users (id),
  last_edited_by    uuid REFERENCES users (id),
  reviewed_by       uuid REFERENCES users (id),
  reviewed_at       timestamptz,
  approved_by       uuid REFERENCES users (id),
  approved_at       timestamptz,
  finalized_by      uuid REFERENCES users (id),
  finalized_at      timestamptz,
  snapshot_hash     text CHECK (snapshot_hash IS NULL OR snapshot_hash ~ '^[0-9a-f]{64}$'),
  pulled_at         timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payroll_recaps_id_company_unik UNIQUE (id, company_id),
  CONSTRAINT payroll_recaps_versi_unik UNIQUE (period_id, version_no),
  CONSTRAINT payroll_recaps_nomor_unik UNIQUE (company_id, recap_number),
  FOREIGN KEY (period_id, company_id) REFERENCES payroll_periods (id, company_id),
  -- Versi koreksi (>= 2) wajib bernomor dan beralasan; versi 1 tanpa keduanya.
  CONSTRAINT payroll_recaps_koreksi_lengkap CHECK ((version_no = 1 AND recap_number IS NULL AND correction_reason IS NULL) OR (version_no >= 2 AND recap_number IS NOT NULL AND correction_reason IS NOT NULL)),
  -- Pembuat, pemeriksa, penyetuju, dan finalisator harus orang berbeda (dijaga database); penyunting terakhir bukan pemeriksa.
  CONSTRAINT payroll_recaps_sod CHECK (
    (reviewed_by IS NULL OR reviewed_by <> created_by) AND (approved_by IS NULL OR approved_by <> created_by) AND (finalized_by IS NULL OR finalized_by <> created_by)
    AND (approved_by IS NULL OR reviewed_by IS NULL OR approved_by <> reviewed_by)
    AND (finalized_by IS NULL OR reviewed_by IS NULL OR finalized_by <> reviewed_by)
    AND (finalized_by IS NULL OR approved_by IS NULL OR finalized_by <> approved_by)
    AND (reviewed_by IS NULL OR last_edited_by IS NULL OR reviewed_by <> last_edited_by)),
  CONSTRAINT payroll_recaps_pemeriksa_wajib CHECK (status IN ('DRAFT') OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)),
  CONSTRAINT payroll_recaps_penyetuju_wajib CHECK (status IN ('DRAFT', 'DIVERIFIKASI') OR (approved_by IS NOT NULL AND approved_at IS NOT NULL AND snapshot_hash IS NOT NULL)),
  CONSTRAINT payroll_recaps_finalisator_wajib CHECK (status <> 'DIFINALISASI' OR (finalized_by IS NOT NULL AND finalized_at IS NOT NULL))
);
-- Satu versi terbuka (DRAFT/DIVERIFIKASI) per periode: koreksi tidak dapat berjalan paralel.
CREATE UNIQUE INDEX payroll_recaps_satu_terbuka ON payroll_recaps (period_id) WHERE status IN ('DRAFT', 'DIVERIFIKASI');
CREATE INDEX payroll_recaps_company_idx ON payroll_recaps (company_id, created_at DESC, id DESC);

CREATE TABLE payroll_recap_lines (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL,
  recap_id         uuid NOT NULL,
  person_id        uuid NOT NULL REFERENCES persons (id),
  worker_name      text NOT NULL CHECK (length(btrim(worker_name)) > 0 AND length(worker_name) <= 150),
  source           text NOT NULL CHECK (source IN ('ATTENDANCE', 'MANUAL')),
  days_present     integer NOT NULL DEFAULT 0 CHECK (days_present BETWEEN 0 AND 93),
  days_absent      integer NOT NULL DEFAULT 0 CHECK (days_absent BETWEEN 0 AND 93),
  days_permit      integer NOT NULL DEFAULT 0 CHECK (days_permit BETWEEN 0 AND 93),
  days_sick        integer NOT NULL DEFAULT 0 CHECK (days_sick BETWEEN 0 AND 93),
  days_leave       integer NOT NULL DEFAULT 0 CHECK (days_leave BETWEEN 0 AND 93), -- masukan manual (cuti)
  late_count       integer NOT NULL DEFAULT 0 CHECK (late_count >= 0),
  early_leave_count integer NOT NULL DEFAULT 0 CHECK (early_leave_count >= 0),
  pending_count    integer NOT NULL DEFAULT 0 CHECK (pending_count >= 0),
  hours_worked     numeric(7, 2) NOT NULL DEFAULT 0 CHECK (hours_worked >= 0),
  overtime_hours   numeric(6, 2) NOT NULL DEFAULT 0 CHECK (overtime_hours >= 0), -- masukan manual; TIDAK ditafsirkan (aturan lembur = regulasi)
  note             text CHECK (note IS NULL OR length(note) <= 300),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payroll_recap_lines_id_company_unik UNIQUE (id, company_id),
  CONSTRAINT payroll_recap_lines_orang_unik UNIQUE (recap_id, person_id),
  FOREIGN KEY (recap_id, company_id) REFERENCES payroll_recaps (id, company_id)
);

CREATE TABLE payroll_components (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  line_id    uuid NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('TUNJANGAN', 'POTONGAN', 'INSENTIF')),
  name       text NOT NULL CHECK (length(btrim(name)) > 0 AND length(name) <= 80),
  amount     numeric(14, 2) NOT NULL CHECK (amount >= 0 AND amount < 1000000000000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payroll_components_id_company_unik UNIQUE (id, company_id),
  FOREIGN KEY (line_id, company_id) REFERENCES payroll_recap_lines (id, company_id)
);
CREATE INDEX payroll_components_line_idx ON payroll_components (line_id);

CREATE TABLE payroll_recap_status_histories (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL,
  recap_id      uuid NOT NULL,
  from_status   text,
  to_status     text NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users (id),
  reason        text CHECK (reason IS NULL OR length(reason) <= 500),
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (recap_id, company_id) REFERENCES payroll_recaps (id, company_id)
);
CREATE INDEX payroll_recap_status_histories_idx ON payroll_recap_status_histories (recap_id, created_at, id);

CREATE TABLE payroll_exports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL,
  recap_id    uuid NOT NULL,
  format      text NOT NULL CHECK (format IN ('CSV', 'XLSX', 'PDF')),
  row_count   integer NOT NULL CHECK (row_count >= 0),
  sha256      text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  exported_by uuid NOT NULL REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (recap_id, company_id) REFERENCES payroll_recaps (id, company_id)
);
CREATE INDEX payroll_exports_recap_idx ON payroll_exports (recap_id, created_at);

-- ---- pelindung: kekekalan ----
CREATE TRIGGER payroll_recap_status_histories_hanya_tambah BEFORE UPDATE OR DELETE ON payroll_recap_status_histories FOR EACH ROW EXECUTE FUNCTION riwayat_status_tolak_ubah();
CREATE TRIGGER payroll_exports_hanya_tambah BEFORE UPDATE OR DELETE ON payroll_exports FOR EACH ROW EXECUTE FUNCTION riwayat_status_tolak_ubah();

-- Baris dan komponen hanya dapat berubah saat rekap berstatus DRAFT; setelah itu hanya lewat versi koreksi bernomor.
CREATE FUNCTION payroll_baris_hanya_draft() RETURNS trigger AS $$
DECLARE s text;
BEGIN
  IF TG_TABLE_NAME = 'payroll_recap_lines' THEN
    SELECT status INTO s FROM payroll_recaps WHERE id = COALESCE(NEW.recap_id, OLD.recap_id);
  ELSE
    SELECT r.status INTO s FROM payroll_recap_lines l JOIN payroll_recaps r ON r.id = l.recap_id WHERE l.id = COALESCE(NEW.line_id, OLD.line_id);
  END IF;
  IF s IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'Rekap yang sudah diverifikasi atau disetujui tidak boleh diubah; gunakan koreksi resmi bernomor versi' USING ERRCODE = '23514';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER payroll_recap_lines_hanya_draft BEFORE INSERT OR UPDATE OR DELETE ON payroll_recap_lines FOR EACH ROW EXECUTE FUNCTION payroll_baris_hanya_draft();
CREATE TRIGGER payroll_components_hanya_draft BEFORE INSERT OR UPDATE OR DELETE ON payroll_components FOR EACH ROW EXECUTE FUNCTION payroll_baris_hanya_draft();

-- Rekap: transisi status sah saja, identitas/pelaku/hash tidak berubah diam-diam setelah disetujui, dan tidak pernah dihapus.
CREATE FUNCTION payroll_rekap_jaga() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Rekap payroll tidak boleh dihapus' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'DRAFT' AND NEW.status = 'DIVERIFIKASI') OR (OLD.status = 'DIVERIFIKASI' AND NEW.status IN ('DRAFT', 'DISETUJUI'))
    OR (OLD.status = 'DISETUJUI' AND NEW.status IN ('DIFINALISASI', 'DIGANTIKAN')) OR (OLD.status = 'DIFINALISASI' AND NEW.status = 'DIGANTIKAN')) THEN
    RAISE EXCEPTION 'Transisi status rekap % -> % tidak sah', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('DISETUJUI', 'DIFINALISASI', 'DIGANTIKAN') AND (
    NEW.snapshot_hash IS DISTINCT FROM OLD.snapshot_hash OR NEW.created_by <> OLD.created_by OR NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
    OR NEW.version_no <> OLD.version_no OR NEW.period_id <> OLD.period_id OR NEW.recap_number IS DISTINCT FROM OLD.recap_number) THEN
    RAISE EXCEPTION 'Rekap yang sudah disetujui tidak boleh diubah diam-diam' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER payroll_recaps_jaga BEFORE UPDATE OR DELETE ON payroll_recaps FOR EACH ROW EXECUTE FUNCTION payroll_rekap_jaga();

-- ---- RLS tenant (tanpa kebijakan member: rekap payroll bukan untuk member) ----
SELECT enable_tenant_rls('payroll_periods');
SELECT enable_tenant_rls('payroll_recaps');
SELECT enable_tenant_rls('payroll_recap_lines');
SELECT enable_tenant_rls('payroll_components');
SELECT enable_tenant_rls('payroll_recap_status_histories');
SELECT enable_tenant_rls('payroll_exports');

-- Down Migration
DROP TABLE payroll_exports;
DROP TABLE payroll_recap_status_histories;
DROP TABLE payroll_components;
DROP TABLE payroll_recap_lines;
DROP TABLE payroll_recaps;
DROP TABLE payroll_periods;
DROP FUNCTION payroll_rekap_jaga();
DROP FUNCTION payroll_baris_hanya_draft();
