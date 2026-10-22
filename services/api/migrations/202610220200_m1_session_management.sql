-- Public, opaque device identifier; never expose the token hash in a device list.
ALTER TABLE sessions ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE sessions ADD CONSTRAINT sessions_id_unique UNIQUE (id);
