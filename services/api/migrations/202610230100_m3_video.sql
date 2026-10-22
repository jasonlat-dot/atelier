-- Durable video leases and all object attempts, including interrupted uploads.
ALTER TABLE assets ADD COLUMN raw_bytes bigint CHECK (raw_bytes BETWEEN 1 AND 209715200);
ALTER TABLE assets ADD COLUMN lease_token uuid;
ALTER TABLE assets ADD COLUMN reserved_bytes bigint NOT NULL DEFAULT 0 CHECK (reserved_bytes BETWEEN 0 AND 419430400);
CREATE TABLE asset_blobs (
    object_key text PRIMARY KEY CHECK (object_key !~ '(^/|\.\.|\\)'),
    asset_id uuid NOT NULL REFERENCES assets(id),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    purged_at timestamptz
);
CREATE INDEX asset_blobs_cleanup ON asset_blobs(asset_id) WHERE purged_at IS NULL;
INSERT INTO asset_blobs(object_key,asset_id) SELECT object_key,id FROM assets ON CONFLICT DO NOTHING;
INSERT INTO asset_blobs(object_key,asset_id) SELECT thumb_key,id FROM assets ON CONFLICT DO NOTHING;
