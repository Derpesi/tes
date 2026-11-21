-- Up Migration
-- Fase 6: template PKWT berversi, kontrak, versi (hanya-tambah), dokumen scan, nomor otomatis, penempatan. ADR-0007.
-- Sistem TIDAK membawa teks hukum bawaan: isi template disediakan pengguna dan diverifikasi ahli hukum di luar sistem.
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE contract_templates (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES companies (id),
  name              text NOT NULL CHECK (length(btrim(name)) > 0 AND length(name) <= 150),
  version           integer NOT NULL CHECK (version >= 1),
  body              text NOT NULL CHECK (length(btrim(body)) > 0 AND length(body) <= 50000),
  status            text NOT NULL DEFAULT 'BELUM_DIVERIFIKASI' CHECK (status IN ('BELUM_DIVERIFIKASI', 'TERVERIFIKASI', 'DIARSIPKAN')),
  verified_by       uuid REFERENCES users (id),
  verified_at       timestamptz,
  verification_note text CHECK (verification_note IS NULL OR length(verification_note) <= 500),
  created_by        uuid NOT NULL REFERENCES users (id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contract_templates_versi_unik UNIQUE (company_id, name, version),
  CONSTRAINT contract_templates_id_company_unik UNIQUE (id, company_id),
  CONSTRAINT contract_templates_verifikasi_lengkap CHECK (status = 'BELUM_DIVERIFIKASI' OR (verified_by IS NOT NULL AND verified_at IS NOT NULL AND verification_note IS NOT NULL)),
  CONSTRAINT contract_templates_pemverifikasi_bukan_pembuat CHECK (verified_by IS NULL OR verified_by <> created_by)
);

CREATE TABLE employment_contracts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL,
  application_id        uuid NOT NULL,
  person_id             uuid NOT NULL REFERENCES persons (id),
  template_id           uuid NOT NULL,
  extends_contract_id   uuid,
  contract_number       text NOT NULL CHECK (length(btrim(contract_number)) > 0 AND length(contract_number) <= 80),
  position              text NOT NULL CHECK (length(btrim(position)) > 0 AND length(position) <= 100),
  start_date            date NOT NULL,
  end_date              date NOT NULL,
  status                text NOT NULL DEFAULT 'DRAFT' CHECK (status IN (
    'DRAFT', 'REVIEW', 'PERSETUJUAN', 'PENANDATANGANAN', 'MENUNGGU_VERIFIKASI_DOKUMEN', 'DITANDATANGANI', 'AKTIF', 'BERAKHIR', 'DIAKHIRI_LEBIH_AWAL', 'DIBATALKAN')),
  current_version       integer NOT NULL DEFAULT 1 CHECK (current_version >= 1),
  created_by            uuid NOT NULL REFERENCES users (id),
  reviewed_by           uuid REFERENCES users (id),
  reviewed_at           timestamptz,
  approved_by           uuid REFERENCES users (id),
  approved_at           timestamptz,
  activated_at          timestamptz,
  ended_at              timestamptz,
  end_reason            text CHECK (end_reason IS NULL OR length(end_reason) <= 500),
  expiry_notified_at    timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT employment_contracts_id_company_unik UNIQUE (id, company_id),
  CONSTRAINT employment_contracts_id_person_unik UNIQUE (id, person_id),
  CONSTRAINT employment_contracts_nomor_unik UNIQUE (company_id, contract_number),
  CONSTRAINT employment_contracts_periode CHECK (end_date >= start_date),
  -- Pembuat, pemeriksa, dan penyetuju harus orang berbeda (dijaga database).
  CONSTRAINT employment_contracts_sod CHECK (
    (reviewed_by IS NULL OR reviewed_by <> created_by) AND (approved_by IS NULL OR approved_by <> created_by) AND (approved_by IS NULL OR reviewed_by IS NULL OR approved_by <> reviewed_by)),
  CONSTRAINT employment_contracts_pemeriksa_wajib CHECK (status IN ('DRAFT', 'REVIEW', 'DIBATALKAN') OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)),
  CONSTRAINT employment_contracts_penyetuju_wajib CHECK (status IN ('DRAFT', 'REVIEW', 'PERSETUJUAN', 'DIBATALKAN') OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
  FOREIGN KEY (application_id, company_id) REFERENCES job_applications (id, company_id),
  FOREIGN KEY (template_id, company_id) REFERENCES contract_templates (id, company_id),
  FOREIGN KEY (extends_contract_id, company_id) REFERENCES employment_contracts (id, company_id)
);
-- Satu kontrak berjalan per lamaran; kontrak lanjutan (perpanjangan) memakai lamaran/rangkaian yang sama lewat extends_contract_id.
CREATE UNIQUE INDEX employment_contracts_satu_per_lamaran ON employment_contracts (application_id) WHERE status <> 'DIBATALKAN' AND extends_contract_id IS NULL;
CREATE INDEX employment_contracts_company_idx ON employment_contracts (company_id, created_at DESC, id DESC);
CREATE INDEX employment_contracts_person_idx ON employment_contracts (person_id, status);
CREATE INDEX employment_contracts_status_tanggal_idx ON employment_contracts (status, start_date, end_date);

