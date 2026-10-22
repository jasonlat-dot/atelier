-- M4 only: credential pool, model catalogue and reusable routing leases.
CREATE TABLE models (
 id text PRIMARY KEY CHECK(id ~ '^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$'),
 kind text NOT NULL CHECK(kind IN ('image','video','chat')),
 display_name text NOT NULL CHECK(char_length(display_name) BETWEEN 1 AND 120),
 upstream_model text NOT NULL CHECK(char_length(upstream_model) BETWEEN 1 AND 200),
 enabled boolean NOT NULL DEFAULT false, capabilities jsonb NOT NULL CHECK(jsonb_typeof(capabilities)='object'),
 sort_order integer NOT NULL DEFAULT 0 CHECK(sort_order BETWEEN -10000 AND 10000),
 group_tags text[] NOT NULL DEFAULT '{}', revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE pricing_rules (
 model_id text NOT NULL REFERENCES models(id) ON DELETE CASCADE,
 quality text NOT NULL CHECK(quality IN ('low','medium','high','standard','message')),
 base_credits integer NOT NULL CHECK(base_credits BETWEEN 0 AND 1000000),
 edit_surcharge integer NOT NULL DEFAULT 0 CHECK(edit_surcharge BETWEEN 0 AND 1000000),
 PRIMARY KEY(model_id,quality)
);
CREATE TABLE pricing_multipliers (
 resolution text PRIMARY KEY CHECK(resolution IN ('1K','2K','4K','720p','1080p','text')),
 multiplier integer NOT NULL CHECK(multiplier BETWEEN 1 AND 100)
);
INSERT INTO pricing_multipliers VALUES('1K',1),('2K',2),('4K',4),('720p',1),('1080p',2),('text',1);
INSERT INTO system_settings(key,value) VALUES('pricing_revision','1'::jsonb);
CREATE TABLE upstream_accounts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text NOT NULL CHECK(char_length(name) BETWEEN 1 AND 120),
 kind text NOT NULL DEFAULT 'openai_compatible' CHECK(kind='openai_compatible'),
 base_url text NOT NULL CHECK(octet_length(base_url) BETWEEN 8 AND 2048),
 secret_enc bytea NOT NULL CHECK(octet_length(secret_enc) BETWEEN 49 AND 8240),
 secret_last4 text NOT NULL CHECK(char_length(secret_last4)=4),key_version integer NOT NULL DEFAULT 1 CHECK(key_version=1),
 group_tag text NOT NULL DEFAULT 'default' CHECK(group_tag ~ '^[a-zA-Z0-9_.-]{1,64}$'),
 priority integer NOT NULL DEFAULT 10 CHECK(priority BETWEEN 0 AND 1000),
 weight integer NOT NULL DEFAULT 1 CHECK(weight BETWEEN 1 AND 1000),
 concurrency_limit integer NOT NULL DEFAULT 2 CHECK(concurrency_limit BETWEEN 1 AND 64),
 quota_total bigint NOT NULL CHECK(quota_total BETWEEN 1 AND 1000000000000),
 quota_remaining bigint NOT NULL CHECK(quota_remaining BETWEEN 0 AND quota_total),quota_reset_at timestamptz,
 status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','COOLDOWN','QUOTA_EXHAUSTED','INVALID','DISABLED')),
 cooldown_until timestamptz,consecutive_failures integer NOT NULL DEFAULT 0 CHECK(consecutive_failures BETWEEN 0 AND 1000000),
 last_error text CHECK(last_error IN ('ACCOUNT_INVALID','RATE_LIMITED','UPSTREAM_ERROR','CONTENT_POLICY','BAD_REQUEST')),
 last_used_at timestamptz, revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),deleted_at timestamptz
);
CREATE UNIQUE INDEX upstream_account_name ON upstream_accounts(name) WHERE deleted_at IS NULL;
CREATE INDEX upstream_candidates ON upstream_accounts(priority,group_tag) WHERE deleted_at IS NULL AND status='ACTIVE';
CREATE TABLE account_models (
 account_id uuid NOT NULL REFERENCES upstream_accounts(id) ON DELETE CASCADE,
 model_id text NOT NULL REFERENCES models(id) ON DELETE CASCADE, PRIMARY KEY(account_id,model_id)
);
CREATE TABLE upstream_leases (
 id uuid PRIMARY KEY,account_id uuid NOT NULL REFERENCES upstream_accounts(id),token uuid NOT NULL,
 account_revision bigint NOT NULL,units integer NOT NULL CHECK(units BETWEEN 0 AND 240),
 expires_at timestamptz NOT NULL,completed boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX upstream_live_leases ON upstream_leases(account_id,expires_at) WHERE completed=false;
CREATE TABLE upstream_attempts (
 id bigserial PRIMARY KEY,account_id uuid NOT NULL REFERENCES upstream_accounts(id),
 operation text NOT NULL CHECK(operation IN ('probe','image','video')),
 code text NOT NULL CHECK(code IN ('SUCCESS','ACCOUNT_INVALID','RATE_LIMITED','UPSTREAM_ERROR','CONTENT_POLICY','BAD_REQUEST','CANCELLED')),
 elapsed_ms bigint NOT NULL CHECK(elapsed_ms BETWEEN 0 AND 3600000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX upstream_stats ON upstream_attempts(account_id,created_at DESC);
