-- Up Migration
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE audit_logs (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  action      text        NOT NULL,
  actor_id    uuid,
  company_id  uuid,
  object_type text,
  object_id   text,
  detail      jsonb       NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_logs_occurred_at_idx ON audit_logs (occurred_at);
CREATE INDEX audit_logs_company_idx ON audit_logs (company_id, occurred_at);
CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_id, occurred_at);

-- Audit log bersifat hanya-tambah: tolak UPDATE, DELETE, dan TRUNCATE.
CREATE FUNCTION audit_logs_tolak_ubah() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs bersifat append-only: % ditolak', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_tolak_ubah();
CREATE TRIGGER audit_logs_no_truncate
  BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_tolak_ubah();

-- Down Migration
DROP TRIGGER audit_logs_no_truncate ON audit_logs;
DROP TRIGGER audit_logs_no_update_delete ON audit_logs;
DROP FUNCTION audit_logs_tolak_ubah();
DROP TABLE audit_logs;