CREATE TABLE contract_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL,
  contract_id     uuid NOT NULL,
  version_no      integer NOT NULL CHECK (version_no >= 1),
  contract_number text NOT NULL,
  position        text NOT NULL,
  start_date      date NOT NULL,
  end_date        date NOT NULL,
  template_id     uuid NOT NULL,
  template_version integer NOT NULL,
  variables       jsonb NOT NULL DEFAULT '{}'::jsonb, -- TANPA NIK/PII sensitif
  reason          text CHECK (reason IS NULL OR length(reason) <= 500),
  created_by      uuid NOT NULL REFERENCES users (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contract_versions_unik UNIQUE (contract_id, version_no),
  FOREIGN KEY (contract_id, company_id) REFERENCES employment_contracts (id, company_id)
);

CREATE TABLE contract_documents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL,
  contract_id       uuid NOT NULL,
  version_no        integer NOT NULL CHECK (version_no >= 1),
  object_key        text NOT NULL UNIQUE,
  original_filename text NOT NULL CHECK (length(original_filename) BETWEEN 1 AND 150),
  mime_type         text NOT NULL CHECK (mime_type IN ('application/pdf', 'image/png', 'image/jpeg')),
  size_bytes        integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
  sha256            bytea NOT NULL CHECK (length(sha256) = 32),
  status            text NOT NULL DEFAULT 'MENUNGGU_VERIFIKASI' CHECK (status IN ('MENUNGGU_VERIFIKASI', 'TERVERIFIKASI', 'DITOLAK')),
  uploaded_by       uuid NOT NULL REFERENCES users (id),
  verified_by       uuid REFERENCES users (id),
  verified_at       timestamptz,
  reject_reason     text CHECK (reject_reason IS NULL OR length(reject_reason) <= 500),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contract_documents_keputusan_lengkap CHECK (
    status = 'MENUNGGU_VERIFIKASI' OR (verified_by IS NOT NULL AND verified_at IS NOT NULL AND (status <> 'DITOLAK' OR reject_reason IS NOT NULL))),
  CONSTRAINT contract_documents_pemverifikasi_bukan_pengunggah CHECK (verified_by IS NULL OR verified_by <> uploaded_by),
  FOREIGN KEY (contract_id, company_id) REFERENCES employment_contracts (id, company_id)
);
CREATE UNIQUE INDEX contract_documents_satu_berjalan ON contract_documents (contract_id) WHERE status IN ('MENUNGGU_VERIFIKASI', 'TERVERIFIKASI');
CREATE INDEX contract_documents_contract_idx ON contract_documents (company_id, contract_id, created_at DESC);

-- Penomoran: satu baris per (perusahaan, tahun); dikunci FOR UPDATE saat menerbitkan nomor (tanpa duplikat/celah).
CREATE TABLE contract_number_counters (
  company_id uuid NOT NULL REFERENCES companies (id),
  year       integer NOT NULL CHECK (year BETWEEN 2000 AND 2200),
  last_value integer NOT NULL DEFAULT 0 CHECK (last_value >= 0),
  PRIMARY KEY (company_id, year)
);

