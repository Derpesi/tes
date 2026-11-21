-- Up Migration
-- Skema RBAC, scope perusahaan, dan persetujuan ganda (Fase 3A).
-- Kolom scope memakai nama scope_company_id (bukan company_id) karena ini tabel otorisasi, bukan data tenant.

CREATE TABLE roles (
  code            text PRIMARY KEY CHECK (code ~ '^[A-Z_]+$'),
  name            text NOT NULL,
  high_privilege  boolean NOT NULL DEFAULT false
);

CREATE TABLE permissions (
  code        text PRIMARY KEY CHECK (code ~ '^[a-z_]+\.[a-z_]+$'),
  description text NOT NULL
);

CREATE TABLE role_permissions (
  role_code       text NOT NULL REFERENCES roles (code) ON DELETE CASCADE,
  permission_code text NOT NULL REFERENCES permissions (code) ON DELETE CASCADE,
  PRIMARY KEY (role_code, permission_code)
);

CREATE TABLE user_roles (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL,
  realm        text NOT NULL DEFAULT 'staff' CHECK (realm = 'staff'),
  role_code    text NOT NULL REFERENCES roles (code),
  grant_source text NOT NULL CHECK (grant_source IN ('BOOTSTRAP', 'MANUAL', 'PERSETUJUAN')),
  granted_by   uuid REFERENCES users (id),
  granted_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz,
  revoked_at   timestamptz,
  revoked_by   uuid REFERENCES users (id),
  FOREIGN KEY (user_id, realm) REFERENCES users (id, realm),
  CONSTRAINT user_roles_bootstrap_tanpa_pemberi CHECK (grant_source <> 'BOOTSTRAP' OR granted_by IS NULL)
);
CREATE UNIQUE INDEX user_roles_satu_aktif ON user_roles (user_id, role_code) WHERE revoked_at IS NULL;

CREATE TABLE user_company_scopes (
  user_id          uuid NOT NULL,
  realm            text NOT NULL DEFAULT 'staff' CHECK (realm = 'staff'),
  scope_company_id uuid NOT NULL REFERENCES companies (id),
  granted_by       uuid REFERENCES users (id),
  granted_at       timestamptz NOT NULL DEFAULT now(),
  revoked_at       timestamptz,
  PRIMARY KEY (user_id, scope_company_id),
  FOREIGN KEY (user_id, realm) REFERENCES users (id, realm)
);

CREATE TABLE approval_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type            text NOT NULL CHECK (type IN ('BERI_PERAN_TINGGI', 'RESET_MFA', 'BERI_AKSES_SEMUA_PERUSAHAAN')),
  requested_by    uuid NOT NULL REFERENCES users (id),
  subject_user_id uuid NOT NULL REFERENCES users (id),
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          text NOT NULL DEFAULT 'MENUNGGU' CHECK (status IN ('MENUNGGU', 'DISETUJUI', 'DITOLAK', 'KEDALUWARSA', 'DIBATALKAN')),
  decided_by      uuid REFERENCES users (id),
  decided_at      timestamptz,
  decision_note   text,
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- Pemisahan tugas dijaga di database: penyetuju tidak boleh sama dengan pemohon.
  CONSTRAINT approval_pemohon_bukan_penyetuju CHECK (decided_by IS NULL OR decided_by <> requested_by),
  CONSTRAINT approval_keputusan_lengkap CHECK (status NOT IN ('DISETUJUI', 'DITOLAK') OR (decided_by IS NOT NULL AND decided_at IS NOT NULL))
);
CREATE INDEX approval_requests_status_idx ON approval_requests (status, expires_at);

-- Down Migration
DROP TABLE approval_requests;
DROP TABLE user_company_scopes;
DROP TABLE user_roles;
DROP TABLE role_permissions;
DROP TABLE permissions;
DROP TABLE roles;
