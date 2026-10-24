use crate::*;
use sqlx::Row;
pub(crate) const USER_SELECT:&str="SELECT u.id,u.email,u.display_name,u.role,u.status,u.disabled_reason,u.revision,u.mfa_enabled,u.created_at,u.last_login_at,COALESCE(w.balance,0)::bigint AS balance,COALESCE(w.held,0)::bigint AS held,(SELECT count(*) FROM moderation_violations v WHERE v.user_id=u.id AND v.created_at>clock_timestamp()-interval '30 days') AS violations FROM users u LEFT JOIN wallets w ON w.user_id=u.id";
pub(crate) async fn user(
    db: &mut PgConnection,
    id: Uuid,
    lock: bool,
) -> Result<AdminUser, AdminError> {
    let mut query = sqlx::QueryBuilder::<sqlx::Postgres>::new(USER_SELECT);
    query.push(" WHERE u.id=$1");
    if lock {
        query.push(" FOR UPDATE OF u");
    }
    query
        .build_query_as::<AdminUser>()
        .bind(id)
        .fetch_optional(db)
        .await?
        .ok_or(AdminError::NotFound)
}
fn permission(super_admin: bool, target: &AdminUser) -> Result<(), AdminError> {
    if !super_admin && target.role != "USER" {
        Err(AdminError::Forbidden)
    } else {
        Ok(())
    }
}
impl AdminService {
    pub async fn user_ledger(
        &self,
        id: Uuid,
        before: Option<i64>,
    ) -> Result<atelier_wallet::LedgerPage, AdminError> {
        user(&mut *self.db.acquire().await?, id, false).await?;
        Ok(atelier_wallet::WalletService::new(self.db.clone())
            .ledger(id, before, 25)
            .await?)
    }
    pub async fn users(
        &self,
        q: &str,
        status: Option<&str>,
        role: Option<&str>,
        before: Option<Uuid>,
    ) -> Result<AdminUserPage, AdminError> {
        search(q)?;
        if status.is_some_and(|s| !matches!(s, "ACTIVE" | "DISABLED"))
            || role.is_some_and(|s| !matches!(s, "USER" | "ADMIN" | "SUPER_ADMIN"))
        {
            return Err(AdminError::Validation);
        }
        let mut query = sqlx::QueryBuilder::<sqlx::Postgres>::new(USER_SELECT);
        query.push(" ");
        query.push("WHERE strpos(lower(u.email||' '||u.display_name||' '||u.id::text),lower($1))>0 AND ($2::text IS NULL OR u.status=$2) AND ($3::text IS NULL OR u.role=$3) AND ($4::uuid IS NULL OR (u.created_at,u.id)<(SELECT created_at,id FROM users WHERE id=$4)) ORDER BY u.created_at DESC,u.id DESC LIMIT 26");
        let mut items: Vec<AdminUser> = query
            .build_query_as()
            .bind(q)
            .bind(status)
            .bind(role)
            .bind(before)
            .fetch_all(&self.db)
            .await?;
        let more = items.len() > 25;
        items.truncate(25);
        let next_cursor = if more {
            items.last().map(|v| v.id)
        } else {
            None
        };
        Ok(AdminUserPage { items, next_cursor })
    }
    pub async fn user_detail(&self, id: Uuid) -> Result<AdminUserDetail, AdminError> {
        let limit: Value =
            sqlx::query_scalar("SELECT value FROM system_settings WHERE key='admin_adjust_limit'")
                .fetch_one(&self.db)
                .await?;
        let adjust_limit = limit
            .as_i64()
            .filter(|n| (1..=1000000).contains(n))
            .ok_or(AdminError::Store)?;
        let u = user(&mut *self.db.acquire().await?, id, false).await?;
        let ledger = atelier_wallet::WalletService::new(self.db.clone())
            .ledger(id, None, 25)
            .await?;
        let jobs = self
            .jobs("", None, Some(id), None)
            .await?
            .items
            .into_iter()
            .take(10)
            .collect();
        let sessions=sqlx::query_as("SELECT id,created_at,last_seen_at,host(ip) AS ip,user_agent FROM sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>clock_timestamp() AND last_seen_at>clock_timestamp()-interval '7 days' ORDER BY last_seen_at DESC LIMIT 20").bind(id).fetch_all(&self.db).await?;
        Ok(AdminUserDetail {
            adjust_limit,
            pending_review: sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM admin_notifications WHERE user_id=$1 AND reviewed_at IS NULL)")
                .bind(id).fetch_one(&self.db).await?,
            user: u,
            ledger,
            jobs,
            sessions,
        })
    }
    pub async fn user_action(
        &self,
        who: Uuid,
        id: Uuid,
        action: &str,
        input: &AdminUserAction,
    ) -> Result<AdminUser, AdminError> {
        reason(&input.reason)?;
        if !matches!(
            action,
            "disable" | "enable" | "role" | "revoke-sessions" | "review"
        ) || input.revision < 1
            || (action != "role" && input.role.is_some())
        {
            return Err(AdminError::Validation);
        }
        let mut tx = self.db.begin().await?;
        identity_lock(&mut tx).await?;
        let super_admin = actor(&mut tx, who, action == "role").await?;
        let old = user(&mut tx, id, true).await?;
        permission(super_admin, &old)?;
        if old.revision != input.revision {
            return Err(AdminError::Conflict);
        }
        if action == "disable" && who == id {
            return Err(AdminError::Forbidden);
        }
        let loses_super = action == "disable"
            || (action == "role" && input.role.as_deref() != Some("SUPER_ADMIN"));
        if old.role == "SUPER_ADMIN" && old.status == "ACTIVE" && loses_super {
            let count: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM users WHERE role='SUPER_ADMIN' AND status='ACTIVE'",
            )
            .fetch_one(&mut *tx)
            .await?;
            if count <= 1 {
                return Err(AdminError::LastAdmin);
            }
        }
        let mut cancelled_generation = 0;
        let mut cancelled_chat = 0;
        let sessions_before: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM sessions WHERE user_id=$1 AND revoked_at IS NULL",
        )
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
        match action {
            "disable" => {
                sqlx::query("UPDATE users SET status='DISABLED',disabled_reason=$2 WHERE id=$1")
                    .bind(id)
                    .bind(input.reason.trim())
                    .execute(&mut *tx)
                    .await?;
                cancelled_generation =
                    atelier_generation::GenerationService::cancel_owner_in_transaction(&mut tx, id)
                        .await
                        .map_err(|_| AdminError::Store)?;
                cancelled_chat =
                    atelier_chat::ChatService::cancel_owner_in_transaction(&mut tx, id)
                        .await
                        .map_err(|_| AdminError::Store)?;
            }
            "enable" => {
                sqlx::query("UPDATE users SET status='ACTIVE',disabled_reason=NULL WHERE id=$1")
                    .bind(id)
                    .execute(&mut *tx)
                    .await?;
            }
            "role" => {
                let role = input
                    .role
                    .as_deref()
                    .filter(|s| matches!(*s, "USER" | "ADMIN" | "SUPER_ADMIN"))
                    .ok_or(AdminError::Validation)?;
                sqlx::query("UPDATE users SET role=$2 WHERE id=$1")
                    .bind(id)
                    .bind(role)
                    .execute(&mut *tx)
                    .await?;
            }
            "revoke-sessions" => {
                atelier_auth::postgres::PostgresSessions::revoke_owner_in_transaction(&mut tx, id)
                    .await?;
            }
            "review" => {}
            _ => return Err(AdminError::Validation),
        }
        if matches!(action, "enable" | "review") {
            sqlx::query("UPDATE admin_notifications SET reviewed_at=clock_timestamp(),reviewed_by=$2 WHERE user_id=$1 AND reviewed_at IS NULL").bind(id).bind(who).execute(&mut *tx).await?;
        }
        let view = user(&mut tx, id, false).await?;
        let sessions_after: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM sessions WHERE user_id=$1 AND revoked_at IS NULL",
        )
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
        let mut before = json!(old);
        before["unrevoked_sessions"] = json!(sessions_before);
        audit(&mut tx,who,&format!("ADMIN_USER_{}",action.replace('-',"_").to_uppercase()),"users",&id.to_string(),before,json!({"user":view,"unrevoked_sessions":sessions_after,"cancelled_generation":cancelled_generation,"cancelled_chat":cancelled_chat}),&input.reason).await?;
        tx.commit().await?;
        Ok(view)
    }
    pub async fn adjust_credits(
        &self,
        who: Uuid,
        id: Uuid,
        key: Uuid,
        amount: i64,
        why: &str,
    ) -> Result<atelier_wallet::CreditReceipt, AdminError> {
        let mut tx = self.db.begin().await?;
        identity_lock(&mut tx).await?;
        let is_super = actor(&mut tx, who, false).await?;
        let target = user(&mut tx, id, true).await?;
        permission(is_super, &target)?;
        let result = atelier_wallet::WalletService::adjust_in_transaction(
            &mut tx, who, id, key, amount, why,
        )
        .await?;
        tx.commit().await?;
        Ok(result)
    }
    pub async fn job_action(
        &self,
        who: Uuid,
        id: Uuid,
        key: Uuid,
        action: &str,
        input: &AdminJobAction,
    ) -> Result<AdminJob, AdminError> {
        reason(&input.reason)?;
        if key.is_nil()
            || !matches!(action, "cancel" | "refund")
            || (action == "cancel" && input.expected_credits.is_some())
        {
            return Err(AdminError::Validation);
        }
        let mut tx = self.db.begin().await?;
        identity_lock(&mut tx).await?;
        let is_super = actor(&mut tx, who, false).await?;
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
            .bind(format!("admin-request:{key}"))
            .execute(&mut *tx)
            .await?;
        let owner: Uuid = sqlx::query_scalar("SELECT owner_id FROM generation_jobs WHERE id=$1")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(AdminError::NotFound)?;
        let target = user(&mut tx, owner, true).await?;
        permission(is_super, &target)?;
        let fp = json!({"actor":who,"id":id,"action":action,"reason":input.reason,"credits":input.expected_credits});
        if let Some(row) =
            sqlx::query("SELECT fingerprint,response FROM admin_requests WHERE request_id=$1")
                .bind(key)
                .fetch_optional(&mut *tx)
                .await?
        {
            if row.get::<Value, _>("fingerprint") != fp {
                return Err(AdminError::Conflict);
            }
            return serde_json::from_value(row.get("response")).map_err(|_| AdminError::Store);
        }
        let old = crate::read::job(&mut tx, id, true).await?;
        if action == "cancel" {
            if old.finished_at.is_some() && old.status != "CANCELLED" {
                return Err(AdminError::Conflict);
            }
            atelier_generation::GenerationService::cancel_in_transaction(&mut tx, owner, id)
                .await
                .map_err(|_| AdminError::Store)?;
        } else {
            if old.finished_at.is_none()
                || old.settled <= 0
                || input.expected_credits != Some(old.settled)
            {
                return Err(AdminError::Conflict);
            }
            if old.refunded == 0 {
                let receipt = atelier_wallet::WalletService::refund_job_in_transaction(
                    &mut tx,
                    owner,
                    id,
                    who,
                    old.settled,
                    &input.reason,
                )
                .await?;
                sqlx::query("INSERT INTO admin_job_refunds(job_id,request_id,actor_id,credits,reason,ledger_id) VALUES($1,$2,$3,$4,$5,$6)").bind(id).bind(key).bind(who).bind(old.settled).bind(&input.reason).bind(receipt.ledger_id).execute(&mut *tx).await?;
            }
        }
        let view = crate::read::job(&mut tx, id, false).await?;
        audit(
            &mut tx,
            who,
            if action == "cancel" {
                "ADMIN_JOB_CANCEL"
            } else {
                "ADMIN_JOB_REFUND"
            },
            "generation_job",
            &id.to_string(),
            json!(old),
            json!(view),
            &input.reason,
        )
        .await?;
        sqlx::query("INSERT INTO admin_requests(request_id,actor_id,fingerprint,response) VALUES($1,$2,$3,$4)").bind(key).bind(who).bind(fp).bind(json!(view)).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(view)
    }
}
