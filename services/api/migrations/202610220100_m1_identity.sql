-- M1 identity foundation; never creates balances or grants signup credits.
CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    google_sub text NOT NULL UNIQUE CHECK (length(google_sub) BETWEEN 1 AND 255),
    email text NOT NULL,
    canonical_email text NOT NULL UNIQUE,
    display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 100),
    avatar_url text,
    role text NOT NULL DEFAULT 'USER' CHECK (role IN ('USER', 'ADMIN', 'SUPER_ADMIN')),
    status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
    disabled_reason text,
    mfa_secret_enc bytea,
    mfa_enabled boolean NOT NULL DEFAULT false,
    signup_ip inet,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_login_at timestamptz,
    CHECK (canonical_email = lower(canonical_email)),
    CHECK (NOT mfa_enabled OR mfa_secret_enc IS NOT NULL)
);
CREATE INDEX users_signup_ip_date ON users (signup_ip, created_at);

CREATE TABLE sessions (
    token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
    user_id uuid NOT NULL REFERENCES users(id),
    csrf_token text NOT NULL CHECK (length(csrf_token) >= 43),
    mfa_verified_at timestamptz,
    ip inet,
    user_agent text,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    CHECK (last_seen_at >= created_at),
    CHECK (expires_at > created_at AND expires_at <= created_at + interval '720 hours')
);
CREATE INDEX sessions_user ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE system_settings (
    key text PRIMARY KEY,
    value jsonb NOT NULL,
    updated_by uuid REFERENCES users(id),
    updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO system_settings (key, value) VALUES
    ('registration_mode', '"CLOSED"'),
    ('registration_whitelist', '[]'),
    ('signup_max_per_ip_24h', '3');

CREATE TABLE invite_codes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code_hash bytea NOT NULL UNIQUE CHECK (octet_length(code_hash) = 32),
    max_uses integer NOT NULL DEFAULT 1 CHECK (max_uses > 0),
    used_count integer NOT NULL DEFAULT 0 CHECK (used_count BETWEEN 0 AND max_uses),
    expires_at timestamptz
);

CREATE TABLE audit_logs (
    id bigserial PRIMARY KEY,
    actor_id uuid NOT NULL REFERENCES users(id),
    action text NOT NULL,
    target_type text,
    target_id text,
    before jsonb,
    after jsonb,
    ip inet,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_actor_date ON audit_logs (actor_id, created_at DESC);

-- Authentication reads user status/role on every request; this additionally revokes
-- every session transactionally when roles change or the account is disabled.
CREATE FUNCTION revoke_identity_sessions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.role IS DISTINCT FROM NEW.role
       OR (NEW.status = 'DISABLED' AND OLD.status IS DISTINCT FROM NEW.status) THEN
        UPDATE sessions SET revoked_at = now() WHERE user_id = NEW.id AND revoked_at IS NULL;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER users_revoke_sessions AFTER UPDATE OF role, status ON users
    FOR EACH ROW EXECUTE FUNCTION revoke_identity_sessions();
