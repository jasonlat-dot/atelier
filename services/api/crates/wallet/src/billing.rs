use crate::{billing_types::*, postgres as repo, service::write};
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use sqlx::{PgConnection, PgPool, Row};
use uuid::Uuid;

/// Trusted server-side confirmations only; no anonymous manual webhook exists.
pub trait PaymentProvider {
    fn create_checkout(&self, order: &OrderView) -> String;
    fn verify_webhook(&self, order: &OrderView, paid: &PaidInput) -> Result<(), BillingError>;
    fn refund(&self, confirmed_external: bool) -> Result<(), BillingError>;
}
pub struct ManualProvider;
impl PaymentProvider for ManualProvider {
    fn create_checkout(&self, order: &OrderView) -> String {
        format!(
            "请联系管理员线下付款，并提供订单号 {}。管理员核对到账后发放权益；不会自动扣费续订。",
            order.id
        )
    }
    fn verify_webhook(&self, order: &OrderView, paid: &PaidInput) -> Result<(), BillingError> {
        if paid.amount_cents != order.amount_cents || paid.currency != order.currency {
            return Err(BillingError::PaymentMismatch);
        }
        if paid.trade_no.trim().is_empty()
            || paid.trade_no.len() > 120
            || paid.trade_no.chars().any(char::is_control)
            || paid.reason.trim().is_empty()
            || paid.reason.len() > 1500
        {
            return Err(BillingError::Validation);
        }
        Ok(())
    }
    fn refund(&self, confirmed: bool) -> Result<(), BillingError> {
        if confirmed {
            Ok(())
        } else {
            Err(BillingError::Validation)
        }
    }
}
#[derive(Clone)]
pub struct BillingService {
    pool: PgPool,
}
impl BillingService {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
    pub async fn plans(&self, admin: bool) -> Result<Vec<PlanView>, BillingError> {
        let rows=sqlx::query("SELECT id,revision,to_jsonb(plans)-'id'-'revision'-'created_at' AS details FROM plans WHERE active OR $1 ORDER BY created_at,id").bind(admin).fetch_all(&self.pool).await?;
        rows.into_iter()
            .map(|r| {
                Ok(PlanView {
                    id: r.get("id"),
                    revision: r.get("revision"),
                    details: serde_json::from_value(r.get("details"))
                        .map_err(|_| BillingError::Store)?,
                })
            })
            .collect()
    }
    pub async fn create_plan(
        &self,
        actor: Uuid,
        input: &PlanInput,
    ) -> Result<PlanView, BillingError> {
        validate_plan(input)?;
        let mut tx = self.pool.begin().await?;
        let id = Uuid::new_v4();
        save_plan(&mut tx, id, None, input).await?;
        let view = PlanView {
            id,
            revision: 1,
            details: input.clone(),
        };
        audit(
            &mut tx,
            Some(actor),
            "PLAN_CREATED",
            id,
            Value::Null,
            json!(view),
        )
        .await?;
        tx.commit().await?;
        Ok(view)
    }
    pub async fn update_plan(
        &self,
        actor: Uuid,
        id: Uuid,
        revision: i64,
        input: &PlanInput,
    ) -> Result<PlanView, BillingError> {
        validate_plan(input)?;
        let mut tx = self.pool.begin().await?;
        let old = plan(&mut tx, id).await?;
        if old.revision != revision {
            return Err(BillingError::Conflict);
        }
        save_plan(&mut tx, id, Some(revision), input).await?;
        let view = PlanView {
            id,
            revision: revision + 1,
            details: input.clone(),
        };
        audit(
            &mut tx,
            Some(actor),
            "PLAN_UPDATED",
            id,
            json!(old),
            json!(view),
        )
        .await?;
        tx.commit().await?;
        Ok(view)
    }
    pub async fn create_order(
        &self,
        owner: Uuid,
        key: Uuid,
        input: &OrderInput,
    ) -> Result<OrderView, BillingError> {
        if key.is_nil() || input.plan_id.is_nil() {
            return Err(BillingError::Validation);
        }
        let mut tx = self.pool.begin().await?;
        let scope = format!("order-create:{owner}");
        let fingerprint = json!(input);
        if let Some(value) = repo::receipt(&mut tx, &scope, key, &fingerprint).await? {
            return decode(value);
        }
        lock_owner(&mut tx, owner).await?;
        let p = plan(&mut tx, input.plan_id).await?;
        if !p.details.active || p.revision != input.plan_revision {
            return Err(BillingError::Conflict);
        }
        let pending: i64 =
            sqlx::query_scalar("SELECT count(*) FROM orders WHERE user_id=$1 AND status='PENDING'")
                .bind(owner)
                .fetch_one(&mut *tx)
                .await?;
        if pending >= 20 {
            return Err(BillingError::Conflict);
        }
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO orders(id,user_id,plan_id,plan_snapshot,amount_cents,currency) VALUES($1,$2,$3,$4,$5,$6)")
            .bind(id).bind(owner).bind(p.id).bind(json!(p.details)).bind(p.details.price_cents).bind(&p.details.currency).execute(&mut *tx).await?;
        let view = get_order(&mut tx, id).await?;
        audit(
            &mut tx,
            Some(owner),
            "ORDER_CREATED",
            id,
            Value::Null,
            json!(view),
        )
        .await?;
        repo::save_receipt(&mut tx, &scope, key, fingerprint, json!(view)).await?;
        tx.commit().await?;
        Ok(view)
    }
    pub async fn order(
        &self,
        owner: Uuid,
        id: Uuid,
        admin: bool,
    ) -> Result<OrderView, BillingError> {
        let order = get_order(&mut *self.pool.acquire().await?, id).await?;
        if !admin && order.user_id != owner {
            return Err(BillingError::NotFound);
        }
        Ok(order)
    }
    pub async fn orders(
        &self,
        owner: Option<Uuid>,
        before: Option<Uuid>,
    ) -> Result<OrderPage, BillingError> {
        let mut items:Vec<OrderView>=sqlx::query_as("SELECT * FROM orders WHERE ($1::uuid IS NULL OR user_id=$1) AND ($2::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM orders WHERE id=$2 AND ($1::uuid IS NULL OR user_id=$1))) ORDER BY created_at DESC,id DESC LIMIT 31")
            .bind(owner).bind(before).fetch_all(&self.pool).await?;
        let more = items.len() > 30;
        items.truncate(30);
        let next_cursor = if more {
            items.last().map(|o| o.id)
        } else {
            None
        };
        Ok(OrderPage { items, next_cursor })
    }
    pub async fn cancel_order(&self, owner: Uuid, id: Uuid) -> Result<OrderView, BillingError> {
        let mut tx = self.pool.begin().await?;
        lock_owner(&mut tx, owner).await?;
        let old = get_order(&mut tx, id).await?;
        if old.user_id != owner {
            return Err(BillingError::NotFound);
        }
        if old.status == "CANCELLED" {
            return Ok(old);
        }
        if old.status != "PENDING" {
            return Err(BillingError::Conflict);
        }
        sqlx::query("UPDATE orders SET status='CANCELLED' WHERE id=$1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        let view = get_order(&mut tx, id).await?;
        audit(
            &mut tx,
            Some(owner),
            "ORDER_CANCELLED",
            id,
            json!(old),
            json!(view),
        )
        .await?;
        tx.commit().await?;
        Ok(view)
    }
    pub async fn mark_paid(
        &self,
        actor: Uuid,
        id: Uuid,
        key: Uuid,
        input: &PaidInput,
    ) -> Result<OrderView, BillingError> {
        if key.is_nil() {
            return Err(BillingError::Validation);
        }
        let mut tx = self.pool.begin().await?;
        let scope = format!("order-paid:{id}");
        let fingerprint = json!({"actor":actor,"input":input});
        if let Some(value) = repo::receipt(&mut tx, &scope, key, &fingerprint).await? {
            return decode(value);
        }
        let owner = get_order(&mut tx, id).await?.user_id;
        lock_owner(&mut tx, owner).await?;
        let old = get_order(&mut tx, id).await?;
        ManualProvider.verify_webhook(&old, input)?;
        if old.status == "FULFILLED"
            && old.provider_trade_no.as_deref() == Some(input.trade_no.trim())
        {
            return Ok(old);
        }
        if old.status != "PENDING" {
            return Err(BillingError::Conflict);
        }
        repo::lock_key(&mut tx, &format!("manual-trade:{}", input.trade_no.trim())).await?;
        let duplicate: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM orders WHERE provider='MANUAL' AND provider_trade_no=$1)",
        )
        .bind(input.trade_no.trim())
        .fetch_one(&mut *tx)
        .await?;
        if duplicate {
            return Err(BillingError::DuplicateTrade);
        }
        let details: PlanInput = decode(old.plan_snapshot.clone())?;
        sqlx::query("UPDATE orders SET status='PAID',provider_trade_no=$2,paid_at=clock_timestamp(),confirmed_by=$3 WHERE id=$1").bind(id).bind(input.trade_no.trim()).bind(actor).execute(&mut *tx).await?;
        if details.kind == "PACK" {
            grant_order(&mut tx, &old, details.credits).await?;
        } else {
            let now: DateTime<Utc> = sqlx::query_scalar("SELECT clock_timestamp()")
                .fetch_one(&mut *tx)
                .await?;
            let last:Option<DateTime<Utc>>=sqlx::query_scalar("SELECT max(current_period_end) FROM subscriptions WHERE user_id=$1 AND status IN ('SCHEDULED','ACTIVE')").bind(owner).fetch_one(&mut *tx).await?;
            let starts = last.filter(|v| *v > now).unwrap_or(now);
            // At most 24 prepaid periods; old orders retain their complete price/benefit snapshot.
            let queued: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM subscriptions WHERE user_id=$1 AND status='SCHEDULED'",
            )
            .bind(owner)
            .fetch_one(&mut *tx)
            .await?;
            if queued >= 24 {
                return Err(BillingError::Conflict);
            }
            sqlx::query("INSERT INTO subscriptions(order_id,user_id,plan_id,starts_at,current_period_end,status) VALUES($1,$2,$3,$4,$4+make_interval(days=>$5),'SCHEDULED')")
                .bind(id).bind(owner).bind(old.plan_id).bind(starts).bind(details.period_days.ok_or(BillingError::Store)?).execute(&mut *tx).await?;
        }
        sqlx::query("UPDATE orders SET status='FULFILLED' WHERE id=$1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        settle_periods(&mut tx, owner).await?;
        let view = get_order(&mut tx, id).await?;
        audit(
            &mut tx,
            Some(actor),
            "ORDER_PAID",
            id,
            json!(old),
            json!({"order":view,"reason":input.reason}),
        )
        .await?;
        repo::save_receipt(&mut tx, &scope, key, fingerprint, json!(view)).await?;
        tx.commit().await?;
        Ok(view)
    }
    pub async fn refund_quote(&self, id: Uuid) -> Result<RefundQuote, BillingError> {
        let mut tx = self.pool.begin().await?;
        let order = get_order(&mut tx, id).await?;
        lock_owner(&mut tx, order.user_id).await?;
        settle_periods(&mut tx, order.user_id).await?;
        let q = quote_refund(&mut tx, &order).await?;
        tx.commit().await?;
        Ok(q)
    }
    pub async fn refund(
        &self,
        actor: Uuid,
        id: Uuid,
        key: Uuid,
        input: &RefundInput,
    ) -> Result<OrderView, BillingError> {
        if key.is_nil() || input.reason.trim().is_empty() || input.reason.len() > 1500 {
            return Err(BillingError::Validation);
        }
        ManualProvider.refund(input.confirm_external_refund)?;
        let mut tx = self.pool.begin().await?;
        let scope = format!("order-refund:{id}");
        let fingerprint = json!({"actor":actor,"input":input});
        if let Some(value) = repo::receipt(&mut tx, &scope, key, &fingerprint).await? {
            return decode(value);
        }
        let owner = get_order(&mut tx, id).await?.user_id;
        lock_owner(&mut tx, owner).await?;
        let old = get_order(&mut tx, id).await?;
        if old.status != "FULFILLED" {
            return Err(BillingError::Conflict);
        }
        settle_periods(&mut tx, owner).await?;
        let quote = quote_refund(&mut tx, &old).await?;
        if quote.held_credits > 0 {
            return Err(BillingError::CreditsHeld);
        }
        if input.expected_credits != quote.refundable_credits {
            return Err(BillingError::Conflict);
        }
        let actual = remaining(&mut tx, id).await?;
        if actual > 0 {
            debit_order(
                &mut tx,
                &old,
                actor,
                actual,
                "order_refund",
                &format!("order:{id}:refund"),
                &input.reason,
            )
            .await?;
        }
        sqlx::query("UPDATE subscriptions SET status='REFUNDED' WHERE order_id=$1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query(
            "UPDATE orders SET status='REFUNDED',refund_cents=$2,recovered_credits=$3 WHERE id=$1",
        )
        .bind(id)
        .bind(quote.refund_cents)
        .bind(actual)
        .execute(&mut *tx)
        .await?;
        let view = get_order(&mut tx, id).await?;
        audit(
            &mut tx,
            Some(actor),
            "ORDER_REFUNDED",
            id,
            json!(old),
            json!({"order":view,"reason":input.reason}),
        )
        .await?;
        repo::save_receipt(&mut tx, &scope, key, fingerprint, json!(view)).await?;
        tx.commit().await?;
        Ok(view)
    }
    pub async fn entitlements(&self, owner: Uuid) -> Result<Entitlements, BillingError> {
        let mut tx = self.pool.begin().await?;
        let result = Self::entitlements_in_transaction(&mut tx, owner).await?;
        tx.commit().await?;
        Ok(result)
    }
    pub async fn entitlements_in_transaction(
        db: &mut PgConnection,
        owner: Uuid,
    ) -> Result<Entitlements, BillingError> {
        lock_owner(db, owner).await?;
        settle_periods(db, owner).await?;
        let row=sqlx::query("SELECT o.plan_snapshot,s.current_period_end FROM subscriptions s JOIN orders o ON o.id=s.order_id WHERE s.user_id=$1 AND s.starts_at<=clock_timestamp() AND s.current_period_end>clock_timestamp() AND s.status='ACTIVE' AND o.status='FULFILLED' ORDER BY s.starts_at DESC LIMIT 1").bind(owner).fetch_optional(&mut *db).await?;
        let scheduled: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM subscriptions WHERE user_id=$1 AND status='SCHEDULED'",
        )
        .bind(owner)
        .fetch_one(&mut *db)
        .await?;
        if let Some(row) = row {
            let p: PlanInput = decode(row.get("plan_snapshot"))?;
            return Ok(Entitlements {
                tier: "SUBSCRIBER".into(),
                plan_name: Some(p.name),
                current_period_end: Some(row.get("current_period_end")),
                max_active_jobs: i64::from(p.concurrency_limit),
                max_resolution: p.max_resolution,
                retention_days: p.retention_days,
                scheduled_periods: scheduled,
            });
        }
        let values:Value=sqlx::query_scalar("SELECT jsonb_object_agg(key,value) FROM system_settings WHERE key IN ('free_max_resolution','max_active_jobs_free','asset_retention_days_free')").fetch_one(db).await?;
        let resolution = values["free_max_resolution"]
            .as_str()
            .filter(|s| ["1K", "2K", "4K"].contains(s))
            .ok_or(BillingError::Store)?;
        Ok(Entitlements {
            tier: "FREE".into(),
            plan_name: None,
            current_period_end: None,
            max_active_jobs: values["max_active_jobs_free"]
                .as_i64()
                .filter(|n| (1..=64).contains(n))
                .ok_or(BillingError::Store)?,
            max_resolution: resolution.into(),
            retention_days: values["asset_retention_days_free"]
                .as_i64()
                .filter(|n| (1..=3650).contains(n))
                .ok_or(BillingError::Store)? as i32,
            scheduled_periods: scheduled,
        })
    }
    pub async fn maintain(&self) -> Result<(), BillingError> {
        let owners:Vec<Uuid>=sqlx::query_scalar("SELECT DISTINCT s.user_id FROM subscriptions s JOIN users u ON u.id=s.user_id JOIN orders o ON o.id=s.order_id WHERE u.status='ACTIVE' AND o.status='FULFILLED' AND ((s.status='SCHEDULED' AND s.starts_at<=clock_timestamp()) OR (s.status='ACTIVE' AND s.current_period_end<=clock_timestamp()) OR (s.status='EXPIRED' AND (((o.plan_snapshot->>'rollover')::boolean AND s.grant_ledger_id IS NULL) OR (NOT (o.plan_snapshot->>'rollover')::boolean AND EXISTS(SELECT 1 FROM wallet_credit_lots b WHERE b.ledger_id=s.grant_ledger_id AND b.remaining>0))))) ORDER BY s.user_id").fetch_all(&self.pool).await?;
        for owner in owners {
            let mut tx = self.pool.begin().await?;
            lock_owner(&mut tx, owner).await?;
            settle_periods(&mut tx, owner).await?;
            tx.commit().await?;
        }
        Ok(())
    }
    pub async fn maintenance_loop(self) {
        let mut timer = tokio::time::interval(std::time::Duration::from_secs(86400));
        loop {
            timer.tick().await;
            if self.maintain().await.is_err() {
                tracing::error!("BILLING_MAINTENANCE_UNAVAILABLE");
            }
        }
    }
}
fn decode<T: serde::de::DeserializeOwned>(v: Value) -> Result<T, BillingError> {
    serde_json::from_value(v).map_err(|_| BillingError::Store)
}
fn validate_plan(p: &PlanInput) -> Result<(), BillingError> {
    if p.name.trim().is_empty()
        || p.name.chars().count() > 80
        || p.description.chars().count() > 2000
        || p.name.chars().any(char::is_control)
        || !(1..=100000000).contains(&p.price_cents)
        || !(1..=100000000).contains(&p.credits)
        || !["CNY", "USD"].contains(&p.currency.as_str())
        || !["1K", "2K", "4K"].contains(&p.max_resolution.as_str())
        || !(1..=64).contains(&p.concurrency_limit)
        || !(1..=3650).contains(&p.retention_days)
        || !matches!(p.kind.as_str(), "PACK" | "MONTHLY")
        || (p.kind == "PACK" && p.period_days.is_some())
        || (p.kind == "MONTHLY" && p.period_days.is_none_or(|d| !(1..=366).contains(&d)))
    {
        return Err(BillingError::Validation);
    }
    Ok(())
}
async fn lock_owner(db: &mut PgConnection, id: Uuid) -> Result<(), BillingError> {
    let found: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM users WHERE id=$1 AND status='ACTIVE' FOR UPDATE")
            .bind(id)
            .fetch_optional(db)
            .await?;
    if found.is_none() {
        return Err(BillingError::NotFound);
    }
    Ok(())
}
async fn plan(db: &mut PgConnection, id: Uuid) -> Result<PlanView, BillingError> {
    let row=sqlx::query("SELECT revision,to_jsonb(plans)-'id'-'revision'-'created_at' AS details FROM plans WHERE id=$1 FOR UPDATE").bind(id).fetch_optional(db).await?.ok_or(BillingError::NotFound)?;
    Ok(PlanView {
        id,
        revision: row.get("revision"),
        details: decode(row.get("details"))?,
    })
}
async fn save_plan(
    db: &mut PgConnection,
    id: Uuid,
    revision: Option<i64>,
    p: &PlanInput,
) -> Result<(), BillingError> {
    if revision.is_none() {
        sqlx::query("INSERT INTO plans(id,name,kind,description,price_cents,currency,credits,period_days,rollover,concurrency_limit,max_resolution,retention_days,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)").bind(id).bind(&p.name).bind(&p.kind).bind(&p.description).bind(p.price_cents).bind(&p.currency).bind(p.credits).bind(p.period_days).bind(p.rollover).bind(p.concurrency_limit).bind(&p.max_resolution).bind(p.retention_days).bind(p.active).execute(db).await?;
    } else {
        sqlx::query("UPDATE plans SET name=$2,kind=$3,description=$4,price_cents=$5,currency=$6,credits=$7,period_days=$8,rollover=$9,concurrency_limit=$10,max_resolution=$11,retention_days=$12,active=$13,revision=revision+1 WHERE id=$1").bind(id).bind(&p.name).bind(&p.kind).bind(&p.description).bind(p.price_cents).bind(&p.currency).bind(p.credits).bind(p.period_days).bind(p.rollover).bind(p.concurrency_limit).bind(&p.max_resolution).bind(p.retention_days).bind(p.active).execute(db).await?;
    }
    Ok(())
}
async fn get_order(db: &mut PgConnection, id: Uuid) -> Result<OrderView, BillingError> {
    sqlx::query_as("SELECT * FROM orders WHERE id=$1")
        .bind(id)
        .fetch_optional(db)
        .await?
        .ok_or(BillingError::NotFound)
}
async fn audit(
    db: &mut PgConnection,
    actor: Option<Uuid>,
    action: &str,
    id: Uuid,
    before: Value,
    after: Value,
) -> Result<(), BillingError> {
    sqlx::query("INSERT INTO audit_logs(actor_id,action,target_type,target_id,before,after) VALUES($1,$2,'billing',$3,$4,$5)").bind(actor).bind(action).bind(id.to_string()).bind(before).bind(after).execute(db).await?;
    Ok(())
}
async fn grant_order(
    db: &mut PgConnection,
    o: &OrderView,
    credits: i64,
) -> Result<i64, BillingError> {
    Ok(write(
        db,
        &format!("order:{}:purchase", o.id),
        repo::Journal {
            id: 0,
            owner: o.user_id,
            kind: "PURCHASE".into(),
            balance: credits,
            held: 0,
            ref_type: Some("order".into()),
            reference: Some(o.id.to_string()),
            reason: Some("订单确认到账".into()),
            actor: None,
        },
    )
    .await?
    .ledger_id)
}
async fn remaining(db: &mut PgConnection, id: Uuid) -> Result<i64, BillingError> {
    Ok(sqlx::query_scalar("SELECT COALESCE(sum(b.remaining),0)::bigint FROM wallet_credit_lots b JOIN credit_ledger l ON l.id=b.ledger_id WHERE l.ref_type='order' AND l.ref_id=$1").bind(id.to_string()).fetch_one(db).await?)
}
async fn quote_refund(db: &mut PgConnection, o: &OrderView) -> Result<RefundQuote, BillingError> {
    if o.status != "FULFILLED" {
        return Err(BillingError::Conflict);
    }
    let (_, held) = repo::wallet(db, o.user_id).await?;
    let p: PlanInput = decode(o.plan_snapshot.clone())?;
    let scheduled:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM subscriptions WHERE order_id=$1 AND status='SCHEDULED' AND grant_ledger_id IS NULL)").bind(o.id).fetch_one(&mut *db).await?;
    let amount = if scheduled {
        p.credits
    } else {
        remaining(db, o.id).await?
    };
    let cents = i64::from(o.amount_cents)
        .checked_mul(amount)
        .ok_or(BillingError::Store)?
        / p.credits;
    Ok(RefundQuote {
        refundable_credits: amount,
        refund_cents: cents as i32,
        held_credits: held,
    })
}
async fn debit_order(
    db: &mut PgConnection,
    o: &OrderView,
    actor: Uuid,
    amount: i64,
    kind: &str,
    key: &str,
    reason: &str,
) -> Result<(), BillingError> {
    write(
        db,
        key,
        repo::Journal {
            id: 0,
            owner: o.user_id,
            kind: "ADMIN_ADJUST".into(),
            balance: -amount,
            held: 0,
            ref_type: Some(kind.into()),
            reference: Some(o.id.to_string()),
            reason: Some(reason.into()),
            actor: Some(actor),
        },
    )
    .await?;
    Ok(())
}
async fn settle_periods(db: &mut PgConnection, owner: Uuid) -> Result<(), BillingError> {
    let periods=sqlx::query("SELECT s.id,s.order_id,s.status,s.current_period_end<=clock_timestamp() AS ended,s.starts_at<=clock_timestamp() AS started,s.grant_ledger_id,o.plan_snapshot,o.confirmed_by FROM subscriptions s JOIN orders o ON o.id=s.order_id WHERE s.user_id=$1 AND s.status IN ('SCHEDULED','ACTIVE','EXPIRED') AND o.status='FULFILLED' ORDER BY s.starts_at,s.id FOR UPDATE OF s").bind(owner).fetch_all(&mut *db).await?;
    for row in periods {
        let id: Uuid = row.get("id");
        let order_id: Uuid = row.get("order_id");
        let p: PlanInput = decode(row.get("plan_snapshot"))?;
        if row.get::<bool, _>("ended") {
            // A missed maintenance window must not destroy paid, non-expiring credits.
            if p.rollover && row.get::<Option<i64>, _>("grant_ledger_id").is_none() {
                let order = get_order(db, order_id).await?;
                let ledger = grant_order(db, &order, p.credits).await?;
                sqlx::query("UPDATE subscriptions SET grant_ledger_id=$2 WHERE id=$1")
                    .bind(id)
                    .bind(ledger)
                    .execute(&mut *db)
                    .await?;
                audit(
                    db,
                    Some(row.get("confirmed_by")),
                    "SUBSCRIPTION_PERIOD_GRANTED",
                    order_id,
                    Value::Null,
                    json!({"ledger_id":ledger,"catch_up":true}),
                )
                .await?;
            }
            if row.get::<String, _>("status") != "EXPIRED" {
                audit(
                    db,
                    Some(row.get("confirmed_by")),
                    "SUBSCRIPTION_EXPIRED",
                    order_id,
                    json!({"status":row.get::<String,_>("status")}),
                    json!({"status":"EXPIRED","automatic":true}),
                )
                .await?;
            }
            if !p.rollover && row.get::<Option<i64>, _>("grant_ledger_id").is_some() {
                let amount = remaining(db, order_id).await?;
                let (balance, held) = repo::wallet(db, owner).await?;
                let reclaim = amount.min(balance - held);
                if reclaim > 0 {
                    let order = get_order(db, order_id).await?;
                    debit_order(
                        db,
                        &order,
                        row.get("confirmed_by"),
                        reclaim,
                        "subscription_expiry",
                        &format!("order:{order_id}:expiry:{amount}"),
                        "订阅周期到期，回收未使用周期积分",
                    )
                    .await?;
                }
            }
            sqlx::query("UPDATE subscriptions SET status='EXPIRED' WHERE id=$1")
                .bind(id)
                .execute(&mut *db)
                .await?;
        } else if row.get::<bool, _>("started") && row.get::<String, _>("status") == "SCHEDULED" {
            let order = get_order(db, order_id).await?;
            let ledger = grant_order(db, &order, p.credits).await?;
            sqlx::query("UPDATE subscriptions SET status='ACTIVE',grant_ledger_id=$2 WHERE id=$1")
                .bind(id)
                .bind(ledger)
                .execute(&mut *db)
                .await?;
            audit(
                db,
                Some(row.get("confirmed_by")),
                "SUBSCRIPTION_PERIOD_GRANTED",
                order_id,
                Value::Null,
                json!({"ledger_id":ledger}),
            )
            .await?;
        }
    }
    Ok(())
}
