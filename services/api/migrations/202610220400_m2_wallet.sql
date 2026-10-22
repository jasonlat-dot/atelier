-- M2: authoritative wallet, immutable ledger and daily rewards.
CREATE TABLE wallets (
    user_id uuid PRIMARY KEY REFERENCES users(id),
    balance bigint NOT NULL DEFAULT 0,
    held bigint NOT NULL DEFAULT 0,
    CHECK (balance >= 0 AND held >= 0 AND held <= balance)
);
CREATE TABLE credit_ledger (
    id bigserial PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id),
    type text NOT NULL CHECK (type IN ('SIGNUP_BONUS','CHECKIN','PURCHASE','REDEEM','ADMIN_ADJUST','HOLD','RELEASE','SETTLE','REFUND')),
    balance_delta bigint NOT NULL,
    held_delta bigint NOT NULL,
    idempotency_key text NOT NULL UNIQUE,
    ref_type text, ref_id text, reason text,
    actor_id uuid REFERENCES users(id),
    expires_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (
      (type IN ('SIGNUP_BONUS','CHECKIN','PURCHASE','REDEEM','REFUND') AND balance_delta >= 0 AND held_delta = 0) OR
      (type = 'ADMIN_ADJUST' AND balance_delta <> 0 AND held_delta = 0 AND actor_id IS NOT NULL AND reason IS NOT NULL AND length(trim(reason)) > 0) OR
      (type = 'HOLD' AND balance_delta = 0 AND held_delta > 0) OR
      (type = 'RELEASE' AND balance_delta = 0 AND held_delta < 0) OR
      (type = 'SETTLE' AND balance_delta < 0 AND held_delta = balance_delta)
    )
);
CREATE INDEX ledger_user_cursor ON credit_ledger (user_id, id DESC);
CREATE INDEX ledger_reference ON credit_ledger (user_id, ref_type, ref_id);
CREATE FUNCTION reject_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'credit ledger is append only';
END;
$$;
CREATE TRIGGER credit_ledger_immutable BEFORE UPDATE OR DELETE ON credit_ledger
    FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
CREATE TRIGGER credit_ledger_no_truncate BEFORE TRUNCATE ON credit_ledger
    FOR EACH STATEMENT EXECUTE FUNCTION reject_ledger_mutation();
REVOKE UPDATE, DELETE, TRUNCATE ON credit_ledger FROM PUBLIC;
CREATE TABLE checkins (
    user_id uuid NOT NULL REFERENCES users(id),
    local_date date NOT NULL,
    streak integer NOT NULL CHECK (streak > 0),
    credits integer NOT NULL CHECK (credits >= 0),
    PRIMARY KEY (user_id, local_date)
);
CREATE TABLE redeem_codes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code_hash bytea NOT NULL UNIQUE CHECK (octet_length(code_hash) = 32),
    credits bigint NOT NULL CHECK (credits > 0),
    max_uses integer NOT NULL DEFAULT 1 CHECK (max_uses > 0),
    used_count integer NOT NULL DEFAULT 0 CHECK (used_count BETWEEN 0 AND max_uses),
    expires_at timestamptz,
    created_by uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now()
);
-- Store the original receipt to replay an HTTP request after settings/balance change.
CREATE TABLE wallet_requests (
    scope text NOT NULL,
    request_id uuid NOT NULL,
    fingerprint jsonb NOT NULL,
    response jsonb NOT NULL,
    PRIMARY KEY (scope, request_id)
);
INSERT INTO system_settings(key,value) VALUES
    ('signup_bonus','20'), ('checkin_base','10'),
    ('checkin_streak_cap','10'), ('checkin_tz','"Asia/Shanghai"');
-- M1 accounts receive an empty wallet; no retroactive signup award.
INSERT INTO wallets(user_id) SELECT id FROM users;
