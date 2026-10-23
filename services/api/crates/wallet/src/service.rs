use crate::{postgres as repo, *};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::{PgConnection, PgPool};
use uuid::Uuid;

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum WalletError {
    #[error("Insufficient available credits")]
    Insufficient,
    #[error("Idempotency key reused with different parameters")]
    Conflict,
    #[error("Invalid wallet operation")]
    Validation,
    #[error("Invalid, expired or exhausted redeem code")]
    InvalidCode,
    #[error("Wallet not found")]
    NotFound,
    #[error("Wallet service unavailable")]
    Store,
}
impl From<sqlx::Error> for WalletError {
    fn from(_: sqlx::Error) -> Self {
        Self::Store
    }
}
#[derive(Clone)]
pub struct WalletService {
    pool: PgPool,
}
pub enum Operation<'a> {
    Grant { amount: i64, key: &'a str },
    Hold { job: Uuid, amount: i64 },
    Release { job: Uuid, amount: i64 },
    Settle { job: Uuid, index: u32, amount: i64 },
}
impl WalletService {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
    /// Run after migrations using the owning deployment role; no ledger mutation rights at runtime.
    pub async fn restrict_ledger(&self) -> Result<(), WalletError> {
        repo::restrict_ledger(&mut *self.pool.acquire().await?).await
    }
    pub async fn summary(&self, owner: Uuid) -> Result<WalletSummary, WalletError> {
        let mut tx = self.pool.begin().await?;
        let (balance, held) = repo::wallet(&mut tx, owner).await?;
        let (base, cap, timezone, date) = repo::settings(&mut tx).await?;
        let last = repo::latest_checkin(&mut tx, owner).await?;
        let checked = last.is_some_and(|(day, _, _)| day == date);
        let streak = last
            .filter(|(day, _, _)| Some(*day) == date.pred_opt() || *day == date)
            .map(|(_, s, _)| s)
            .unwrap_or(0);
        let next_reward = base + streak.min(cap);
        tx.commit().await?;
        Ok(WalletSummary {
            balance,
            held,
            available: balance - held,
            local_date: date,
            timezone,
            checked_in_today: checked,
            streak,
            next_reward,
        })
    }
    pub async fn ledger(
        &self,
        owner: Uuid,
        cursor: Option<i64>,
        limit: i64,
    ) -> Result<LedgerPage, WalletError> {
        if !(1..=100).contains(&limit) || cursor.is_some_and(|v| v <= 0) {
            return Err(WalletError::Validation);
        }
        let mut db = self.pool.acquire().await?;
        let mut items = repo::ledger(&mut db, owner, cursor, limit + 1).await?;
        let more = items.len() > limit as usize;
        items.truncate(limit as usize);
        let next_cursor = if more {
            items.last().map(|e| e.id)
        } else {
            None
        };
        Ok(LedgerPage { items, next_cursor })
    }
    pub async fn apply(
        &self,
        owner: Uuid,
        operation: Operation<'_>,
    ) -> Result<CreditReceipt, WalletError> {
        let mut tx = self.pool.begin().await?;
        let result = Self::apply_in_transaction(&mut tx, owner, operation).await?;
        tx.commit().await?;
        Ok(result)
    }
    /// Enables future job/order creation and the wallet write to commit atomically.
    pub async fn apply_in_transaction(
        db: &mut PgConnection,
        owner: Uuid,
        operation: Operation<'_>,
    ) -> Result<CreditReceipt, WalletError> {
        let (key, kind, balance, held, job) = match operation {
            Operation::Grant { amount, key } => {
                positive(amount)?;
                if key.is_empty() || key.len() > 200 {
                    return Err(WalletError::Validation);
                }
                (key.into(), "PURCHASE", amount, 0, None)
            }
            Operation::Hold { job, amount } => {
                positive(amount)?;
                (format!("job:{job}:hold"), "HOLD", 0, amount, Some(job))
            }
            Operation::Release { job, amount } => {
                positive(amount)?;
                (
                    format!("job:{job}:release"),
                    "RELEASE",
                    0,
                    -amount,
                    Some(job),
                )
            }
            Operation::Settle { job, index, amount } => {
                positive(amount)?;
                (
                    format!("job:{job}:settle:{index}"),
                    "SETTLE",
                    -amount,
                    -amount,
                    Some(job),
                )
            }
        };
        let entry = repo::Journal {
            id: 0,
            owner,
            kind: kind.into(),
            balance,
            held,
            ref_type: job.map(|_| "job".into()),
            reference: job.map(|j| j.to_string()),
            reason: None,
            actor: None,
        };
        repo::lock_key(db, &key).await?;
        write(db, &key, entry).await
    }
    pub async fn grant(
        &self,
        owner: Uuid,
        amount: i64,
        key: &str,
    ) -> Result<CreditReceipt, WalletError> {
        self.apply(owner, Operation::Grant { amount, key }).await
    }
    pub async fn hold(
        &self,
        owner: Uuid,
        job: Uuid,
        amount: i64,
    ) -> Result<CreditReceipt, WalletError> {
        self.apply(owner, Operation::Hold { job, amount }).await
    }
    pub async fn release(
        &self,
        owner: Uuid,
        job: Uuid,
        amount: i64,
    ) -> Result<CreditReceipt, WalletError> {
        self.apply(owner, Operation::Release { job, amount }).await
    }
    pub async fn settle(
        &self,
        owner: Uuid,
        job: Uuid,
        index: u32,
        amount: i64,
    ) -> Result<CreditReceipt, WalletError> {
        self.apply(owner, Operation::Settle { job, index, amount })
            .await
    }
    /// Called inside the identity transaction, only when a new identity is inserted.
    pub async fn signup_in_transaction(
        db: &mut PgConnection,
        owner: Uuid,
    ) -> Result<(), WalletError> {
        let amount = repo::signup(db, owner).await?;
        let key = format!("signup:{owner}");
        // User row serializes registration. No independent transaction can observe it yet.
        write(
            db,
            &key,
            repo::Journal {
                id: 0,
                owner,
                kind: "SIGNUP_BONUS".into(),
                balance: amount,
                held: 0,
                ref_type: None,
                reference: None,
                reason: None,
                actor: None,
            },
        )
        .await?;
        Ok(())
    }
    pub async fn checkin(&self, owner: Uuid) -> Result<CheckinReceipt, WalletError> {
        let mut tx = self.pool.begin().await?;
        repo::wallet(&mut tx, owner).await?;
        let (base, cap, _, date) = repo::settings(&mut tx).await?;
        let last = repo::latest_checkin(&mut tx, owner).await?;
        if let Some((day, streak, credits)) = last {
            if day == date {
                return Ok(CheckinReceipt {
                    local_date: date,
                    streak,
                    credits,
                    already_checked_in: true,
                });
            }
        }
        // A timezone moving backwards must not award a previous day again.
        if last.is_some_and(|(day, _, _)| day > date) {
            return Err(WalletError::Validation);
        }
        let streak = match last {
            Some((day, streak, _)) if Some(day) == date.pred_opt() => {
                streak.checked_add(1).ok_or(WalletError::Validation)?
            }
            _ => 1,
        };
        let credits = base + (streak - 1).min(cap);
        repo::checkin(&mut tx, owner, date, streak, credits).await?;
        write(
            &mut tx,
            &format!("checkin:{owner}:{date}"),
            repo::Journal {
                id: 0,
                owner,
                kind: "CHECKIN".into(),
                balance: i64::from(credits),
                held: 0,
                ref_type: None,
                reference: None,
                reason: None,
                actor: None,
            },
        )
        .await?;
        tx.commit().await?;
        Ok(CheckinReceipt {
            local_date: date,
            streak,
            credits,
            already_checked_in: false,
        })
    }
    pub async fn adjust(
        &self,
        actor: Uuid,
        owner: Uuid,
        request: Uuid,
        amount: i64,
        reason: &str,
    ) -> Result<CreditReceipt, WalletError> {
        if amount == 0
            || amount.checked_abs().is_none()
            || reason.trim().is_empty()
            || reason.chars().count() > 500
        {
            return Err(WalletError::Validation);
        }
        let mut tx = self.pool.begin().await?;
        let scope = format!("admin:{actor}");
        let fingerprint = json!({"owner":owner,"amount":amount,"reason":reason});
        if let Some(result) = repo::receipt(&mut tx, &scope, request, &fingerprint).await? {
            return serde_json::from_value(result).map_err(|_| WalletError::Store);
        }
        repo::lock_key(&mut tx, &format!("admin:{request}")).await?;
        let receipt = write(
            &mut tx,
            &format!("admin:{request}"),
            repo::Journal {
                id: 0,
                owner,
                kind: "ADMIN_ADJUST".into(),
                balance: amount,
                held: 0,
                ref_type: None,
                reference: None,
                reason: Some(reason.into()),
                actor: Some(actor),
            },
        )
        .await?;
        repo::audit(
            &mut tx,
            actor,
            "WALLET_ADJUST",
            &owner.to_string(),
            json!({"amount":amount,"reason":reason,"request_id":request}),
        )
        .await?;
        repo::save_receipt(&mut tx, &scope, request, fingerprint, json!(receipt)).await?;
        tx.commit().await?;
        Ok(receipt)
    }
    pub async fn redeem(
        &self,
        owner: Uuid,
        request: Uuid,
        code: &str,
    ) -> Result<CreditReceipt, WalletError> {
        if code.is_empty() || code.len() > 128 {
            return Err(WalletError::Validation);
        }
        let hash = Sha256::digest(code.as_bytes());
        let mut tx = self.pool.begin().await?;
        let scope = format!("redeem:{owner}");
        let fingerprint = json!({"code_hash":URL_SAFE_NO_PAD.encode(hash)});
        if let Some(result) = repo::receipt(&mut tx, &scope, request, &fingerprint).await? {
            return serde_json::from_value(result).map_err(|_| WalletError::Store);
        }
        // Lock ordering: request -> code -> wallet. All redeem paths use this order.
        let (id, amount) = repo::code(&mut tx, &hash).await?;
        let key = format!("redeem:{id}:{owner}");
        if repo::existing(&mut tx, &key).await?.is_some() {
            return Err(WalletError::InvalidCode);
        }
        let result = write(
            &mut tx,
            &key,
            repo::Journal {
                id: 0,
                owner,
                kind: "REDEEM".into(),
                balance: amount,
                held: 0,
                ref_type: Some("redeem".into()),
                reference: Some(id.to_string()),
                reason: None,
                actor: None,
            },
        )
        .await?;
        repo::consume_code(&mut tx, id).await?;
        repo::save_receipt(&mut tx, &scope, request, fingerprint, json!(result)).await?;
        tx.commit().await?;
        Ok(result)
    }
    pub async fn create_codes(
        &self,
        actor: Uuid,
        params: &CreateCodesRequest,
    ) -> Result<CreatedCodes, WalletError> {
        if !(1..=100).contains(&params.count)
            || !(1..=10000).contains(&params.max_uses)
            || params.credits <= 0
            || params.expires_at.is_some_and(|v| v <= chrono::Utc::now())
        {
            return Err(WalletError::Validation);
        }
        let mut tx = self.pool.begin().await?;
        let mut codes = Vec::new();
        for _ in 0..params.count {
            let mut bytes = [0u8; 32];
            getrandom::fill(&mut bytes).map_err(|_| WalletError::Store)?;
            let code = URL_SAFE_NO_PAD.encode(bytes);
            let id = repo::insert_code(
                &mut tx,
                actor,
                &Sha256::digest(code.as_bytes()),
                params.credits,
                params.max_uses,
                params.expires_at,
            )
            .await?;
            codes.push(CreatedCode { id, code });
        }
        repo::audit(&mut tx,actor,"REDEEM_CODES_CREATED","batch",json!({"count":params.count,"credits":params.credits,"max_uses":params.max_uses,"expires_at":params.expires_at})).await?;
        tx.commit().await?;
        Ok(CreatedCodes { codes })
    }
    pub async fn codes(&self, cursor: Option<Uuid>) -> Result<Vec<CodeInfo>, WalletError> {
        repo::codes(&mut *self.pool.acquire().await?, cursor).await
    }
    pub async fn reconcile(&self) -> Result<Vec<Uuid>, WalletError> {
        repo::reconcile(&mut *self.pool.acquire().await?).await
    }
    pub async fn reconciliation_loop(self) {
        let mut timer = tokio::time::interval(std::time::Duration::from_secs(86400));
        loop {
            timer.tick().await;
            match self.reconcile().await {
                Ok(ids) if ids.is_empty() => tracing::info!("Wallet reconciliation passed"),
                Ok(ids) => tracing::error!(users=?ids,"WALLET_RECONCILIATION_MISMATCH"),
                Err(_) => tracing::error!("WALLET_RECONCILIATION_UNAVAILABLE"),
            }
        }
    }
}
fn positive(amount: i64) -> Result<(), WalletError> {
    if amount > 0 {
        Ok(())
    } else {
        Err(WalletError::Validation)
    }
}
pub(crate) async fn write(
    db: &mut PgConnection,
    key: &str,
    mut entry: repo::Journal,
) -> Result<CreditReceipt, WalletError> {
    let (balance, held) = repo::wallet(db, entry.owner).await?;
    if let Some(previous) = repo::existing(db, key).await? {
        entry.id = previous.id;
        if entry != previous {
            return Err(WalletError::Conflict);
        }
        return Ok(CreditReceipt {
            ledger_id: previous.id,
            credits: previous.balance,
        });
    }
    if entry.held < 0 {
        let job = entry.reference.as_deref().ok_or(WalletError::Validation)?;
        if repo::outstanding(db, entry.owner, job).await? < -entry.held {
            return Err(WalletError::Insufficient);
        }
    }
    let next_balance = balance
        .checked_add(entry.balance)
        .ok_or(WalletError::Validation)?;
    let next_held = held
        .checked_add(entry.held)
        .ok_or(WalletError::Validation)?;
    if next_balance < 0 || next_held < 0 || next_held > next_balance {
        return Err(WalletError::Insufficient);
    }
    let id = repo::append(db, key, &entry).await?;
    repo::allocate(db, &entry, id).await?;
    repo::update(db, entry.owner, next_balance, next_held).await?;
    Ok(CreditReceipt {
        ledger_id: id,
        credits: entry.balance,
    })
}
