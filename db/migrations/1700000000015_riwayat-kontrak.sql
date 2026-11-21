-- Up Migration
-- Riwayat status kontrak (hanya-tambah). Aktor boleh kosong HANYA untuk perubahan otomatis oleh sistem ("Otomatis: ...").
CREATE TABLE contract_status_histories (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL,
  contract_id   uuid NOT NULL,
  from_status   text,
  to_status     text NOT NULL,
  actor_user_id uuid REFERENCES users (id),
  reason        text CHECK (reason IS NULL OR length(reason) <= 500),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contract_riwayat_aktor_atau_otomatis CHECK (actor_user_id IS NOT NULL OR COALESCE(reason LIKE 'Otomatis:%', false)),
  FOREIGN KEY (contract_id, company_id) REFERENCES employment_contracts (id, company_id)
);
CREATE INDEX contract_status_histories_idx ON contract_status_histories (company_id, contract_id, created_at DESC, id DESC);
CREATE TRIGGER contract_status_histories_hanya_tambah BEFORE UPDATE OR DELETE ON contract_status_histories FOR EACH ROW EXECUTE FUNCTION riwayat_status_tolak_ubah();
SELECT enable_tenant_rls('contract_status_histories');

-- Down Migration
DROP TABLE contract_status_histories;