CREATE TABLE placements (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL,
  person_id   uuid NOT NULL REFERENCES persons (id),
  contract_id uuid,
  location_id uuid NOT NULL,
  start_date  date NOT NULL,
  end_date    date,
  status      text NOT NULL DEFAULT 'DIRENCANAKAN' CHECK (status IN ('DIRENCANAKAN', 'MENUNGGU_KONTRAK', 'AKTIF', 'DITANGGUHKAN', 'DIPINDAHKAN', 'SELESAI', 'DIBATALKAN')),
  note        text CHECK (note IS NULL OR length(note) <= 500),
  created_by  uuid NOT NULL REFERENCES users (id),
  approved_by uuid REFERENCES users (id),
  approved_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT placements_id_company_unik UNIQUE (id, company_id),
  CONSTRAINT placements_periode CHECK (end_date IS NULL OR end_date >= start_date),
  CONSTRAINT placements_penyetuju_bukan_pembuat CHECK (approved_by IS NULL OR approved_by <> created_by),
  CONSTRAINT placements_aktif_wajib_disetujui CHECK (status NOT IN ('AKTIF', 'DITANGGUHKAN') OR (approved_by IS NOT NULL AND approved_at IS NOT NULL AND contract_id IS NOT NULL)),
  -- Dua penempatan non-final untuk satu orang tidak boleh tumpang tindih (dijaga database).
  CONSTRAINT placements_tanpa_tumpang_tindih EXCLUDE USING gist (person_id WITH =, daterange(start_date, end_date, '[]') WITH &&)
    WHERE (status IN ('DIRENCANAKAN', 'MENUNGGU_KONTRAK', 'AKTIF', 'DITANGGUHKAN')),
  FOREIGN KEY (location_id, company_id) REFERENCES partner_locations (id, company_id),
  FOREIGN KEY (contract_id, company_id) REFERENCES employment_contracts (id, company_id),
  -- Penempatan hanya untuk orang yang sama dengan pemilik kontraknya.
  FOREIGN KEY (contract_id, person_id) REFERENCES employment_contracts (id, person_id)
);
CREATE INDEX placements_company_idx ON placements (company_id, created_at DESC, id DESC);
CREATE INDEX placements_person_idx ON placements (person_id, status);
CREATE INDEX placements_lokasi_idx ON placements (company_id, location_id, status);

-- ---- pelindung tingkat database ----
CREATE FUNCTION template_pkwt_terkunci() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'BELUM_DIVERIFIKASI' THEN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Template yang sudah diverifikasi tidak boleh dihapus'; END IF;
    IF (NEW.company_id, NEW.name, NEW.version, NEW.body) IS DISTINCT FROM (OLD.company_id, OLD.name, OLD.version, OLD.body) THEN
      RAISE EXCEPTION 'Isi template yang sudah diverifikasi tidak boleh diubah; buat versi baru';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER contract_templates_terkunci BEFORE UPDATE OR DELETE ON contract_templates FOR EACH ROW EXECUTE FUNCTION template_pkwt_terkunci();

