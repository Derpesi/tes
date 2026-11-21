-- Up Migration
-- Fase 5: profil member (global, tanpa company_id), dokumen identitas, riwayat status, lowongan, lamaran. ADR-0006.

-- ---- member (lintas perusahaan: tanpa kolom company_id; akses staff dijaga permission member.*, self-service dijaga person_id) ----
CREATE TABLE member_profiles (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id               uuid NOT NULL UNIQUE REFERENCES persons (id),
  status                  text NOT NULL DEFAULT 'TERDAFTAR' CHECK (status IN (
    'TERDAFTAR', 'PROFIL_BELUM_LENGKAP', 'MENUNGGU_VERIFIKASI', 'TERVERIFIKASI', 'BELUM_DITEMPATKAN',
    'KARYAWAN_AKTIF', 'KONTRAK_AKAN_BERAKHIR', 'KONTRAK_BERAKHIR', 'NONAKTIF')),
  full_name               text CHECK (full_name IS NULL OR (length(btrim(full_name)) > 0 AND length(full_name) <= 150)),
  -- NIK tidak pernah disimpan terang: AES-GCM (AAD "member_profile:<id>") + blind index HMAC berprefiks domain untuk keunikan.
  nik_enc                 bytea,
  nik_hmac                bytea UNIQUE CHECK (nik_hmac IS NULL OR length(nik_hmac) = 32),
  key_version             smallint NOT NULL DEFAULT 1,
  birth_place             text CHECK (birth_place IS NULL OR length(birth_place) <= 100),
  birth_date              date CHECK (birth_date IS NULL OR (birth_date >= DATE '1900-01-01' AND birth_date <= current_date)),
  gender                  text CHECK (gender IS NULL OR gender IN ('L', 'P')),
  address                 text CHECK (address IS NULL OR length(address) <= 300),
  city                    text CHECK (city IS NULL OR length(city) <= 100),
  province                text CHECK (province IS NULL OR length(province) <= 100),
  phone                   text CHECK (phone IS NULL OR phone ~ '^[0-9+() -]{6,25}$'),
  education               text CHECK (education IS NULL OR length(education) <= 50),
  emergency_contact_name  text CHECK (emergency_contact_name IS NULL OR length(emergency_contact_name) <= 100),
  emergency_contact_phone text CHECK (emergency_contact_phone IS NULL OR emergency_contact_phone ~ '^[0-9+() -]{6,25}$'),
  review_note             text CHECK (review_note IS NULL OR length(review_note) <= 500),
  submitted_at            timestamptz,
  verified_by             uuid REFERENCES users (id),
  verified_at             timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  -- Setelah diajukan, biodata wajib lengkap (dijaga database, bukan hanya aplikasi).
  CONSTRAINT member_lengkap_saat_diajukan CHECK (
    status IN ('TERDAFTAR', 'PROFIL_BELUM_LENGKAP') OR (
      full_name IS NOT NULL AND nik_enc IS NOT NULL AND nik_hmac IS NOT NULL AND birth_place IS NOT NULL AND birth_date IS NOT NULL
      AND gender IS NOT NULL AND address IS NOT NULL AND city IS NOT NULL AND province IS NOT NULL AND phone IS NOT NULL
      AND education IS NOT NULL AND emergency_contact_name IS NOT NULL AND emergency_contact_phone IS NOT NULL)),
  CONSTRAINT member_terverifikasi_punya_pemeriksa CHECK (
    status NOT IN ('TERVERIFIKASI', 'BELUM_DITEMPATKAN', 'KARYAWAN_AKTIF', 'KONTRAK_AKAN_BERAKHIR', 'KONTRAK_BERAKHIR') OR (verified_by IS NOT NULL AND verified_at IS NOT NULL))
);
CREATE INDEX member_profiles_status_idx ON member_profiles (status, created_at DESC, id DESC);

CREATE TABLE member_documents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id         uuid NOT NULL REFERENCES persons (id),
  kind              text NOT NULL CHECK (kind IN ('KTP', 'FOTO_DIRI', 'IJAZAH', 'LAINNYA')),
  object_key        text NOT NULL UNIQUE,
  original_filename text NOT NULL CHECK (length(original_filename) BETWEEN 1 AND 150),
  mime_type         text NOT NULL CHECK (mime_type IN ('application/pdf', 'image/png', 'image/jpeg')),
  size_bytes        integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
  sha256            bytea NOT NULL CHECK (length(sha256) = 32),
  status            text NOT NULL DEFAULT 'AKTIF' CHECK (status IN ('AKTIF', 'DIHAPUS')),
  created_at        timestamptz NOT NULL DEFAULT now()
);
-- Satu KTP dan satu foto diri aktif per orang; ganti = hapus lalu unggah ulang.
CREATE UNIQUE INDEX member_documents_satu_aktif ON member_documents (person_id, kind) WHERE status = 'AKTIF' AND kind IN ('KTP', 'FOTO_DIRI');
CREATE INDEX member_documents_person_idx ON member_documents (person_id, created_at DESC);

