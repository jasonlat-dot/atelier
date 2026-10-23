use crate::{LedgerEntry, WalletError};
use chrono::{DateTime, NaiveDate, Utc};
use serde_json::Value;
use sqlx::{PgConnection, Row};
use uuid::Uuid;

pub(crate) async fn restrict_ledger(db: &mut PgConnection) -> Result<(), WalletError> {
    sqlx::query("REVOKE UPDATE, DELETE, TRUNCATE ON credit_ledger FROM CURRENT_USER")
        .execute(db)
        .await?;
    Ok(())
}

pub(crate) async fn lock_key(db: &mut PgConnection, key: &str) -> Result<(), WalletError> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(key)
        .execute(db)
        .await?;
    Ok(())
}
pub(crate) async fn wallet(db: &mut PgConnection, owner: Uuid) -> Result<(i64, i64), WalletError> {
    let row = sqlx::query("SELECT balance,held FROM wallets WHERE user_id=$1 FOR UPDATE")
        .bind(owner)
        .fetch_optional(db)
        .await?
        .ok_or(WalletError::NotFound)?;
    Ok((row.get("balance"), row.get("held")))
}
pub(crate) async fn existing(
    db: &mut PgConnection,
    key: &str,
) -> Result<Option<Journal>, WalletError> {
    let row = sqlx::query("SELECT id,user_id,type,balance_delta,held_delta,ref_type,ref_id,reason,actor_id FROM credit_ledger WHERE idempotency_key=$1")
        .bind(key).fetch_optional(db).await?;
    Ok(row.map(|r| Journal {
        id: r.get("id"),
        owner: r.get("user_id"),
        kind: r.get("type"),
        balance: r.get("balance_delta"),
        held: r.get("held_delta"),
        ref_type: r.get("ref_type"),
        reference: r.get("ref_id"),
        reason: r.get("reason"),
        actor: r.get("actor_id"),
    }))
}
#[derive(Debug, PartialEq)]
pub(crate) struct Journal {
    pub id: i64,
    pub owner: Uuid,
    pub kind: String,
    pub balance: i64,
    pub held: i64,
    pub ref_type: Option<String>,
    pub reference: Option<String>,
    pub reason: Option<String>,
    pub actor: Option<Uuid>,
}
pub(crate) async fn append(
    db: &mut PgConnection,
    key: &str,
    entry: &Journal,
) -> Result<i64, WalletError> {
    Ok(sqlx::query_scalar("INSERT INTO credit_ledger(user_id,type,balance_delta,held_delta,idempotency_key,ref_type,ref_id,reason,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id")
        .bind(entry.owner).bind(&entry.kind).bind(entry.balance).bind(entry.held).bind(key).bind(&entry.ref_type).bind(&entry.reference).bind(&entry.reason).bind(entry.actor).fetch_one(db).await?)
}
pub(crate) async fn update(
    db: &mut PgConnection,
    owner: Uuid,
    balance: i64,
    held: i64,
) -> Result<(), WalletError> {
    sqlx::query("UPDATE wallets SET balance=$2,held=$3 WHERE user_id=$1")
        .bind(owner)
        .bind(balance)
        .bind(held)
        .execute(db)
        .await?;
    Ok(())
}
// Allocation is authoritative only for reversals/expiry. All sources share one balance.
pub(crate) async fn allocate(
    db: &mut PgConnection,
    entry: &Journal,
    ledger: i64,
) -> Result<(), WalletError> {
    if entry.balance > 0 {
        sqlx::query("INSERT INTO wallet_credit_lots(user_id,ledger_id,credits,remaining) VALUES($1,$2,$3,$3)")
            .bind(entry.owner).bind(ledger).bind(entry.balance).execute(db).await?;
    } else if entry.balance < 0 {
        let target = if matches!(
            entry.ref_type.as_deref(),
            Some("order_refund" | "subscription_expiry")
        ) {
            entry.reference.as_deref()
        } else {
            None
        };
        let rows = sqlx::query("SELECT b.id,b.remaining FROM wallet_credit_lots b LEFT JOIN credit_ledger l ON l.id=b.ledger_id WHERE b.user_id=$1 AND b.remaining>0 AND ($2::text IS NULL OR (l.ref_type='order' AND l.ref_id=$2)) ORDER BY b.id FOR UPDATE OF b")
            .bind(entry.owner).bind(target).fetch_all(&mut *db).await?;
        let mut left = entry.balance.checked_neg().ok_or(WalletError::Validation)?;
        for row in rows {
            let amount = left.min(row.get("remaining"));
            sqlx::query("UPDATE wallet_credit_lots SET remaining=remaining-$2 WHERE id=$1")
                .bind(row.get::<i64, _>("id"))
                .bind(amount)
                .execute(&mut *db)
                .await?;
            left -= amount;
            if left == 0 {
                break;
            }
        }
        if left != 0 {
            return Err(WalletError::Store);
        }
    }
    Ok(())
}
pub(crate) async fn outstanding(
    db: &mut PgConnection,
    owner: Uuid,
    job: &str,
) -> Result<i64, WalletError> {
    Ok(sqlx::query_scalar("SELECT COALESCE(SUM(held_delta),0)::bigint FROM credit_ledger WHERE user_id=$1 AND ref_type='job' AND ref_id=$2")
        .bind(owner).bind(job).fetch_one(db).await?)
}
pub(crate) async fn settings(
    db: &mut PgConnection,
) -> Result<(i32, i32, String, NaiveDate), WalletError> {
    let rows = sqlx::query("SELECT key,value FROM system_settings WHERE key IN ('checkin_base','checkin_streak_cap','checkin_tz') ORDER BY key FOR SHARE").fetch_all(&mut *db).await?;
    let settings: std::collections::HashMap<String, Value> = rows
        .into_iter()
        .map(|r| (r.get("key"), r.get("value")))
        .collect();
    let integer = |key: &str| {
        settings
            .get(key)
            .and_then(Value::as_i64)
            .filter(|v| (0..=1_000_000).contains(v))
            .map(|v| v as i32)
            .ok_or(WalletError::Store)
    };
    let timezone = settings
        .get("checkin_tz")
        .and_then(Value::as_str)
        .ok_or(WalletError::Store)?
        .to_string();
    // PostgreSQL owns timezone rules and the transaction timestamp. No host TZ dependency.
    let date: NaiveDate =
        sqlx::query_scalar("SELECT (transaction_timestamp() AT TIME ZONE $1)::date")
            .bind(&timezone)
            .fetch_one(db)
            .await?;
    Ok((
        integer("checkin_base")?,
        integer("checkin_streak_cap")?,
        timezone,
        date,
    ))
}
pub(crate) async fn latest_checkin(
    db: &mut PgConnection,
    owner: Uuid,
) -> Result<Option<(NaiveDate, i32, i32)>, WalletError> {
    Ok(sqlx::query_as("SELECT local_date,streak,credits FROM checkins WHERE user_id=$1 ORDER BY local_date DESC LIMIT 1").bind(owner).fetch_optional(db).await?)
}
pub(crate) async fn checkin(
    db: &mut PgConnection,
    owner: Uuid,
    date: NaiveDate,
    streak: i32,
    credits: i32,
) -> Result<(), WalletError> {
    sqlx::query("INSERT INTO checkins(user_id,local_date,streak,credits) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING")
        .bind(owner).bind(date).bind(streak).bind(credits).execute(db).await?;
    Ok(())
}
pub(crate) async fn audit(
    db: &mut PgConnection,
    actor: Uuid,
    action: &str,
    target: &str,
    after: Value,
) -> Result<(), WalletError> {
    sqlx::query("INSERT INTO audit_logs(actor_id,action,target_type,target_id,before,after) VALUES($1,$2,'wallet',$3,'null'::jsonb,$4)")
        .bind(actor).bind(action).bind(target).bind(after).execute(db).await?;
    Ok(())
}
pub(crate) async fn receipt(
    db: &mut PgConnection,
    scope: &str,
    key: Uuid,
    fingerprint: &Value,
) -> Result<Option<Value>, WalletError> {
    lock_key(db, &format!("wallet-request:{scope}:{key}")).await?;
    let row = sqlx::query(
        "SELECT fingerprint,response FROM wallet_requests WHERE scope=$1 AND request_id=$2",
    )
    .bind(scope)
    .bind(key)
    .fetch_optional(db)
    .await?;
    row.map(|r| {
        if r.get::<Value, _>("fingerprint") == *fingerprint {
            Ok(r.get("response"))
        } else {
            Err(WalletError::Conflict)
        }
    })
    .transpose()
}
pub(crate) async fn save_receipt(
    db: &mut PgConnection,
    scope: &str,
    key: Uuid,
    fingerprint: Value,
    response: Value,
) -> Result<(), WalletError> {
    sqlx::query(
        "INSERT INTO wallet_requests(scope,request_id,fingerprint,response) VALUES($1,$2,$3,$4)",
    )
    .bind(scope)
    .bind(key)
    .bind(fingerprint)
    .bind(response)
    .execute(db)
    .await?;
    Ok(())
}
pub(crate) async fn ledger(
    db: &mut PgConnection,
    owner: Uuid,
    cursor: Option<i64>,
    limit: i64,
) -> Result<Vec<LedgerEntry>, WalletError> {
    Ok(sqlx::query_as("SELECT id,type,balance_delta,held_delta,reason,created_at FROM credit_ledger WHERE user_id=$1 AND ($2::bigint IS NULL OR id<$2) ORDER BY id DESC LIMIT $3")
        .bind(owner).bind(cursor).bind(limit).fetch_all(db).await?)
}
pub(crate) async fn signup(db: &mut PgConnection, owner: Uuid) -> Result<i64, WalletError> {
    sqlx::query("INSERT INTO wallets(user_id) VALUES($1) ON CONFLICT DO NOTHING")
        .bind(owner)
        .execute(&mut *db)
        .await?;
    let value: Value =
        sqlx::query_scalar("SELECT value FROM system_settings WHERE key='signup_bonus' FOR SHARE")
            .fetch_one(db)
            .await?;
    value
        .as_i64()
        .filter(|v| (0..=1_000_000).contains(v))
        .ok_or(WalletError::Store)
}
pub(crate) async fn code(db: &mut PgConnection, hash: &[u8]) -> Result<(Uuid, i64), WalletError> {
    sqlx::query_as("SELECT id,credits FROM redeem_codes WHERE code_hash=$1 AND used_count<max_uses AND (expires_at IS NULL OR expires_at>now()) FOR UPDATE")
        .bind(hash).fetch_optional(db).await?.ok_or(WalletError::InvalidCode)
}
pub(crate) async fn consume_code(db: &mut PgConnection, code: Uuid) -> Result<(), WalletError> {
    sqlx::query("UPDATE redeem_codes SET used_count=used_count+1 WHERE id=$1")
        .bind(code)
        .execute(db)
        .await?;
    Ok(())
}
pub(crate) async fn insert_code(
    db: &mut PgConnection,
    actor: Uuid,
    hash: &[u8],
    credits: i64,
    uses: i32,
    expires: Option<DateTime<Utc>>,
) -> Result<Uuid, WalletError> {
    Ok(sqlx::query_scalar("INSERT INTO redeem_codes(code_hash,credits,max_uses,expires_at,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id")
        .bind(hash).bind(credits).bind(uses).bind(expires).bind(actor).fetch_one(db).await?)
}
pub(crate) async fn codes(
    db: &mut PgConnection,
    cursor: Option<Uuid>,
) -> Result<Vec<crate::CodeInfo>, WalletError> {
    Ok(sqlx::query_as("SELECT id,credits,max_uses,used_count,expires_at,created_at FROM redeem_codes WHERE ($1::uuid IS NULL OR id<$1) ORDER BY id DESC LIMIT 50")
        .bind(cursor).fetch_all(db).await?)
}
pub(crate) async fn reconcile(db: &mut PgConnection) -> Result<Vec<Uuid>, WalletError> {
    // A single statement sees wallets and ledger from the same MVCC snapshot.
    Ok(sqlx::query_scalar("SELECT w.user_id FROM wallets w LEFT JOIN credit_ledger l ON l.user_id=w.user_id GROUP BY w.user_id,w.balance,w.held HAVING w.balance<>COALESCE(SUM(l.balance_delta),0) OR w.held<>COALESCE(SUM(l.held_delta),0) ORDER BY w.user_id")
        .fetch_all(db).await?)
}