-- Kontrak tidak boleh melewati tahap PERSETUJUAN tanpa template yang sudah diverifikasi.
CREATE FUNCTION kontrak_wajib_template_terverifikasi() RETURNS trigger AS $$
BEGIN
  IF NEW.status NOT IN ('DRAFT', 'REVIEW', 'DIBATALKAN') AND NOT EXISTS (SELECT 1 FROM contract_templates t WHERE t.id = NEW.template_id AND t.verified_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Template PKWT belum diverifikasi; kontrak tidak dapat diproses lebih lanjut';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER employment_contracts_template_terverifikasi BEFORE INSERT OR UPDATE ON employment_contracts FOR EACH ROW EXECUTE FUNCTION kontrak_wajib_template_terverifikasi();

-- Kontrak tidak boleh AKTIF tanpa scan bertanda tangan yang diverifikasi HRD.
CREATE FUNCTION kontrak_aktif_wajib_scan_terverifikasi() RETURNS trigger AS $$
BEGIN
  IF NEW.status IN ('DITANDATANGANI', 'AKTIF', 'BERAKHIR', 'DIAKHIRI_LEBIH_AWAL') AND NOT EXISTS (SELECT 1 FROM contract_documents d WHERE d.contract_id = NEW.id AND d.status = 'TERVERIFIKASI') THEN
    RAISE EXCEPTION 'Kontrak tidak sah tanpa scan bertanda tangan yang sudah diverifikasi HRD';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER employment_contracts_scan_terverifikasi BEFORE UPDATE ON employment_contracts FOR EACH ROW WHEN (NEW.status IS DISTINCT FROM OLD.status) EXECUTE FUNCTION kontrak_aktif_wajib_scan_terverifikasi();

-- Penempatan AKTIF/DITANGGUHKAN hanya bila kontraknya AKTIF.
CREATE FUNCTION penempatan_aktif_wajib_kontrak_aktif() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'AKTIF' AND NOT EXISTS (SELECT 1 FROM employment_contracts c WHERE c.id = NEW.contract_id AND c.status = 'AKTIF') THEN
    RAISE EXCEPTION 'Penempatan hanya dapat aktif bila kontraknya aktif';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER placements_kontrak_aktif BEFORE INSERT OR UPDATE ON placements FOR EACH ROW EXECUTE FUNCTION penempatan_aktif_wajib_kontrak_aktif();

CREATE TRIGGER contract_versions_hanya_tambah BEFORE UPDATE OR DELETE ON contract_versions FOR EACH ROW EXECUTE FUNCTION riwayat_status_tolak_ubah();

-- ---- RLS tenant ----
SELECT enable_tenant_rls('contract_templates');
SELECT enable_tenant_rls('employment_contracts');
SELECT enable_tenant_rls('contract_versions');
SELECT enable_tenant_rls('contract_documents');
SELECT enable_tenant_rls('contract_number_counters');
SELECT enable_tenant_rls('placements');

-- Member membaca kontrak/penempatan MILIKNYA saja (dashboard member), dan lokasi kerja yang dirujuk penempatannya.
CREATE POLICY kontrak_baca_milik ON employment_contracts FOR SELECT USING (person_id = NULLIF(current_setting('app.member_person_id', true), '')::uuid);
CREATE POLICY penempatan_baca_milik ON placements FOR SELECT USING (person_id = NULLIF(current_setting('app.member_person_id', true), '')::uuid);
CREATE POLICY lokasi_baca_penempatan_milik ON partner_locations FOR SELECT
  USING (EXISTS (SELECT 1 FROM placements p WHERE p.location_id = partner_locations.id AND p.person_id = NULLIF(current_setting('app.member_person_id', true), '')::uuid));

-- ---- perubahan otomatis oleh sistem: aktor boleh kosong HANYA untuk entri "Otomatis: ..." ----
ALTER TABLE member_status_histories ALTER COLUMN actor_user_id DROP NOT NULL;
ALTER TABLE member_status_histories ADD CONSTRAINT member_riwayat_aktor_atau_otomatis CHECK (actor_user_id IS NOT NULL OR COALESCE(reason LIKE 'Otomatis:%', false));
ALTER TABLE application_status_histories ALTER COLUMN actor_user_id DROP NOT NULL;
ALTER TABLE application_status_histories ADD CONSTRAINT lamaran_riwayat_aktor_atau_otomatis CHECK (actor_user_id IS NOT NULL OR COALESCE(reason LIKE 'Otomatis:%', false));

-- Down Migration
ALTER TABLE member_status_histories DISABLE TRIGGER USER;
DELETE FROM member_status_histories WHERE actor_user_id IS NULL;
ALTER TABLE member_status_histories ENABLE TRIGGER USER;
ALTER TABLE member_status_histories DROP CONSTRAINT member_riwayat_aktor_atau_otomatis;
ALTER TABLE member_status_histories ALTER COLUMN actor_user_id SET NOT NULL;
ALTER TABLE application_status_histories DISABLE TRIGGER USER;
DELETE FROM application_status_histories WHERE actor_user_id IS NULL;
ALTER TABLE application_status_histories ENABLE TRIGGER USER;
ALTER TABLE application_status_histories DROP CONSTRAINT lamaran_riwayat_aktor_atau_otomatis;
ALTER TABLE application_status_histories ALTER COLUMN actor_user_id SET NOT NULL;
DROP POLICY lokasi_baca_penempatan_milik ON partner_locations;
DROP TABLE placements;
DROP TABLE contract_number_counters;
DROP TABLE contract_documents;
DROP TABLE contract_versions;
DROP TABLE employment_contracts;
DROP TABLE contract_templates;
DROP FUNCTION penempatan_aktif_wajib_kontrak_aktif();
DROP FUNCTION kontrak_aktif_wajib_scan_terverifikasi();
DROP FUNCTION kontrak_wajib_template_terverifikasi();
DROP FUNCTION template_pkwt_terkunci();
