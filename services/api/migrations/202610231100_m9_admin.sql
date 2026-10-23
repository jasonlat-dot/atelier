ALTER TABLE users ADD COLUMN revision bigint NOT NULL DEFAULT 1;
CREATE FUNCTION user_admin_revision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.role,NEW.status,NEW.disabled_reason,NEW.display_name) IS DISTINCT FROM ROW(OLD.role,OLD.status,OLD.disabled_reason,OLD.display_name) THEN NEW.revision=OLD.revision+1; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER user_admin_revision BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION user_admin_revision();
ALTER TABLE invite_codes ADD COLUMN label text NOT NULL DEFAULT '邀请码', ADD COLUMN last4 text,
 ADD COLUMN created_by uuid REFERENCES users(id), ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 ADD COLUMN revoked_at timestamptz, ADD COLUMN revision bigint NOT NULL DEFAULT 1;
ALTER TABLE moderation_rules ADD COLUMN revision bigint NOT NULL DEFAULT 1, ADD COLUMN deleted_at timestamptz;
CREATE INDEX moderation_user_date ON moderation_violations(user_id,created_at DESC);
CREATE INDEX audit_cursor ON audit_logs(id DESC);
CREATE INDEX admin_jobs_cursor ON generation_jobs(created_at DESC,id DESC);
CREATE TABLE admin_job_refunds (
 job_id uuid PRIMARY KEY REFERENCES generation_jobs(id), request_id uuid NOT NULL UNIQUE,
 actor_id uuid NOT NULL REFERENCES users(id), credits bigint NOT NULL CHECK(credits>0),
 reason text NOT NULL CHECK(char_length(trim(reason)) BETWEEN 1 AND 500), ledger_id bigint NOT NULL UNIQUE REFERENCES credit_ledger(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE admin_requests (
 request_id uuid PRIMARY KEY, actor_id uuid NOT NULL REFERENCES users(id), fingerprint jsonb NOT NULL, response jsonb NOT NULL
);
CREATE TABLE admin_notifications (
 id bigserial PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id), kind text NOT NULL CHECK(kind IN ('AUTO_DISABLED','PROTECTED_ADMIN')),
 violation_count bigint NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 reviewed_at timestamptz,reviewed_by uuid REFERENCES users(id)
);
CREATE UNIQUE INDEX moderation_pending_review ON admin_notifications(user_id) WHERE reviewed_at IS NULL;
INSERT INTO system_settings(key,value) VALUES ('admin_settings_revision','1'),('moderation_threshold','5'),('admin_adjust_limit','100000'),
 ('upstream_cost_rates','[]') ON CONFLICT DO NOTHING;

-- Flag in-flight work cooperatively. Wallet releases remain in domain services/workers.
CREATE FUNCTION moderation_enforcement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n bigint; threshold integer; account_status text; account_role text; protected boolean:=false;
BEGIN
 SELECT status,role INTO account_status,account_role FROM users WHERE id=NEW.user_id FOR UPDATE;
 IF account_status<>'ACTIVE' THEN RETURN NEW; END IF;
 SELECT (value::text)::integer INTO threshold FROM system_settings WHERE key='moderation_threshold';
 SELECT count(*) INTO n FROM moderation_violations WHERE user_id=NEW.user_id AND created_at>clock_timestamp()-interval '30 days';
 IF n<COALESCE(threshold,5) THEN RETURN NEW; END IF;
 IF account_role='SUPER_ADMIN' THEN
   PERFORM pg_advisory_xact_lock(1096043830);
   SELECT count(*)<=1 INTO protected FROM users WHERE role='SUPER_ADMIN' AND status='ACTIVE';
 END IF;
 IF NOT protected THEN
   UPDATE users SET status='DISABLED',disabled_reason='30 天内内容违规达到阈值，等待管理员复核' WHERE id=NEW.user_id;
   WITH changed AS (
     UPDATE generation_jobs SET cancel_requested=true,updated_at=clock_timestamp()
     WHERE owner_id=NEW.user_id AND finished_at IS NULL AND NOT cancel_requested RETURNING *
   ) INSERT INTO job_events(user_id,job_id,payload)
     SELECT owner_id,id,jsonb_build_object('job_id',id,'status',status,'progress',progress,'cancel_requested',true,'error_code',error_code,'outputs','[]'::jsonb) FROM changed;
   PERFORM pg_notify('atelier_job_events',NEW.user_id::text);
   UPDATE chat_turns SET cancel_requested=true WHERE owner_id=NEW.user_id AND status='RUNNING' AND NOT cancel_requested;
 END IF;
 INSERT INTO admin_notifications(user_id,kind,violation_count) VALUES(NEW.user_id,CASE WHEN protected THEN 'PROTECTED_ADMIN' ELSE 'AUTO_DISABLED' END,n)
 ON CONFLICT(user_id) WHERE reviewed_at IS NULL DO UPDATE SET violation_count=EXCLUDED.violation_count;
 INSERT INTO audit_logs(actor_id,action,target_type,target_id,before,after) VALUES(NEW.user_id,
   CASE WHEN protected THEN 'MODERATION_REVIEW_REQUIRED' ELSE 'MODERATION_AUTO_DISABLED' END,'users',NEW.user_id::text,
   jsonb_build_object('status',account_status),jsonb_build_object('status',CASE WHEN protected THEN 'ACTIVE' ELSE 'DISABLED' END,'violations',n,'automatic',true));
 RETURN NEW;
END $$;
CREATE TRIGGER moderation_enforcement AFTER INSERT ON moderation_violations FOR EACH ROW EXECUTE FUNCTION moderation_enforcement();
CREATE FUNCTION audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit logs are append only'; END $$;
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_logs FOR EACH STATEMENT EXECUTE FUNCTION audit_append_only();
