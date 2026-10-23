-- Preserve the exact financial contract accepted when an order was created.
CREATE FUNCTION protect_billing_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'order history is immutable'; END IF;
 IF ROW(NEW.id,NEW.user_id,NEW.plan_id,NEW.plan_snapshot,NEW.amount_cents,NEW.currency,NEW.provider,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.user_id,OLD.plan_id,OLD.plan_snapshot,OLD.amount_cents,OLD.currency,OLD.provider,OLD.created_at)
 THEN RAISE EXCEPTION 'order snapshot is immutable'; END IF;
 IF NEW.status<>OLD.status AND NOT (
   (OLD.status='PENDING' AND NEW.status IN ('PAID','CANCELLED')) OR
   (OLD.status='PAID' AND NEW.status='FULFILLED') OR
   (OLD.status='FULFILLED' AND NEW.status='REFUNDED'))
 THEN RAISE EXCEPTION 'invalid order transition'; END IF;
 IF OLD.status<>'PENDING' AND ROW(NEW.provider_trade_no,NEW.paid_at,NEW.confirmed_by)
    IS DISTINCT FROM ROW(OLD.provider_trade_no,OLD.paid_at,OLD.confirmed_by)
 THEN RAISE EXCEPTION 'payment receipt is immutable'; END IF;
 IF NEW.status IN ('PAID','FULFILLED','REFUNDED') AND
    (NEW.provider_trade_no IS NULL OR NEW.paid_at IS NULL OR NEW.confirmed_by IS NULL)
 THEN RAISE EXCEPTION 'paid order requires receipt'; END IF;
 IF ROW(NEW.refund_cents,NEW.recovered_credits) IS DISTINCT FROM ROW(OLD.refund_cents,OLD.recovered_credits)
    AND NOT (OLD.status='FULFILLED' AND NEW.status='REFUNDED')
 THEN RAISE EXCEPTION 'refund receipt is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER billing_order_guard BEFORE UPDATE OR DELETE ON orders FOR EACH ROW EXECUTE FUNCTION protect_billing_order();
