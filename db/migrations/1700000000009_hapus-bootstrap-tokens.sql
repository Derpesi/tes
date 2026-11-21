-- Up Migration
-- Bootstrap memakai undangan staff biasa (token 256-bit ber-hash, TTL 24 jam) dengan tautan dicetak ke terminal operator,
-- sehingga tabel bootstrap_tokens tidak diperlukan.
DROP TABLE bootstrap_tokens;

-- Down Migration
CREATE TABLE bootstrap_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash bytea NOT NULL UNIQUE,
  email      text NOT NULL CHECK (email = lower(email)),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
