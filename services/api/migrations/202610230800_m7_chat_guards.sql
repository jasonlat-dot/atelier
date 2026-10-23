-- Keep charged inputs and completed replies immutable at the database boundary.
CREATE FUNCTION protect_chat_turn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'RUNNING' OR
     ROW(NEW.id, NEW.owner_id, NEW.conversation_id, NEW.request_key, NEW.request_hash,
         NEW.model_id, NEW.cost, NEW.token, NEW.intent, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.owner_id, OLD.conversation_id, OLD.request_key, OLD.request_hash,
         OLD.model_id, OLD.cost, OLD.token, OLD.intent, OLD.created_at) THEN
    RAISE EXCEPTION 'Chat turn is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_chat_turn BEFORE UPDATE ON chat_turns
FOR EACH ROW EXECUTE FUNCTION protect_chat_turn();

CREATE FUNCTION protect_chat_message() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.role <> 'assistant' OR
     ROW(NEW.id, NEW.conversation_id, NEW.turn_id, NEW.role, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.conversation_id, OLD.turn_id, OLD.role, OLD.created_at)
     OR NOT EXISTS(SELECT 1 FROM chat_turns WHERE id=OLD.turn_id AND status='RUNNING') THEN
    RAISE EXCEPTION 'Chat message is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_chat_message BEFORE UPDATE ON chat_messages
FOR EACH ROW EXECUTE FUNCTION protect_chat_message();
