-- M8: manual paid orders and funded subscription periods. No automatic charges.
CREATE TABLE plans (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 80),
 kind text NOT NULL CHECK(kind IN ('PACK','MONTHLY')), description text NOT NULL DEFAULT '',
 price_cents integer NOT NULL CHECK(price_cents BETWEEN 1 AND 100000000), currency text NOT NULL CHECK(currency IN ('CNY','USD')),
 credits bigint NOT NULL CHECK(credits BETWEEN 1 AND 100000000), period_days integer,
 rollover boolean NOT NULL DEFAULT true, concurrency_limit integer NOT NULL CHECK(concurrency_limit BETWEEN 1 AND 64),
 max_resolution text NOT NULL CHECK(max_resolution IN ('1K','2K','4K')), retention_days integer NOT NULL CHECK(retention_days BETWEEN 1 AND 3650),
 active boolean NOT NULL DEFAULT true, revision bigint NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((kind='PACK' AND period_days IS NULL) OR (kind='MONTHLY' AND period_days BETWEEN 1 AND 366))
);
CREATE TABLE orders (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id), plan_id uuid NOT NULL REFERENCES plans(id),
 plan_snapshot jsonb NOT NULL, amount_cents integer NOT NULL CHECK(amount_cents>0), currency text NOT NULL,
 provider text NOT NULL DEFAULT 'MANUAL' CHECK(provider='MANUAL'), provider_trade_no text,
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PAID','FULFILLED','CANCELLED','REFUNDED')),
 created_at timestamptz NOT NULL DEFAULT now(), paid_at timestamptz, confirmed_by uuid REFERENCES users(id),
 refund_cents integer NOT NULL DEFAULT 0 CHECK(refund_cents BETWEEN 0 AND amount_cents),
 recovered_credits bigint NOT NULL DEFAULT 0 CHECK(recovered_credits>=0),
 UNIQUE(provider,provider_trade_no)
);
CREATE INDEX orders_owner ON orders(user_id,created_at DESC,id DESC);
CREATE TABLE subscriptions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL UNIQUE REFERENCES orders(id), user_id uuid NOT NULL REFERENCES users(id),
 plan_id uuid NOT NULL REFERENCES plans(id), starts_at timestamptz NOT NULL, current_period_end timestamptz NOT NULL,
 status text NOT NULL CHECK(status IN ('SCHEDULED','ACTIVE','EXPIRED','REFUNDED')),
 grant_ledger_id bigint UNIQUE REFERENCES credit_ledger(id), created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(current_period_end>starts_at)
);
CREATE INDEX subscription_due ON subscriptions(user_id,starts_at,current_period_end) WHERE status IN ('SCHEDULED','ACTIVE');
-- Allocation tracks refundability; all sources still share the one wallet balance.
CREATE TABLE wallet_credit_lots (
 id bigserial PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), ledger_id bigint UNIQUE REFERENCES credit_ledger(id),
 credits bigint NOT NULL CHECK(credits>0), remaining bigint NOT NULL CHECK(remaining BETWEEN 0 AND credits)
);
CREATE INDEX wallet_lots_fifo ON wallet_credit_lots(user_id,id) WHERE remaining>0;
INSERT INTO wallet_credit_lots(user_id,credits,remaining) SELECT user_id,balance,balance FROM wallets WHERE balance>0;
INSERT INTO system_settings(key,value) VALUES ('max_active_jobs_sub','3') ON CONFLICT DO NOTHING;
