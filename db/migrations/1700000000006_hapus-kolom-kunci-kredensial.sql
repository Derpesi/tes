-- Up Migration
-- Kunci akun dihitung dari login_attempts (berlaku juga untuk email yang tidak terdaftar, agar tidak
-- membocorkan keberadaan akun). Kolom di staff_credentials tidak dipakai.
ALTER TABLE staff_credentials DROP COLUMN failed_attempts, DROP COLUMN locked_until;

-- Down Migration
ALTER TABLE staff_credentials
  ADD COLUMN failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  ADD COLUMN locked_until timestamptz;
