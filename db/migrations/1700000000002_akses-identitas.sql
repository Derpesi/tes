-- Up Migration
-- Skema identitas dan autentikasi (Fase 3A). Email disimpan huruf kecil (CHECK) agar unik tanpa ekstensi.
-- Tabel otorisasi/identitas BUKAN data tenant: sengaja tidak memakai kolom bernama company_id.

CREATE TABLE companies (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL CHECK (length(btrim(name)) > 0),
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE persons (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL CHECK (length(btrim(display_name)) > 0),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id     uuid REFERENCES persons (id),
  realm         text NOT NULL CHECK (realm IN ('member', 'staff')),
  email         text NOT NULL CHECK (email = lower(email) AND email = btrim(email) AND position('@' IN email) > 1),
  status        text NOT NULL CHECK (status IN ('DIUNDANG', 'AKTIF', 'NONAKTIF')),
  all_companies boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_realm_email_unik UNIQUE (realm, email),
  CONSTRAINT users_id_realm_unik UNIQUE (id, realm),
  CONSTRAINT users_hanya_staff_diundang CHECK (realm = 'staff' OR status <> 'DIUNDANG'),
  CONSTRAINT users_hanya_staff_semua_perusahaan CHECK (realm = 'staff' OR all_companies = false)
);

-- Identitas Google hanya untuk realm member (dijaga FK komposit). Satu sub = satu akun.
CREATE TABLE google_identities (
  user_id        uuid PRIMARY KEY,
  realm          text NOT NULL DEFAULT 'member' CHECK (realm = 'member'),
  google_sub     text NOT NULL UNIQUE,
  email_at_login text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_login_at  timestamptz,
  FOREIGN KEY (user_id, realm) REFERENCES users (id, realm)
);

-- Kredensial hanya untuk realm staff.
CREATE TABLE staff_credentials (
  user_id             uuid PRIMARY KEY,
  realm               text NOT NULL DEFAULT 'staff' CHECK (realm = 'staff'),
  password_hash       text NOT NULL,
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  failed_attempts     integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, realm) REFERENCES users (id, realm)
);

CREATE TABLE staff_mfa_factors (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL,
  realm          text NOT NULL DEFAULT 'staff' CHECK (realm = 'staff'),
  type           text NOT NULL DEFAULT 'totp' CHECK (type = 'totp'),
  secret_enc     bytea NOT NULL,
  status         text NOT NULL CHECK (status IN ('PENDING', 'AKTIF', 'DICABUT')),
  last_used_step bigint,
  created_at     timestamptz NOT NULL DEFAULT now(),
  confirmed_at   timestamptz,
  revoked_at     timestamptz,
  FOREIGN KEY (user_id, realm) REFERENCES users (id, realm)
);
CREATE UNIQUE INDEX staff_mfa_satu_aktif ON staff_mfa_factors (user_id) WHERE status = 'AKTIF';

CREATE TABLE mfa_recovery_codes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL,
  realm      text NOT NULL DEFAULT 'staff' CHECK (realm = 'staff'),
  code_hash  bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at    timestamptz,
  FOREIGN KEY (user_id, realm) REFERENCES users (id, realm),
  UNIQUE (user_id, code_hash)
);

-- Sesi server-side. Hanya hash token yang disimpan; token asli hanya ada di cookie klien.
CREATE TABLE sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL,
  realm          text NOT NULL CHECK (realm IN ('member', 'staff')),
  token_hash     bytea NOT NULL UNIQUE,
  state          text NOT NULL CHECK (state IN ('PENUH', 'MENUNGGU_MFA', 'MENUNGGU_ENROLL_MFA')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  revoked_reason text,
  user_agent     text CHECK (length(user_agent) <= 200),
  FOREIGN KEY (user_id, realm) REFERENCES users (id, realm),
  CONSTRAINT sessions_member_selalu_penuh CHECK (realm = 'staff' OR state = 'PENUH')
);
CREATE INDEX sessions_user_aktif_idx ON sessions (user_id) WHERE revoked_at IS NULL;

-- Riwayat percobaan masuk. Email dan IP disimpan sebagai HMAC (bukan nilai mentah).
CREATE TABLE login_attempts (
  id          bigserial PRIMARY KEY,
  user_id     uuid REFERENCES users (id),
  realm       text NOT NULL CHECK (realm IN ('member', 'staff')),
  email_hmac  bytea NOT NULL,
  ip_hmac     bytea,
  succeeded   boolean NOT NULL,
  reason      text,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_attempts_email_idx ON login_attempts (email_hmac, occurred_at);
CREATE INDEX login_attempts_ip_idx ON login_attempts (ip_hmac, occurred_at);

CREATE TABLE staff_invitations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL,
  realm      text NOT NULL DEFAULT 'staff' CHECK (realm = 'staff'),
  token_hash bytea NOT NULL UNIQUE,
  invited_by uuid REFERENCES users (id),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, realm) REFERENCES users (id, realm)
);

CREATE TABLE password_reset_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL,
  realm      text NOT NULL DEFAULT 'staff' CHECK (realm = 'staff'),
  token_hash bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, realm) REFERENCES users (id, realm)
);

CREATE TABLE system_state (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO system_state (key, value) VALUES ('bootstrapped', 'false'::jsonb);

CREATE TABLE bootstrap_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash bytea NOT NULL UNIQUE,
  email      text NOT NULL CHECK (email = lower(email)),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Outbox notifikasi. Payload (mis. tautan undangan) dienkripsi dan dikosongkan setelah terkirim.
CREATE TABLE notification_outbox (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel         text NOT NULL CHECK (channel IN ('email')),
  recipient       text NOT NULL,
  template        text NOT NULL,
  payload_enc     bytea,
  status          text NOT NULL DEFAULT 'MENUNGGU' CHECK (status IN ('MENUNGGU', 'TERKIRIM', 'GAGAL')),
  attempts        integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz
);
CREATE INDEX notification_outbox_antrean_idx ON notification_outbox (status, next_attempt_at);

-- Down Migration
DROP TABLE notification_outbox;
DROP TABLE bootstrap_tokens;
DROP TABLE system_state;
DROP TABLE password_reset_tokens;
DROP TABLE staff_invitations;
DROP TABLE login_attempts;
DROP TABLE sessions;
DROP TABLE mfa_recovery_codes;
DROP TABLE staff_mfa_factors;
DROP TABLE staff_credentials;
DROP TABLE google_identities;
DROP TABLE users;
DROP TABLE persons;
DROP TABLE companies;
