-- User history visibility is separate from immutable jobs and financial records.
CREATE TABLE generation_history_deleted (
 job_id uuid PRIMARY KEY REFERENCES generation_jobs(id),
 deleted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
