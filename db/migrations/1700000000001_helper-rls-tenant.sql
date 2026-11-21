-- Up Migration
-- Helper isolasi perusahaan (ADR-0003, diusulkan). Tidak membuat tabel bisnis.
-- Scope perusahaan dikirim per transaksi: set_config('app.company_ids', '<uuid>,<uuid>', true),
-- diturunkan dari sesi server. Kosong/tidak diatur = tidak ada akses (deny-by-default).
CREATE FUNCTION app_company_ids() RETURNS uuid[]
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    string_to_array(NULLIF(current_setting('app.company_ids', true), ''), ',')::uuid[],
    ARRAY[]::uuid[]
  )
$$;

-- Mengaktifkan RLS terpaksa (FORCE) dan kebijakan isolasi pada tabel yang punya kolom company_id uuid.
CREATE FUNCTION enable_tenant_rls(tbl regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %s', tbl);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s USING (company_id = ANY (app_company_ids())) WITH CHECK (company_id = ANY (app_company_ids()))',
    tbl
  );
END;
$$;

-- Down Migration
DROP FUNCTION enable_tenant_rls(regclass);
DROP FUNCTION app_company_ids();