CREATE TABLE member_status_histories (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id     uuid NOT NULL REFERENCES persons (id),
  from_status   text,
  to_status     text NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users (id),
  reason        text CHECK (reason IS NULL OR length(reason) <= 500),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX member_status_histories_idx ON member_status_histories (person_id, created_at DESC, id DESC);

-- ---- lowongan (ber-company_id = perusahaan pengelola; RLS tenant + baca lintas perusahaan untuk member) ----
CREATE TABLE job_vacancies (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies (id),
  title          text NOT NULL CHECK (length(btrim(title)) > 0 AND length(title) <= 150),
  description    text NOT NULL CHECK (length(btrim(description)) > 0 AND length(description) <= 5000),
  location_id    uuid,
  positions      integer NOT NULL DEFAULT 1 CHECK (positions BETWEEN 1 AND 10000),
  status         text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'DIBUKA', 'DITUTUP')),
  closes_on      date,
  internal_notes text CHECK (internal_notes IS NULL OR length(internal_notes) <= 1000),
  created_by     uuid NOT NULL REFERENCES users (id),
  opened_at      timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT job_vacancies_id_company_unik UNIQUE (id, company_id),
  FOREIGN KEY (location_id, company_id) REFERENCES partner_locations (id, company_id)
);
CREATE INDEX job_vacancies_company_idx ON job_vacancies (company_id, created_at DESC, id DESC);
CREATE INDEX job_vacancies_terbuka_idx ON job_vacancies (status, closes_on) WHERE status = 'DIBUKA';

CREATE TABLE job_applications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL,
  vacancy_id  uuid NOT NULL,
  person_id   uuid NOT NULL REFERENCES persons (id),
  status      text NOT NULL DEFAULT 'DIAJUKAN' CHECK (status IN ('DIAJUKAN', 'SELEKSI_ADMINISTRASI', 'INTERVIEW', 'DITERIMA', 'MENUNGGU_PKWT', 'DITOLAK', 'DITARIK')),
  note        text CHECK (note IS NULL OR length(note) <= 500),
  decided_by  uuid REFERENCES users (id),
  decided_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT job_applications_id_company_unik UNIQUE (id, company_id),
  FOREIGN KEY (vacancy_id, company_id) REFERENCES job_vacancies (id, company_id)
);
-- Satu lamaran per orang per lowongan (lamaran yang ditarik tidak menghalangi lamaran ulang).
CREATE UNIQUE INDEX job_applications_satu_per_lowongan ON job_applications (vacancy_id, person_id) WHERE status <> 'DITARIK';
CREATE INDEX job_applications_company_idx ON job_applications (company_id, created_at DESC, id DESC);
CREATE INDEX job_applications_person_idx ON job_applications (person_id, created_at DESC, id DESC);

CREATE TABLE application_status_histories (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL,
  application_id uuid NOT NULL,
  from_status    text,
  to_status      text NOT NULL,
  actor_user_id  uuid NOT NULL REFERENCES users (id),
  reason         text CHECK (reason IS NULL OR length(reason) <= 500),
  created_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (application_id, company_id) REFERENCES job_applications (id, company_id)
);
CREATE INDEX application_status_histories_idx ON application_status_histories (company_id, application_id, created_at DESC);

-- ---- riwayat hanya-tambah ----
CREATE FUNCTION riwayat_status_tolak_ubah() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Riwayat status bersifat hanya-tambah (tidak boleh diubah atau dihapus)';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER member_status_histories_hanya_tambah BEFORE UPDATE OR DELETE ON member_status_histories FOR EACH ROW EXECUTE FUNCTION riwayat_status_tolak_ubah();
CREATE TRIGGER application_status_histories_hanya_tambah BEFORE UPDATE OR DELETE ON application_status_histories FOR EACH ROW EXECUTE FUNCTION riwayat_status_tolak_ubah();

-- ---- RLS ----
SELECT enable_tenant_rls('job_vacancies');
SELECT enable_tenant_rls('job_applications');
SELECT enable_tenant_rls('application_status_histories');

-- Member (tanpa scope perusahaan) membaca lowongan DIBUKA semua perusahaan. Diaktifkan HANYA oleh ScopedDb.tx({ memberRead: true }).
CREATE POLICY lowongan_baca_member ON job_vacancies FOR SELECT
  USING (current_setting('app.member_read', true) = 'on' AND status = 'DIBUKA' AND (closes_on IS NULL OR closes_on >= current_date));

-- Member hanya menyentuh lamaran miliknya: baca, buat (hanya ke lowongan yang terlihat/terbuka), dan menarik.
CREATE POLICY lamaran_baca_milik ON job_applications FOR SELECT
  USING (person_id = NULLIF(current_setting('app.member_person_id', true), '')::uuid);
CREATE POLICY lamaran_buat_milik ON job_applications FOR INSERT
  WITH CHECK (
    person_id = NULLIF(current_setting('app.member_person_id', true), '')::uuid
    AND status = 'DIAJUKAN'
    AND EXISTS (SELECT 1 FROM job_vacancies v WHERE v.id = vacancy_id AND v.company_id = job_applications.company_id));
CREATE POLICY lamaran_tarik_milik ON job_applications FOR UPDATE
  USING (person_id = NULLIF(current_setting('app.member_person_id', true), '')::uuid)
  WITH CHECK (person_id = NULLIF(current_setting('app.member_person_id', true), '')::uuid AND status = 'DITARIK');
CREATE POLICY riwayat_lamaran_baca_milik ON application_status_histories FOR SELECT
  USING (EXISTS (SELECT 1 FROM job_applications a WHERE a.id = application_id));
CREATE POLICY riwayat_lamaran_buat_milik ON application_status_histories FOR INSERT
  WITH CHECK (actor_user_id IS NOT NULL AND EXISTS (SELECT 1 FROM job_applications a WHERE a.id = application_id AND a.company_id = application_status_histories.company_id));

-- Down Migration
DROP TABLE application_status_histories;
DROP TABLE job_applications;
DROP TABLE job_vacancies;
DROP TABLE member_status_histories;
DROP TABLE member_documents;
DROP TABLE member_profiles;
DROP FUNCTION riwayat_status_tolak_ubah();
