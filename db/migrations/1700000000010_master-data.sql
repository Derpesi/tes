-- Up Migration
-- Master data multi-perusahaan (Fase 4A). Rekanan = master data internal (tanpa akun/login/portal rekanan).
-- Setiap tabel anak membawa company_id yang HARUS sama dengan induknya (FK komposit) dan dijaga RLS (ADR-0003).

-- ---- companies: profil perusahaan grup (companies sendiri tidak ber-RLS; id-nya adalah tenant) ----
ALTER TABLE companies
  ADD COLUMN short_code        text NOT NULL DEFAULT upper('C' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)),
  ADD COLUMN legal_name        text,
  ADD COLUMN npwp              text,
  ADD COLUMN address           text,
  ADD COLUMN city              text,
  ADD COLUMN province          text,
  ADD COLUMN phone             text,
  ADD COLUMN email             text,
  ADD COLUMN logo_object_key   text,
  ADD COLUMN payroll_settings  jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN document_settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN created_by        uuid REFERENCES users (id),
  ADD COLUMN updated_at        timestamptz NOT NULL DEFAULT now();
ALTER TABLE companies
  ADD CONSTRAINT companies_short_code_unik UNIQUE (short_code),
  ADD CONSTRAINT companies_short_code_format CHECK (short_code ~ '^[A-Z0-9]{2,12}$'),
  ADD CONSTRAINT companies_npwp_format CHECK (npwp IS NULL OR npwp ~ '^[0-9]{15,16}$'),
  ADD CONSTRAINT companies_email_format CHECK (email IS NULL OR (email = lower(email) AND position('@' IN email) > 1));

-- ---- approval_requests: subjek bisa perusahaan (aktivasi perusahaan baru) ----
ALTER TABLE approval_requests DROP CONSTRAINT approval_requests_type_check;
ALTER TABLE approval_requests
  ADD CONSTRAINT approval_requests_type_check CHECK (type IN ('BERI_PERAN_TINGGI', 'RESET_MFA', 'BERI_AKSES_SEMUA_PERUSAHAAN', 'AKTIVASI_PERUSAHAAN')),
  ALTER COLUMN subject_user_id DROP NOT NULL,
  ADD COLUMN subject_company_id uuid REFERENCES companies (id),
  ADD CONSTRAINT approval_subjek_tepat_satu CHECK ((subject_user_id IS NOT NULL) <> (subject_company_id IS NOT NULL));

-- ---- dokumen legalitas perusahaan ----
CREATE TABLE company_documents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES companies (id),
  kind              text NOT NULL CHECK (kind IN ('AKTA_PENDIRIAN', 'NIB', 'NPWP', 'SIUP', 'IZIN_ALIH_DAYA', 'LAINNYA')),
  title             text NOT NULL CHECK (length(btrim(title)) > 0 AND length(title) <= 150),
  object_key        text NOT NULL UNIQUE,
  original_filename text NOT NULL CHECK (length(original_filename) BETWEEN 1 AND 150),
  mime_type         text NOT NULL CHECK (mime_type IN ('application/pdf', 'image/png', 'image/jpeg')),
  size_bytes        integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
  sha256            bytea NOT NULL CHECK (length(sha256) = 32),
  valid_until       date,
  status            text NOT NULL DEFAULT 'AKTIF' CHECK (status IN ('AKTIF', 'DIHAPUS')),
  uploaded_by       uuid NOT NULL REFERENCES users (id),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX company_documents_company_idx ON company_documents (company_id, created_at DESC, id DESC);

