-- Up Migration
-- Login member via Google OIDC (Fase 3C).

-- Transaksi OIDC sekali pakai. state dan cookie pengikat hanya disimpan sebagai hash; code_verifier dienkripsi.
CREATE TABLE oidc_transactions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state_hash        bytea NOT NULL UNIQUE,
  binding_hash      bytea NOT NULL,
  nonce             text NOT NULL,
  code_verifier_enc bytea NOT NULL,
  return_to         text NOT NULL DEFAULT '/' CHECK (
    return_to LIKE '/%' AND return_to NOT LIKE '//%' AND position('\' IN return_to) = 0 AND length(return_to) <= 200
  ),
  expires_at        timestamptz NOT NULL,
  consumed_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oidc_transactions_expires_idx ON oidc_transactions (expires_at);

-- Antrean tinjauan: email Google sudah dimiliki member lain dengan akun Google berbeda.
-- Identitas disimpan sebagai HMAC (bukan nilai mentah). Tidak ada penautan otomatis berdasarkan email.
CREATE TABLE member_account_conflicts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  existing_user_id uuid NOT NULL REFERENCES users (id),
  sub_hmac         bytea NOT NULL,
  email_hmac       bytea NOT NULL,
  status           text NOT NULL DEFAULT 'MENUNGGU' CHECK (status IN ('MENUNGGU', 'SELESAI')),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX member_account_conflicts_unik_menunggu
  ON member_account_conflicts (existing_user_id, sub_hmac) WHERE status = 'MENUNGGU';

-- Down Migration
DROP TABLE member_account_conflicts;
DROP TABLE oidc_transactions;
