-- Up Migration
-- Fase 7: absensi QR + GPS + selfie (online-only). ADR-0008.
-- QR = pengenal titik (BUKAN rahasia). Waktu rekaman = waktu SERVER. Tanpa face recognition.

-- Toleransi per lokasi (menggantikan toleransi pola shift bila diisi).
ALTER TABLE partner_locations
  ADD COLUMN attendance_late_tolerance_min integer CHECK (attendance_late_tolerance_min IS NULL OR attendance_late_tolerance_min BETWEEN 0 AND 240),
  ADD COLUMN attendance_early_tolerance_min integer CHECK (attendance_early_tolerance_min IS NULL OR attendance_early_tolerance_min BETWEEN 0 AND 240);

CREATE TABLE attendance_points (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL,
  location_id uuid NOT NULL,
  public_code uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  status      text NOT NULL DEFAULT 'AKTIF' CHECK (status IN ('AKTIF', 'NONAKTIF')),
  created_by  uuid NOT NULL REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attendance_points_id_company_unik UNIQUE (id, company_id),
  FOREIGN KEY (location_id, company_id) REFERENCES partner_locations (id, company_id)
);
CREATE UNIQUE INDEX attendance_points_satu_aktif_per_lokasi ON attendance_points (location_id) WHERE status = 'AKTIF';
CREATE INDEX attendance_points_company_idx ON attendance_points (company_id, created_at DESC, id DESC);

CREATE TABLE shift_patterns (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES companies (id),
  name                text NOT NULL CHECK (length(btrim(name)) > 0 AND length(name) <= 80),
  kind                text NOT NULL DEFAULT 'FIXED' CHECK (kind IN ('FIXED', 'FLEXIBLE')),
  start_time          time NOT NULL,
  end_time            time NOT NULL,
  crosses_midnight    boolean NOT NULL DEFAULT false,
  late_tolerance_min  integer NOT NULL DEFAULT 15 CHECK (late_tolerance_min BETWEEN 0 AND 240),
  early_tolerance_min integer NOT NULL DEFAULT 30 CHECK (early_tolerance_min BETWEEN 0 AND 240),
  status              text NOT NULL DEFAULT 'AKTIF' CHECK (status IN ('AKTIF', 'NONAKTIF')),
  created_by          uuid NOT NULL REFERENCES users (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shift_patterns_id_company_unik UNIQUE (id, company_id),
  CONSTRAINT shift_patterns_nama_unik UNIQUE (company_id, name),
  -- Lintas tengah malam bila dan hanya bila jam selesai <= jam mulai.
  CONSTRAINT shift_patterns_lintas_tengah_malam CHECK (crosses_midnight = (end_time <= start_time))
);

CREATE TABLE work_schedules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL,
  placement_id uuid NOT NULL,
  shift_id    uuid NOT NULL,
  work_days   smallint[] NOT NULL CHECK (cardinality(work_days) BETWEEN 1 AND 7 AND work_days <@ ARRAY[1,2,3,4,5,6,7]::smallint[]),
  valid_from  date NOT NULL,
  valid_to    date,
  created_by  uuid NOT NULL REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT work_schedules_periode CHECK (valid_to IS NULL OR valid_to >= valid_from),
  FOREIGN KEY (placement_id, company_id) REFERENCES placements (id, company_id),
  FOREIGN KEY (shift_id, company_id) REFERENCES shift_patterns (id, company_id)
);
CREATE INDEX work_schedules_penempatan_idx ON work_schedules (company_id, placement_id, valid_from);