-- ---- rekanan ----
CREATE TABLE partners (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies (id),
  name          text NOT NULL CHECK (length(btrim(name)) > 0 AND length(name) <= 150),
  legal_name    text CHECK (legal_name IS NULL OR length(legal_name) <= 200),
  address       text,
  city          text,
  province      text,
  service_types text[] NOT NULL DEFAULT '{}',
  status        text NOT NULL DEFAULT 'AKTIF' CHECK (status IN ('AKTIF', 'NONAKTIF')),
  notes         text,
  created_by    uuid NOT NULL REFERENCES users (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT partners_id_company_unik UNIQUE (id, company_id)
);
CREATE UNIQUE INDEX partners_nama_aktif_unik ON partners (company_id, lower(name)) WHERE status = 'AKTIF';
CREATE INDEX partners_company_idx ON partners (company_id, created_at DESC, id DESC);

CREATE TABLE partner_contacts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL,
  partner_id  uuid NOT NULL,
  name        text NOT NULL CHECK (length(btrim(name)) > 0 AND length(name) <= 100),
  role_title  text CHECK (role_title IS NULL OR length(role_title) <= 100),
  phone       text CHECK (phone IS NULL OR phone ~ '^[0-9+() -]{6,25}$'),
  email       text CHECK (email IS NULL OR (email = lower(email) AND position('@' IN email) > 1)),
  is_primary  boolean NOT NULL DEFAULT false,
  status      text NOT NULL DEFAULT 'AKTIF' CHECK (status IN ('AKTIF', 'NONAKTIF')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (partner_id, company_id) REFERENCES partners (id, company_id)
);
CREATE INDEX partner_contacts_partner_idx ON partner_contacts (company_id, partner_id);

CREATE TABLE partner_locations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL,
  partner_id        uuid NOT NULL,
  name              text NOT NULL CHECK (length(btrim(name)) > 0 AND length(name) <= 150),
  address           text,
  city              text,
  province          text,
  latitude          numeric(9, 6) CHECK (latitude BETWEEN -90 AND 90),
  longitude         numeric(9, 6) CHECK (longitude BETWEEN -180 AND 180),
  geofence_radius_m integer NOT NULL DEFAULT 100 CHECK (geofence_radius_m BETWEEN 20 AND 1000),
  status            text NOT NULL DEFAULT 'AKTIF' CHECK (status IN ('AKTIF', 'NONAKTIF')),
  notes             text,
  created_by        uuid NOT NULL REFERENCES users (id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT partner_locations_koordinat_lengkap CHECK ((latitude IS NULL) = (longitude IS NULL)),
  CONSTRAINT partner_locations_id_company_unik UNIQUE (id, company_id),
  FOREIGN KEY (partner_id, company_id) REFERENCES partners (id, company_id)
);
CREATE UNIQUE INDEX partner_locations_nama_aktif_unik ON partner_locations (partner_id, lower(name)) WHERE status = 'AKTIF';
CREATE INDEX partner_locations_partner_idx ON partner_locations (company_id, partner_id);

-- ---- kontrak layanan ----
CREATE TABLE partner_contracts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL,
  partner_id      uuid NOT NULL,
  contract_number text NOT NULL CHECK (length(btrim(contract_number)) > 0 AND length(contract_number) <= 80),
  service_type    text NOT NULL CHECK (length(btrim(service_type)) > 0 AND length(service_type) <= 100),
  start_date      date NOT NULL,
  end_date        date NOT NULL,
  status          text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'AKTIF', 'BERAKHIR', 'DIBATALKAN')),
  notes           text,
  created_by      uuid NOT NULL REFERENCES users (id),
  approved_by     uuid REFERENCES users (id),
  approved_at     timestamptz,
  ended_at        timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT partner_contracts_periode CHECK (end_date >= start_date),
  -- Pemisahan tugas dijaga di database: penyetuju tidak boleh pembuat; kontrak aktif wajib punya persetujuan.
  CONSTRAINT partner_contracts_penyetuju_bukan_pembuat CHECK (approved_by IS NULL OR approved_by <> created_by),
  CONSTRAINT partner_contracts_aktif_wajib_disetujui CHECK (status <> 'AKTIF' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
  CONSTRAINT partner_contracts_nomor_unik UNIQUE (company_id, contract_number),
  CONSTRAINT partner_contracts_id_company_unik UNIQUE (id, company_id),
  FOREIGN KEY (partner_id, company_id) REFERENCES partners (id, company_id)
);
CREATE INDEX partner_contracts_partner_idx ON partner_contracts (company_id, partner_id, created_at DESC);
CREATE INDEX partner_contracts_status_idx ON partner_contracts (company_id, status, end_date);

