-- Up Migration
-- Riwayat status penempatan (hanya-tambah; aktor boleh kosong hanya untuk "Otomatis: ...") dan penanda pemindahan.
ALTER TABLE placements ADD COLUMN replaced_by_id uuid;
ALTER TABLE placements ADD CONSTRAINT placements_pengganti_fk FOREIGN KEY (replaced_by_id, company_id) REFERENCES placements (id, company_id);

CREATE TABLE placement_status_histories (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL,
  placement_id  uuid NOT NULL,
  from_status   text,
  to_status     text NOT NULL,
  actor_user_id uuid REFERENCES users (id),
  reason        text CHECK (reason IS NULL OR length(reason) <= 500),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT placement_riwayat_aktor_atau_otomatis CHECK (actor_user_id IS NOT NULL OR COALESCE(reason LIKE 'Otomatis:%', false)),
  FOREIGN KEY (placement_id, company_id) REFERENCES placements (id, company_id)
);
CREATE INDEX placement_status_histories_idx ON placement_status_histories (company_id, placement_id, created_at DESC, id DESC);
CREATE TRIGGER placement_status_histories_hanya_tambah BEFORE UPDATE OR DELETE ON placement_status_histories FOR EACH ROW EXECUTE FUNCTION riwayat_status_tolak_ubah();
SELECT enable_tenant_rls('placement_status_histories');

-- Down Migration
DROP TABLE placement_status_histories;
ALTER TABLE placements DROP CONSTRAINT placements_pengganti_fk;
ALTER TABLE placements DROP COLUMN replaced_by_id;
