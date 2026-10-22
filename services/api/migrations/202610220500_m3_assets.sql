-- M3 storage metadata. Object paths never come from a browser filename.
CREATE TABLE assets (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL REFERENCES users(id),
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
    kind text NOT NULL CHECK (kind IN ('image','video')),
    source text NOT NULL CHECK (source IN ('upload','generated')),
    object_key text NOT NULL UNIQUE CHECK (object_key !~ '(^/|\.\.|\\)'),
    thumb_key text NOT NULL UNIQUE CHECK (thumb_key !~ '(^/|\.\.|\\)'),
    mime text NOT NULL CHECK (mime IN ('image/png','video/mp4')),
    bytes bigint NOT NULL CHECK (bytes BETWEEN 0 AND 209715200),
    thumb_bytes bigint NOT NULL DEFAULT 0 CHECK (thumb_bytes BETWEEN 0 AND 20971520),
    width int CHECK (width BETWEEN 1 AND 16384),
    height int CHECK (height BETWEEN 1 AND 16384),
    duration_ms bigint CHECK (duration_ms BETWEEN 1 AND 60000),
    sha256 bytea CHECK (octet_length(sha256)=32),
    state text NOT NULL DEFAULT 'PROCESSING' CHECK (state IN ('PROCESSING','READY','FAILED')),
    error_code text,
    upload_ready boolean NOT NULL DEFAULT false,
    lease_until timestamptz,
    attempts int NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
    expires_at timestamptz NOT NULL DEFAULT (now()+interval '30 days'),
    deleted_at timestamptz,
    purged_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (state <> 'READY' OR (bytes>0 AND thumb_bytes>0 AND width IS NOT NULL AND height IS NOT NULL AND sha256 IS NOT NULL)),
    CHECK (kind <> 'image' OR duration_ms IS NULL)
);
CREATE INDEX assets_owner_created ON assets(owner_id,created_at DESC,id DESC) WHERE deleted_at IS NULL;
CREATE INDEX assets_cleanup ON assets(expires_at) WHERE purged_at IS NULL;
CREATE INDEX assets_processing ON assets(created_at) WHERE state='PROCESSING' AND deleted_at IS NULL;
INSERT INTO system_settings(key,value) VALUES
('asset_retention_days_free','30'),('asset_retention_days_subscriber','180') ON CONFLICT DO NOTHING;
