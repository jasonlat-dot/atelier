-- M6: owner-scoped versioned project graphs and retained snapshots.
CREATE TABLE projects (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 owner_id uuid NOT NULL REFERENCES users(id),
 name text NOT NULL CHECK(char_length(name) BETWEEN 1 AND 100),
 revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
 graph jsonb NOT NULL CHECK(jsonb_typeof(graph)='object' AND octet_length(graph::text)<=2200000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 deleted_at timestamptz
);
CREATE INDEX projects_owner ON projects(owner_id,updated_at DESC,id DESC) WHERE deleted_at IS NULL;
CREATE TABLE project_snapshots (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 project_id uuid NOT NULL REFERENCES projects(id),
 revision bigint NOT NULL CHECK(revision>=0),
 graph jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(project_id,revision)
);
CREATE TABLE project_assets (
 project_id uuid NOT NULL REFERENCES projects(id),
 asset_id uuid NOT NULL REFERENCES assets(id),
 PRIMARY KEY(project_id,asset_id)
);
CREATE INDEX project_assets_asset ON project_assets(asset_id);
CREATE TABLE project_requests (
 owner_id uuid NOT NULL REFERENCES users(id),
 key uuid NOT NULL,
 request_hash bytea NOT NULL CHECK(octet_length(request_hash)=32),
 project_id uuid NOT NULL REFERENCES projects(id),
 PRIMARY KEY(owner_id,key)
);
ALTER TABLE generation_jobs ADD COLUMN project_id uuid REFERENCES projects(id),
 ADD COLUMN node_id text CHECK(char_length(node_id) BETWEEN 1 AND 64),
 ADD CONSTRAINT generation_project_node CHECK((project_id IS NULL)=(node_id IS NULL));
CREATE INDEX generation_jobs_project ON generation_jobs(project_id,created_at DESC,id DESC) WHERE project_id IS NOT NULL;
CREATE FUNCTION generation_project_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.project_id,NEW.node_id) IS DISTINCT FROM (OLD.project_id,OLD.node_id)
 THEN RAISE EXCEPTION 'generation project input is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER generation_project_guard BEFORE UPDATE ON generation_jobs FOR EACH ROW EXECUTE FUNCTION generation_project_guard();