CREATE TABLE partner_contract_documents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL,
  contract_id       uuid NOT NULL,
  title             text NOT NULL CHECK (length(btrim(title)) > 0 AND length(title) <= 150),
  object_key        text NOT NULL UNIQUE,
  original_filename text NOT NULL CHECK (length(original_filename) BETWEEN 1 AND 150),
  mime_type         text NOT NULL CHECK (mime_type IN ('application/pdf', 'image/png', 'image/jpeg')),
  size_bytes        integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
  sha256            bytea NOT NULL CHECK (length(sha256) = 32),
  status            text NOT NULL DEFAULT 'AKTIF' CHECK (status IN ('AKTIF', 'DIHAPUS')),
  uploaded_by       uuid NOT NULL REFERENCES users (id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (contract_id, company_id) REFERENCES partner_contracts (id, company_id)
);
CREATE INDEX partner_contract_documents_idx ON partner_contract_documents (company_id, contract_id);

-- ---- kebutuhan tenaga kerja per lokasi ----
CREATE TABLE manpower_requirements (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL,
  location_id uuid NOT NULL,
  position    text NOT NULL CHECK (length(btrim(position)) > 0 AND length(position) <= 100),
  headcount   integer NOT NULL CHECK (headcount BETWEEN 0 AND 100000),
  valid_from  date NOT NULL,
  valid_to    date,
  notes       text,
  created_by  uuid NOT NULL REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT manpower_requirements_periode CHECK (valid_to IS NULL OR valid_to >= valid_from),
  FOREIGN KEY (location_id, company_id) REFERENCES partner_locations (id, company_id)
);
CREATE INDEX manpower_requirements_lokasi_idx ON manpower_requirements (company_id, location_id, valid_from DESC);

-- ---- RLS tenant (ADR-0003) ----
SELECT enable_tenant_rls('company_documents');
SELECT enable_tenant_rls('partners');
SELECT enable_tenant_rls('partner_contacts');
SELECT enable_tenant_rls('partner_locations');
SELECT enable_tenant_rls('partner_contracts');
SELECT enable_tenant_rls('partner_contract_documents');
SELECT enable_tenant_rls('manpower_requirements');

-- Down Migration
DROP TABLE manpower_requirements;
DROP TABLE partner_contract_documents;
DROP TABLE partner_contracts;
DROP TABLE partner_locations;
DROP TABLE partner_contacts;
DROP TABLE partners;
DROP TABLE company_documents;
DELETE FROM approval_requests WHERE type = 'AKTIVASI_PERUSAHAAN';
ALTER TABLE approval_requests
  DROP CONSTRAINT approval_subjek_tepat_satu,
  DROP COLUMN subject_company_id,
  ALTER COLUMN subject_user_id SET NOT NULL;
ALTER TABLE approval_requests DROP CONSTRAINT approval_requests_type_check;
ALTER TABLE approval_requests ADD CONSTRAINT approval_requests_type_check CHECK (type IN ('BERI_PERAN_TINGGI', 'RESET_MFA', 'BERI_AKSES_SEMUA_PERUSAHAAN'));
ALTER TABLE companies
  DROP CONSTRAINT companies_email_format,
  DROP CONSTRAINT companies_npwp_format,
  DROP CONSTRAINT companies_short_code_format,
  DROP CONSTRAINT companies_short_code_unik,
  DROP COLUMN updated_at, DROP COLUMN created_by, DROP COLUMN document_settings, DROP COLUMN payroll_settings,
  DROP COLUMN logo_object_key, DROP COLUMN email, DROP COLUMN phone, DROP COLUMN province, DROP COLUMN city,
  DROP COLUMN address, DROP COLUMN npwp, DROP COLUMN legal_name, DROP COLUMN short_code;
