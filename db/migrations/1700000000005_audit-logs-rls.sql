-- Up Migration
-- Menutup pengecualian sementara A-13: audit_logs kini memakai RLS khusus.
-- Baca: baris perusahaan dalam scope, atau baris global (company_id NULL) bila app.audit_global = 'on'.
-- Tulis: selalu boleh (pencatatan audit tidak boleh gagal karena scope). UPDATE/DELETE tidak punya kebijakan
-- (ditolak default) dan juga dijaga trigger append-only; TRUNCATE dijaga trigger.
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;

CREATE POLICY audit_baca ON audit_logs FOR SELECT
  USING (
    company_id = ANY (app_company_ids())
    OR (company_id IS NULL AND current_setting('app.audit_global', true) = 'on')
  );
CREATE POLICY audit_tulis ON audit_logs FOR INSERT WITH CHECK (true);

-- Down Migration
DROP POLICY audit_tulis ON audit_logs;
DROP POLICY audit_baca ON audit_logs;
ALTER TABLE audit_logs NO FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_logs DISABLE ROW LEVEL SECURITY;
