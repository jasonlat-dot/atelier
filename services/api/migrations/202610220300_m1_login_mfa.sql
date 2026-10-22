-- M1 login and MFA; no wallet/credit changes.
ALTER TABLE users ADD COLUMN mfa_pending_enc bytea;
ALTER TABLE users ADD COLUMN mfa_pending_expires_at timestamptz;
ALTER TABLE users ADD COLUMN mfa_last_step bigint CHECK (mfa_last_step IS NULL OR mfa_last_step >= 0);
ALTER TABLE users ADD COLUMN mfa_pending_session uuid REFERENCES sessions(id);
ALTER TABLE users ADD CONSTRAINT mfa_pending_pair CHECK ((mfa_pending_enc IS NULL) = (mfa_pending_expires_at IS NULL) AND (mfa_pending_enc IS NULL) = (mfa_pending_session IS NULL));