CREATE TABLE holidays (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL,
  holiday_date date NOT NULL,
  scope        text NOT NULL CHECK (scope IN ('NASIONAL', 'PERUSAHAAN', 'LOKASI')),
  location_id  uuid,
  name         text NOT NULL CHECK (length(btrim(name)) > 0 AND length(name) <= 120),
  created_by   uuid NOT NULL REFERENCES users (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT holidays_lokasi_sesuai_cakupan CHECK ((scope = 'LOKASI') = (location_id IS NOT NULL)),
  FOREIGN KEY (company_id) REFERENCES companies (id),
  FOREIGN KEY (location_id, company_id) REFERENCES partner_locations (id, company_id)
);
CREATE UNIQUE INDEX holidays_unik ON holidays (company_id, holiday_date, scope, COALESCE(location_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE TABLE device_registrations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies (id),
  person_id     uuid NOT NULL REFERENCES persons (id),
  device_hash   text NOT NULL CHECK (device_hash ~ '^[0-9a-f]{64}$'),
  status        text NOT NULL DEFAULT 'PERLU_VERIFIKASI' CHECK (status IN ('DISETUJUI', 'PERLU_VERIFIKASI', 'DITOLAK')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT device_registrations_id_company_unik UNIQUE (id, company_id),
  CONSTRAINT device_registrations_unik UNIQUE (company_id, person_id, device_hash)
);
CREATE INDEX device_registrations_hash_idx ON device_registrations (device_hash);

CREATE TABLE attendance_records (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL,
  person_id       uuid NOT NULL REFERENCES persons (id),
  placement_id    uuid NOT NULL,
  point_id        uuid NOT NULL,
  location_id     uuid NOT NULL,
  shift_id        uuid,
  device_id       uuid,
  kind            text NOT NULL CHECK (kind IN ('MASUK', 'PULANG')),
  status          text NOT NULL CHECK (status IN ('VALID', 'PERLU_VERIFIKASI', 'DITOLAK')),
  reject_reason   text CHECK (reject_reason IS NULL OR length(reject_reason) <= 100),
  shift_date      date NOT NULL,
  occurred_at     timestamptz NOT NULL DEFAULT now(), -- waktu SERVER
  client_time     timestamptz,
  latitude        numeric(9, 6) CHECK (latitude BETWEEN -90 AND 90),
  longitude       numeric(9, 6) CHECK (longitude BETWEEN -180 AND 180),
  accuracy_m      numeric(8, 1) CHECK (accuracy_m IS NULL OR accuracy_m >= 0),
  distance_m      numeric(10, 1) CHECK (distance_m IS NULL OR distance_m >= 0),
  anomaly_score   integer NOT NULL DEFAULT 0 CHECK (anomaly_score >= 0),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 100),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attendance_records_id_company_unik UNIQUE (id, company_id),
  CONSTRAINT attendance_records_idempotensi_unik UNIQUE (person_id, idempotency_key),
  CONSTRAINT attendance_records_koordinat_lengkap CHECK ((latitude IS NULL) = (longitude IS NULL)),
  CONSTRAINT attendance_records_alasan_tolak CHECK ((status = 'DITOLAK') = (reject_reason IS NOT NULL)),
  FOREIGN KEY (placement_id, company_id) REFERENCES placements (id, company_id),
  FOREIGN KEY (point_id, company_id) REFERENCES attendance_points (id, company_id),
  FOREIGN KEY (location_id, company_id) REFERENCES partner_locations (id, company_id),
  FOREIGN KEY (shift_id, company_id) REFERENCES shift_patterns (id, company_id),
  FOREIGN KEY (device_id, company_id) REFERENCES device_registrations (id, company_id)
);
-- Satu absen MASUK/PULANG per orang per titik per tanggal-shift (percobaan ditolak tidak dihitung).
CREATE UNIQUE INDEX attendance_records_tanpa_duplikat ON attendance_records (person_id, point_id, kind, shift_date) WHERE status <> 'DITOLAK';
CREATE INDEX attendance_records_orang_idx ON attendance_records (person_id, shift_date DESC, occurred_at DESC);
CREATE INDEX attendance_records_titik_idx ON attendance_records (point_id, occurred_at DESC);
CREATE INDEX attendance_records_company_idx ON attendance_records (company_id, shift_date DESC, id DESC);
CREATE INDEX attendance_records_antrean_idx ON attendance_records (company_id, occurred_at DESC, id DESC) WHERE status = 'PERLU_VERIFIKASI';

CREATE TABLE attendance_selfies (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL,
  record_id    uuid NOT NULL UNIQUE,
  storage_key  text NOT NULL,
  sha256       text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes   integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 307200),
  purge_after  timestamptz NOT NULL,
  legal_hold   boolean NOT NULL DEFAULT false,
  purged_at    timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (record_id, company_id) REFERENCES attendance_records (id, company_id)
);
CREATE INDEX attendance_selfies_purge_idx ON attendance_selfies (purge_after) WHERE purged_at IS NULL AND legal_hold = false;

CREATE TABLE attendance_flags (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  record_id  uuid NOT NULL,
  code       text NOT NULL CHECK (length(code) BETWEEN 1 AND 60),
  score      integer NOT NULL DEFAULT 0 CHECK (score >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attendance_flags_unik UNIQUE (record_id, code),
  FOREIGN KEY (record_id, company_id) REFERENCES attendance_records (id, company_id)
);

-- Tinjauan dua langkah: PayAbs memeriksa (PERIKSA), Mgr Ops memutuskan (PUTUSAN). Hanya-tambah.
CREATE TABLE attendance_reviews (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  record_id  uuid NOT NULL,
  stage      text NOT NULL CHECK (stage IN ('PERIKSA', 'PUTUSAN')),
  decision   text NOT NULL CHECK (decision IN ('DIPERIKSA', 'DISETUJUI', 'DITOLAK')),
  actor_id   uuid NOT NULL REFERENCES users (id),
  reason     text NOT NULL CHECK (length(btrim(reason)) > 0 AND length(reason) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attendance_reviews_tahap_sesuai CHECK ((stage = 'PERIKSA') = (decision = 'DIPERIKSA')),
  CONSTRAINT attendance_reviews_satu_per_tahap UNIQUE (record_id, stage),
  FOREIGN KEY (record_id, company_id) REFERENCES attendance_records (id, company_id)
);
CREATE FUNCTION tinjauan_absensi_sod() RETURNS trigger AS $$
BEGIN
  IF NEW.stage = 'PUTUSAN' THEN
    IF NOT EXISTS (SELECT 1 FROM attendance_reviews r WHERE r.record_id = NEW.record_id AND r.stage = 'PERIKSA') THEN
      RAISE EXCEPTION 'Putusan tinjauan wajib didahului pemeriksaan' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM attendance_reviews r WHERE r.record_id = NEW.record_id AND r.stage = 'PERIKSA' AND r.actor_id = NEW.actor_id) THEN
      RAISE EXCEPTION 'Pemeriksa dan pemutus tinjauan harus orang berbeda' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER attendance_reviews_sod BEFORE INSERT ON attendance_reviews FOR EACH ROW EXECUTE FUNCTION tinjauan_absensi_sod();
CREATE TRIGGER attendance_reviews_hanya_tambah BEFORE UPDATE OR DELETE ON attendance_reviews FOR EACH ROW EXECUTE FUNCTION riwayat_status_tolak_ubah();

-- Koreksi bernomor; rekaman asli TIDAK diubah.
CREATE TABLE attendance_adjustments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies (id),
  adjustment_no text NOT NULL CHECK (length(btrim(adjustment_no)) > 0),
  person_id     uuid NOT NULL REFERENCES persons (id),
  shift_date    date NOT NULL,
  record_id     uuid,
  effect        text NOT NULL CHECK (effect IN ('HADIR', 'TIDAK_HADIR', 'IZIN', 'SAKIT')),
  reason        text NOT NULL CHECK (length(btrim(reason)) > 0 AND length(reason) <= 500),
  status        text NOT NULL DEFAULT 'DIAJUKAN' CHECK (status IN ('DIAJUKAN', 'DISETUJUI', 'DITOLAK')),
  created_by    uuid NOT NULL REFERENCES users (id),
  decided_by    uuid REFERENCES users (id),
  decided_at    timestamptz,
  decision_note text CHECK (decision_note IS NULL OR length(decision_note) <= 500),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attendance_adjustments_nomor_unik UNIQUE (company_id, adjustment_no),
  CONSTRAINT attendance_adjustments_sod CHECK (decided_by IS NULL OR decided_by <> created_by),
  CONSTRAINT attendance_adjustments_putusan_lengkap CHECK ((status = 'DIAJUKAN') = (decided_by IS NULL AND decided_at IS NULL)),
  FOREIGN KEY (record_id, company_id) REFERENCES attendance_records (id, company_id)
);
CREATE INDEX attendance_adjustments_idx ON attendance_adjustments (company_id, person_id, shift_date);

-- Tampilan efektif: status akhir = putusan tinjauan, atau status asli. Memakai hak peminta (RLS tetap berlaku).
CREATE VIEW attendance_effective WITH (security_invoker = true) AS
SELECT r.id, r.company_id, r.person_id, r.location_id, r.shift_id, r.kind, r.shift_date, r.occurred_at, r.status AS original_status,
       COALESCE(v.decision, r.status) AS effective_status
FROM attendance_records r
LEFT JOIN attendance_reviews v ON v.record_id = r.id AND v.stage = 'PUTUSAN';

-- ---- RLS ----
SELECT enable_tenant_rls('attendance_points');
SELECT enable_tenant_rls('shift_patterns');
SELECT enable_tenant_rls('work_schedules');
SELECT enable_tenant_rls('holidays');
SELECT enable_tenant_rls('device_registrations');
SELECT enable_tenant_rls('attendance_records');
SELECT enable_tenant_rls('attendance_selfies');
SELECT enable_tenant_rls('attendance_flags');
SELECT enable_tenant_rls('attendance_reviews');
SELECT enable_tenant_rls('attendance_adjustments');

-- Member membaca rekaman, koreksi, perangkat, dan jadwal MILIKNYA saja.
CREATE POLICY absensi_baca_milik ON attendance_records FOR SELECT USING (person_id = NULLIF(current_setting('app.member_person_id', true), '')::uuid);
CREATE POLICY absensi_koreksi_baca_milik ON attendance_adjustments FOR SELECT USING (person_id = NULLIF(current_setting('app.member_person_id', true), '')::uuid);
CREATE POLICY perangkat_baca_milik ON device_registrations FOR SELECT USING (person_id = NULLIF(current_setting('app.member_person_id', true), '')::uuid);
-- Penulisan absen oleh member sendiri (alur POST /member/attendance): hanya baris atas nama dirinya.
CREATE POLICY absensi_tulis_milik ON attendance_records FOR INSERT WITH CHECK (person_id = NULLIF(current_setting('app.member_person_id', true), '')::uuid);
CREATE POLICY perangkat_tulis_milik ON device_registrations FOR INSERT WITH CHECK (person_id = NULLIF(current_setting('app.member_person_id', true), '')::uuid);
CREATE POLICY perangkat_ubah_milik ON device_registrations FOR UPDATE USING (person_id = NULLIF(current_setting('app.member_person_id', true), '')::uuid) WITH CHECK (person_id = NULLIF(current_setting('app.member_person_id', true), '')::uuid);
-- Member membaca titik aktif yang dipindainya, jadwal, shift, dan libur penempatannya sendiri.
CREATE POLICY titik_baca_penempatan_milik ON attendance_points FOR SELECT
  USING (EXISTS (SELECT 1 FROM placements p WHERE p.location_id = attendance_points.location_id AND p.person_id = NULLIF(current_setting('app.member_person_id', true), '')::uuid));
CREATE POLICY jadwal_baca_milik ON work_schedules FOR SELECT
  USING (EXISTS (SELECT 1 FROM placements p WHERE p.id = work_schedules.placement_id AND p.person_id = NULLIF(current_setting('app.member_person_id', true), '')::uuid));
CREATE POLICY shift_baca_penempatan_milik ON shift_patterns FOR SELECT
  USING (EXISTS (SELECT 1 FROM work_schedules w JOIN placements p ON p.id = w.placement_id WHERE w.shift_id = shift_patterns.id AND p.person_id = NULLIF(current_setting('app.member_person_id', true), '')::uuid));
CREATE POLICY libur_baca_penempatan_milik ON holidays FOR SELECT
  USING (EXISTS (SELECT 1 FROM placements p WHERE p.company_id = holidays.company_id AND p.person_id = NULLIF(current_setting('app.member_person_id', true), '')::uuid));
CREATE POLICY absensi_flag_tulis_milik ON attendance_flags FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM attendance_records r WHERE r.id = attendance_flags.record_id AND r.person_id = NULLIF(current_setting('app.member_person_id', true), '')::uuid));
CREATE POLICY absensi_selfie_tulis_milik ON attendance_selfies FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM attendance_records r WHERE r.id = attendance_selfies.record_id AND r.person_id = NULLIF(current_setting('app.member_person_id', true), '')::uuid));

-- Down Migration
DROP POLICY shift_baca_penempatan_milik ON shift_patterns;
DROP VIEW attendance_effective;
DROP TABLE attendance_adjustments;
DROP TABLE attendance_reviews;
DROP FUNCTION tinjauan_absensi_sod();
DROP TABLE attendance_flags;
DROP TABLE attendance_selfies;
DROP TABLE attendance_records;
DROP TABLE device_registrations;
DROP TABLE holidays;
DROP TABLE work_schedules;
DROP TABLE shift_patterns;
DROP TABLE attendance_points;
ALTER TABLE partner_locations DROP COLUMN attendance_late_tolerance_min, DROP COLUMN attendance_early_tolerance_min;
