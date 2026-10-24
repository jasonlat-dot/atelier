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
    #[error("This legacy redeem code has no recoverable copy")]
    CodeNotRecoverable,
    #[error("Wallet service unavailable")]
    Store,
}
impl From<sqlx::Error> for WalletError {
    fn from(error: sqlx::Error) -> Self {
        // Log only the SQLSTATE, never SQL parameters, DSNs or database messages
        // that can contain redeem codes or other private values.
        let code = error.as_database_error().and_then(|db| db.code());
        tracing::error!(
            sqlstate = code.as_deref().unwrap_or("unknown"),
            "Wallet database operation failed"
        );
        Self::Store
    }
}
#[derive(Clone)]
pub struct WalletService {
    pool: PgPool,
    code_cipher: Option<RedeemCodeCipher>,
}
pub enum Operation<'a> {
    Grant { amount: i64, key: &'a str },
    Hold { job: Uuid, amount: i64 },
    Release { job: Uuid, amount: i64 },
    Settle { job: Uuid, index: u32, amount: i64 },
}
impl WalletService {
    pub fn new(pool: PgPool) -> Self {
        Self {
            pool,
            code_cipher: None,
        }
    }
    pub fn with_code_cipher(mut self, cipher: RedeemCodeCipher) -> Self {
        self.code_cipher = Some(cipher);
        self
    }
    /// Run after migrations using the owning deployment role. FK row locks work;
    /// financial-column updates, deletes and truncation remain denied, and the
    /// immutable trigger also rejects updates to the lock-privileged id column.
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
        let mut tx = self.pool.begin().await?;
        let result =
            Self::adjust_in_transaction(&mut tx, actor, owner, request, amount, reason).await?;
        tx.commit().await?;
        Ok(result)
    }
    pub async fn adjust_in_transaction(
        db: &mut PgConnection,
        actor: Uuid,
        owner: Uuid,
        request: Uuid,
        amount: i64,
        reason: &str,
    ) -> Result<CreditReceipt, WalletError> {
        if request.is_nil()
            || amount == 0
            || amount.checked_abs().is_none()
            || reason.trim().is_empty()
            || reason.chars().count() > 500
        {
            return Err(WalletError::Validation);
        }
        let scope = format!("admin:{actor}");
        let fingerprint = json!({"owner":owner,"amount":amount,"reason":reason});
        if let Some(result) = repo::receipt(db, &scope, request, &fingerprint).await? {
            return serde_json::from_value(result).map_err(|_| WalletError::Store);
        }
        let limit: Option<serde_json::Value> = sqlx::query_scalar(
            "SELECT value FROM system_settings WHERE key='admin_adjust_limit' FOR SHARE",
        )
        .fetch_optional(&mut *db)
        .await?;
        let limit = limit
            .unwrap_or(json!(100000))
            .as_i64()
            .filter(|v| (1..=1000000).contains(v))
            .ok_or(WalletError::Store)?;
        if amount.checked_abs().is_none_or(|v| v > limit) {
            return Err(WalletError::Validation);
        }
        repo::lock_key(db, &format!("admin:{request}")).await?;
        let (balance, held) = repo::wallet(db, owner).await?;
        let receipt = write(
            db,
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
        sqlx::query("INSERT INTO audit_logs(actor_id,action,target_type,target_id,before,after) VALUES($1,'WALLET_ADJUST','wallet',$2,$3,$4)").bind(actor).bind(owner.to_string()).bind(json!({"balance":balance,"held":held})).bind(json!({"balance":balance+amount,"held":held,"amount":amount,"reason":reason,"request_id":request})).execute(&mut *db).await?;
        repo::save_receipt(db, &scope, request, fingerprint, json!(receipt)).await?;
        Ok(receipt)
    }
    /// An administrator compensates an already settled job once, without rewriting its settlement.
    pub async fn refund_job_in_transaction(
        db: &mut PgConnection,
        owner: Uuid,
        job: Uuid,
        actor: Uuid,
        amount: i64,
        reason: &str,
    ) -> Result<CreditReceipt, WalletError> {
        if amount <= 0 || reason.trim().is_empty() || reason.chars().count() > 500 {
            return Err(WalletError::Validation);
        }
        let key = format!("job:{job}:admin-refund");
        repo::lock_key(db, &key).await?;
        let settled:i64=sqlx::query_scalar("SELECT COALESCE(-sum(balance_delta),0)::bigint FROM credit_ledger WHERE user_id=$1 AND ref_type='job' AND ref_id=$2 AND type='SETTLE'").bind(owner).bind(job.to_string()).fetch_one(&mut *db).await?;
        if amount != settled {
            return Err(WalletError::Validation);
        }
        write(
            db,
            &key,
            repo::Journal {
                id: 0,
                owner,
                kind: "REFUND".into(),
                balance: amount,
                held: 0,
                ref_type: Some("job_refund".into()),
                reference: Some(job.to_string()),
                reason: Some(reason.into()),
                actor: Some(actor),
            },
        )
        .await
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
        let cipher = self.code_cipher.as_ref().ok_or(WalletError::Store)?;
        let mut tx = self.pool.begin().await?;
        let mut codes = Vec::new();
        for _ in 0..params.count {
            let mut bytes = [0u8; 32];
            getrandom::fill(&mut bytes).map_err(|_| WalletError::Store)?;
            let code = URL_SAFE_NO_PAD.encode(bytes);
            let id = Uuid::new_v4();
            let encrypted = cipher.seal(id, &code)?;
            let id = repo::insert_code(
                &mut tx,
                id,
                actor,
                &Sha256::digest(code.as_bytes()),
                &encrypted,
                params,
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
    pub async fn reveal_code(&self, actor: Uuid, id: Uuid) -> Result<CreatedCode, WalletError> {
        let cipher = self.code_cipher.as_ref().ok_or(WalletError::Store)?;
        let mut tx = self.pool.begin().await?;
        let (encrypted, hash): (Option<Vec<u8>>, Vec<u8>) =
            sqlx::query_as("SELECT code_enc,code_hash FROM redeem_codes WHERE id=$1")
                .bind(id)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or(WalletError::NotFound)?;
        let encrypted = encrypted.ok_or(WalletError::CodeNotRecoverable)?;
        let code = cipher.open(id, &encrypted)?;
        if Sha256::digest(code.as_bytes()).as_slice() != hash {
            return Err(WalletError::Store);
        }
        repo::audit(
            &mut tx,
            actor,
            "REDEEM_CODE_REVEALED",
            &id.to_string(),
            json!({"code_id":id}),
        )
        .await?;
        tx.commit().await?;
        Ok(CreatedCode {
            id,
            code: code.to_string(),
        })
    }
    pub async fn adjustments(&self) -> Result<Vec<CreditAdjustment>, WalletError> {
        Ok(sqlx::query_as("SELECT a.id,a.target_id AS user_id,u.display_name,u.email,o.email AS operator,(a.after->>'amount')::bigint AS amount,a.after->>'reason' AS reason,a.created_at FROM audit_logs a JOIN users u ON u.id::text=a.target_id JOIN users o ON o.id=a.actor_id WHERE a.action='WALLET_ADJUST' AND a.target_type='wallet' ORDER BY a.id DESC LIMIT 5")
            .fetch_all(&self.pool).await?)
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
