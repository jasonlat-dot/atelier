-- Development foundation. Run through SQLx migrations; ledger must only be mutated server-side.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    google_sub text UNIQUE,
    email text NOT NULL UNIQUE,
    display_name text NOT NULL,
    role text NOT NULL DEFAULT 'USER' CHECK(role IN ('USER','ADMIN','SUPER_ADMIN')),
    status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','DISABLED')),
    credits bigint NOT NULL DEFAULT 0 CHECK(credits >= 0),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS projects (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL REFERENCES users(id),
    name text NOT NULL CHECK(char_length(name) BETWEEN 1 AND 200),
    revision bigint NOT NULL DEFAULT 0,
    graph jsonb NOT NULL DEFAULT '{"nodes":[],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_id,updated_at DESC);
CREATE TABLE IF NOT EXISTS assets (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL REFERENCES users(id),
    kind text NOT NULL CHECK(kind IN ('image','video')),
    display_name text NOT NULL,
    object_key text NOT NULL,
    poster_key text,
    state text NOT NULL DEFAULT 'READY',
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS generation_jobs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL REFERENCES users(id),
    project_id uuid NOT NULL REFERENCES projects(id),
    node_id text NOT NULL,
    kind text NOT NULL CHECK(kind IN ('image','video')),
    model text NOT NULL,
    prompt text NOT NULL,
    quality text NOT NULL,
    ratio text NOT NULL,
    duration integer NOT NULL DEFAULT 6,
    count integer NOT NULL DEFAULT 1,
    cost bigint NOT NULL CHECK(cost > 0),
    status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','routing','generating','completed','cancelled','failed')),
    progress integer NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100),
    reference_asset_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
    result_asset_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
    idempotency_key text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(owner_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_jobs_owner ON generation_jobs(owner_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_active ON generation_jobs(status,updated_at) WHERE status IN ('queued','routing','generating');
CREATE TABLE IF NOT EXISTS wallet_ledger (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id),
    job_id uuid REFERENCES generation_jobs(id),
    amount bigint NOT NULL,
    reason text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(job_id,reason)
);
-- NOTE: immutable financial history must later use a separate wallet hold/settlement model and append-only policies.
