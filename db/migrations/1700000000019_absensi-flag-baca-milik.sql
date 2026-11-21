-- Up Migration
-- Fase 7E: member harus dapat membaca penanda (flag) rekaman MILIKNYA sendiri pada riwayat absensi. Ditemukan oleh E2E: tanpa kebijakan ini
-- RLS menyembunyikan seluruh penanda dari riwayat member (hanya kebijakan tulis yang ada).
CREATE POLICY absensi_flag_baca_milik ON attendance_flags FOR SELECT
  USING (EXISTS (SELECT 1 FROM attendance_records r WHERE r.id = attendance_flags.record_id AND r.person_id = NULLIF(current_setting('app.member_person_id', true), '')::uuid));

-- Down Migration
DROP POLICY absensi_flag_baca_milik ON attendance_flags;
