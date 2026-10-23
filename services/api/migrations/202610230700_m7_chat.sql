CREATE TABLE conversations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL REFERENCES users(id),create_hash bytea NOT NULL CHECK(octet_length(create_hash)=32),
 title text NOT NULL CHECK(char_length(title) BETWEEN 1 AND 100),
 summary text NOT NULL DEFAULT '' CHECK(octet_length(summary)<=8192),
 retained_facts jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(retained_facts)='array'),
 summary_through bigint NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),deleted_at timestamptz
);
CREATE INDEX conversations_owner ON conversations(owner_id,updated_at DESC,id DESC) WHERE deleted_at IS NULL;
CREATE TABLE chat_turns (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL REFERENCES users(id),conversation_id uuid NOT NULL REFERENCES conversations(id),
 request_key uuid NOT NULL,request_hash bytea NOT NULL CHECK(octet_length(request_hash)=32),
 model_id text NOT NULL REFERENCES models(id),cost bigint NOT NULL CHECK(cost BETWEEN 0 AND 10000),
 status text NOT NULL DEFAULT 'RUNNING' CHECK(status IN ('RUNNING','SUCCEEDED','FAILED','CANCELLED')),
 token uuid NOT NULL DEFAULT gen_random_uuid(), lease_until timestamptz NOT NULL DEFAULT clock_timestamp()+interval '1 minute',
 cancel_requested boolean NOT NULL DEFAULT false,
 error_code text, intent text CHECK(intent IN ('CHAT','IMAGE_GENERATE','IMAGE_EDIT','PROMPT_REFINE','CANVAS_ASSIST','UNSAFE')),
 action jsonb, estimated_tokens integer NOT NULL DEFAULT 0 CHECK(estimated_tokens>=0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),finished_at timestamptz,
 UNIQUE(owner_id,request_key),CHECK((status='RUNNING')=(finished_at IS NULL))
);
CREATE UNIQUE INDEX chat_one_active ON chat_turns(owner_id) WHERE status='RUNNING';
CREATE INDEX chat_recovery ON chat_turns(lease_until) WHERE status='RUNNING';
CREATE TABLE chat_messages (
 id bigserial PRIMARY KEY,conversation_id uuid NOT NULL REFERENCES conversations(id),turn_id uuid NOT NULL REFERENCES chat_turns(id),
 role text NOT NULL CHECK(role IN ('user','assistant')),content text NOT NULL CHECK(octet_length(content)<=65536),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(turn_id,role)
);
CREATE INDEX chat_messages_conversation ON chat_messages(conversation_id,id);
ALTER TABLE upstream_attempts DROP CONSTRAINT upstream_attempts_operation_check;
ALTER TABLE upstream_attempts ADD CONSTRAINT upstream_attempts_operation_check CHECK(operation IN ('probe','image','video','chat'));
INSERT INTO system_settings(key,value) VALUES ('chat_credits_per_message','1'),('chat_context_window','8192'),('chat_output_tokens','2048') ON CONFLICT DO NOTHING;
