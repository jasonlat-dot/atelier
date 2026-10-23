-- Persistent dispatch identity prevents resumed video downloads charging capacity twice.
ALTER TABLE generation_jobs ADD COLUMN usage_key uuid,
 ADD COLUMN retry_reserved boolean NOT NULL DEFAULT false;
CREATE TABLE upstream_usage (
 request_id uuid PRIMARY KEY,
 account_id uuid NOT NULL REFERENCES upstream_accounts(id),
 units int NOT NULL CHECK(units BETWEEN 1 AND 240),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
