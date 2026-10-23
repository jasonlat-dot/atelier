-- M5: authoritative jobs, immutable events, fenced worker attempts and atomic publication.
CREATE TABLE generation_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 owner_id uuid NOT NULL REFERENCES users(id),
 model_id text NOT NULL REFERENCES models(id),
 kind text NOT NULL CHECK(kind IN ('image','video')),
 model_revision bigint NOT NULL CHECK(model_revision>0),
 prompt text NOT NULL CHECK(char_length(prompt) BETWEEN 1 AND 4000),
 params jsonb NOT NULL CHECK(jsonb_typeof(params)='object'),
 size text NOT NULL CHECK(size ~ '^[0-9]{2,4}x[0-9]{2,4}$'),
 cost_per_output bigint NOT NULL CHECK(cost_per_output BETWEEN 1 AND 1000000000000),
 n int NOT NULL CHECK(n BETWEEN 1 AND 4),
 cost bigint NOT NULL CHECK(cost=cost_per_output*n),
 settled bigint NOT NULL DEFAULT 0 CHECK(settled>=0),
 released bigint NOT NULL DEFAULT 0 CHECK(released>=0),
 status text NOT NULL DEFAULT 'QUEUED' CHECK(status IN ('QUEUED','ROUTING','RUNNING','STORING','SUCCEEDED','PARTIAL','FAILED','CANCELLED')),
 error_code text CHECK(error_code IN ('NO_CAPACITY','TIMEOUT','CONTENT_POLICY','BAD_REQUEST','ACCOUNT_INVALID','RATE_LIMITED','UPSTREAM_ERROR','STORAGE_FAILED','MODEL_UNAVAILABLE','ASSET_UNAVAILABLE','WORKER_LOST','ACCOUNT_DISABLED','LOCAL_ERROR')),
 progress int NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100),
 attempts int NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
 tried_accounts uuid[] NOT NULL DEFAULT '{}',
 account_id uuid REFERENCES upstream_accounts(id),
 account_revision bigint,
 upstream_job_id text CHECK(upstream_job_id ~ '^[A-Za-z0-9_-]{1,128}$'),
 dispatch_started boolean NOT NULL DEFAULT false,
 locked_by text CHECK(char_length(locked_by) BETWEEN 1 AND 100),
 lease_token uuid,
 lease_until timestamptz,
 next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 run_deadline timestamptz,
 cancel_requested boolean NOT NULL DEFAULT false,
 idempotency_key uuid NOT NULL,
 request_hash bytea NOT NULL CHECK(octet_length(request_hash)=32),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 finished_at timestamptz,
 UNIQUE(owner_id,idempotency_key),
 CHECK(settled+released<=cost),
 CHECK((lease_token IS NULL)=(lease_until IS NULL)),
 CHECK((status IN ('SUCCEEDED','PARTIAL','FAILED','CANCELLED'))=(finished_at IS NOT NULL)),
 CHECK(status NOT IN ('SUCCEEDED','PARTIAL','FAILED','CANCELLED') OR settled+released=cost),
 CHECK(status NOT IN ('FAILED','CANCELLED') OR settled=0),
 CHECK(status<>'SUCCEEDED' OR settled=cost),
 CHECK(status<>'PARTIAL' OR (settled>0 AND released>0)),
 CHECK(kind<>'video' OR n=1)
);
CREATE INDEX generation_jobs_pick ON generation_jobs(next_attempt_at,created_at,id) WHERE status IN ('QUEUED','ROUTING');
CREATE INDEX generation_jobs_recovery ON generation_jobs(lease_until) WHERE finished_at IS NULL;
CREATE INDEX generation_jobs_owner ON generation_jobs(owner_id,created_at DESC,id DESC);
CREATE FUNCTION generation_state_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.finished_at IS NOT NULL THEN RAISE EXCEPTION 'terminal generation job is immutable'; END IF;
 IF (NEW.owner_id,NEW.model_id,NEW.model_revision,NEW.kind,NEW.prompt,NEW.params,NEW.size,NEW.cost_per_output,NEW.n,NEW.cost,NEW.request_hash,NEW.idempotency_key)
    IS DISTINCT FROM (OLD.owner_id,OLD.model_id,OLD.model_revision,OLD.kind,OLD.prompt,OLD.params,OLD.size,OLD.cost_per_output,OLD.n,OLD.cost,OLD.request_hash,OLD.idempotency_key)
 THEN RAISE EXCEPTION 'generation input is immutable'; END IF;
 IF NEW.attempts<OLD.attempts THEN RAISE EXCEPTION 'attempts cannot decrease'; END IF;
 IF NEW.status<>OLD.status AND NOT (
   (OLD.status='QUEUED' AND NEW.status IN ('ROUTING','CANCELLED','FAILED')) OR
   (OLD.status='ROUTING' AND NEW.status IN ('RUNNING','STORING','QUEUED','FAILED','CANCELLED')) OR
   (OLD.status='RUNNING' AND NEW.status IN ('STORING','ROUTING','QUEUED','FAILED','CANCELLED')) OR
   (OLD.status='STORING' AND NEW.status IN ('SUCCEEDED','PARTIAL','FAILED','CANCELLED','QUEUED'))
 ) THEN RAISE EXCEPTION 'invalid generation state transition'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER generation_state_guard BEFORE UPDATE ON generation_jobs FOR EACH ROW EXECUTE FUNCTION generation_state_guard();

ALTER TABLE assets ADD COLUMN generation_job_id uuid REFERENCES generation_jobs(id),
 ADD COLUMN generation_token uuid,
 ADD COLUMN generation_published boolean NOT NULL DEFAULT true;
CREATE INDEX assets_generation_staged ON assets(generation_job_id,generation_token) WHERE NOT generation_published;
CREATE TABLE generation_outputs (
 job_id uuid NOT NULL REFERENCES generation_jobs(id),
 idx int NOT NULL CHECK(idx BETWEEN 0 AND 3),
 asset_id uuid NOT NULL UNIQUE REFERENCES assets(id),
 attempt_token uuid NOT NULL,
 status text NOT NULL CHECK(status IN ('STAGED','READY')),
 PRIMARY KEY(job_id,idx)
);
CREATE TABLE job_events (
 seq bigserial PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES users(id),
 job_id uuid NOT NULL REFERENCES generation_jobs(id),
 type text NOT NULL DEFAULT 'job.updated' CHECK(type='job.updated'),
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX job_events_owner_seq ON job_events(user_id,seq);
CREATE FUNCTION generation_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'generation events are append only'; END $$;
CREATE TRIGGER generation_event_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON job_events FOR EACH STATEMENT EXECUTE FUNCTION generation_event_immutable();
CREATE TABLE moderation_rules (
 id bigserial PRIMARY KEY,
 pattern text NOT NULL CHECK(char_length(pattern) BETWEEN 1 AND 512),
 is_regex boolean NOT NULL DEFAULT false,
 enabled boolean NOT NULL DEFAULT true
);
CREATE TABLE moderation_violations (
 id bigserial PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES users(id),
 job_id uuid REFERENCES generation_jobs(id),
 source text NOT NULL CHECK(source IN ('local','upstream')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO system_settings(key,value) VALUES
 ('free_max_resolution','"2K"'),('max_active_jobs_free','1'),
 ('max_active_jobs_sub','3'),('maintenance_mode','false') ON CONFLICT DO NOTHING;
