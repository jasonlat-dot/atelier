use crate::*;
use chrono::{DateTime, Utc};
use sqlx::Row;
const JOB_SELECT:&str="SELECT j.id,j.owner_id,u.email,j.model_id,m.display_name,j.kind,j.status,j.cost,j.settled,j.released,COALESCE(r.credits,0)::bigint AS refunded,j.progress,j.attempts,j.cancel_requested,j.error_code,j.created_at,j.finished_at FROM generation_jobs j JOIN users u ON u.id=j.owner_id JOIN models m ON m.id=j.model_id LEFT JOIN admin_job_refunds r ON r.job_id=j.id";
pub(crate) async fn job(
    db: &mut PgConnection,
    id: Uuid,
    lock: bool,
) -> Result<AdminJob, AdminError> {
    let mut query = sqlx::QueryBuilder::<sqlx::Postgres>::new(JOB_SELECT);
    query.push(" WHERE j.id=$1");
    if lock {
        query.push(" FOR UPDATE OF j");
    }
    query
        .build_query_as::<AdminJob>()
        .bind(id)
        .fetch_optional(db)
        .await?
        .ok_or(AdminError::NotFound)
}
fn redact(v: &mut Value, depth: usize) {
    if depth > 8 {
        *v = json!("[内容已省略]");
        return;
    }
    match v {
        Value::Object(map) => {
            map.retain(|key, _| {
                let k = key.to_ascii_lowercase();
                !k.contains("secret")
                    && !k.contains("token")
                    && !k.contains("hash")
                    && !matches!(
                        k.as_str(),
                        "api_key"
                            | "base_url"
                            | "upstream_model"
                            | "authorization"
                            | "cookie"
                            | "session"
                            | "code"
                            | "codes"
                            | "prompt"
                            | "content"
                            | "reply"
                            | "summary"
                            | "retained_facts"
                    )
            });
            for value in map.values_mut() {
                redact(value, depth + 1);
            }
        }
        Value::Array(values) => {
            values.truncate(100);
            for value in values {
                redact(value, depth + 1);
            }
        }
        _ => {}
    }
}
async fn since(db: &mut PgConnection, days: i32) -> Result<DateTime<Utc>, AdminError> {
    if !(1..=90).contains(&days) {
        return Err(AdminError::Validation);
    }
    Ok(sqlx::query_scalar("SELECT ((clock_timestamp() AT TIME ZONE 'UTC')::date-($1::int-1))::timestamp AT TIME ZONE 'UTC'").bind(days).fetch_one(db).await?)
}
async fn charts(
    db: &mut PgConnection,
    from: DateTime<Utc>,
    owner: Option<Uuid>,
) -> Result<(Vec<AdminDay>, Vec<AdminQuality>), AdminError> {
    let daily=sqlx::query_as("WITH d AS (SELECT generate_series(($1::timestamptz AT TIME ZONE 'UTC')::date,(clock_timestamp() AT TIME ZONE 'UTC')::date,interval '1 day')::date AS day), j AS (SELECT (created_at AT TIME ZONE 'UTC')::date AS day,count(*) AS jobs,count(*) FILTER(WHERE status IN ('SUCCEEDED','PARTIAL')) AS succeeded,count(*) FILTER(WHERE status='FAILED') AS failed FROM generation_jobs WHERE created_at>=$1 AND ($2::uuid IS NULL OR owner_id=$2) GROUP BY 1),l AS (SELECT (created_at AT TIME ZONE 'UTC')::date AS day,(-sum(balance_delta))::bigint AS consumed FROM credit_ledger WHERE type='SETTLE' AND created_at>=$1 AND ($2::uuid IS NULL OR user_id=$2) GROUP BY 1) SELECT to_char(d.day,'YYYY-MM-DD') AS day,coalesce(j.jobs,0)::bigint AS jobs,coalesce(j.succeeded,0)::bigint AS succeeded,coalesce(j.failed,0)::bigint AS failed,coalesce(l.consumed,0)::bigint AS consumed FROM d LEFT JOIN j USING(day) LEFT JOIN l USING(day) ORDER BY d.day")
        .bind(from).bind(owner).fetch_all(&mut *db).await?;
    let qualities=sqlx::query_as("SELECT coalesce(params->>'quality','未分类') AS quality,count(*) AS jobs FROM generation_jobs WHERE created_at>=$1 AND ($2::uuid IS NULL OR owner_id=$2) GROUP BY 1 ORDER BY jobs DESC,quality").bind(from).bind(owner).fetch_all(db).await?;
    Ok((daily, qualities))
}
impl AdminService {
    pub async fn jobs(
        &self,
        q: &str,
        status: Option<&str>,
        owner: Option<Uuid>,
        before: Option<Uuid>,
    ) -> Result<AdminJobPage, AdminError> {
        search(q)?;
        if status.is_some_and(|s| {
            !matches!(
                s,
                "QUEUED"
                    | "ROUTING"
                    | "RUNNING"
                    | "STORING"
                    | "SUCCEEDED"
                    | "PARTIAL"
                    | "FAILED"
                    | "CANCELLED"
            )
        }) {
            return Err(AdminError::Validation);
        }
        let mut query = sqlx::QueryBuilder::<sqlx::Postgres>::new(JOB_SELECT);
        query.push(" ");
        query.push("WHERE strpos(lower(j.id::text||' '||u.email||' '||m.display_name),lower($1))>0 AND ($2::text IS NULL OR j.status=$2) AND ($3::uuid IS NULL OR j.owner_id=$3) AND ($4::uuid IS NULL OR (j.created_at,j.id)<(SELECT created_at,id FROM generation_jobs WHERE id=$4)) ORDER BY j.created_at DESC,j.id DESC LIMIT 26");
        let mut items: Vec<AdminJob> = query
            .build_query_as()
            .bind(q)
            .bind(status)
            .bind(owner)
            .bind(before)
            .fetch_all(&self.db)
            .await?;
        let more = items.len() > 25;
        items.truncate(25);
        let next_cursor = if more {
            items.last().map(|j| j.id)
        } else {
            None
        };
        Ok(AdminJobPage { items, next_cursor })
    }
    pub async fn audit_logs(
        &self,
        q: &str,
        before: Option<i64>,
    ) -> Result<AdminAuditPage, AdminError> {
        search(q)?;
        if before.is_some_and(|v| v <= 0) {
            return Err(AdminError::Validation);
        }
        let mut items:Vec<AdminAudit>=sqlx::query_as("SELECT a.id,a.actor_id,u.email,a.action,a.target_type,a.target_id,coalesce(a.before,'null'::jsonb) AS before,coalesce(a.after,'null'::jsonb) AS after,a.created_at FROM audit_logs a JOIN users u ON u.id=a.actor_id WHERE strpos(lower(a.action||' '||coalesce(a.target_id,'')||' '||u.email),lower($1))>0 AND ($2::bigint IS NULL OR a.id<$2) ORDER BY a.id DESC LIMIT 26").bind(q).bind(before).fetch_all(&self.db).await?;
        let more = items.len() > 25;
        items.truncate(25);
        let next_cursor = if more {
            items.last().map(|a| a.id)
        } else {
            None
        };
        for row in &mut items {
            for v in [&mut row.before, &mut row.after] {
                if serde_json::to_vec(v).map_err(|_| AdminError::Store)?.len() > 65536 {
                    *v = json!({"note":"记录较长，仅展示元数据"});
                } else {
                    redact(v, 0);
                }
            }
        }
        Ok(AdminAuditPage { items, next_cursor })
    }
    pub async fn usage(&self, owner: Uuid, days: i32) -> Result<UsageView, AdminError> {
        let mut tx = self.db.begin().await?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            .execute(&mut *tx)
            .await?;
        let from = since(&mut tx, days).await?;
        let (daily, qualities) = charts(&mut tx, from, Some(owner)).await?;
        let previous = sqlx::query_as("SELECT (SELECT count(*) FROM generation_jobs WHERE owner_id=$1 AND created_at >= $2 AND created_at < $3) AS jobs, (SELECT coalesce(-sum(balance_delta),0)::bigint FROM credit_ledger WHERE user_id=$1 AND type='SETTLE' AND created_at >= $2 AND created_at < $3) AS consumed")
            .bind(owner).bind(from - chrono::Duration::days(i64::from(days))).bind(from).fetch_one(&mut *tx).await?;
        // Returned reservations belong to tasks created in this period, including
        // tasks hidden from history. They are not additional income or refunds.
        let released_credits = sqlx::query_scalar("SELECT coalesce(sum(released),0)::bigint FROM generation_jobs WHERE owner_id=$1 AND created_at >= $2")
            .bind(owner).bind(from).fetch_one(&mut *tx).await?;
        let kinds = sqlx::query_as("SELECT kind,count(*) AS jobs FROM generation_jobs WHERE owner_id=$1 AND created_at >= $2 GROUP BY kind ORDER BY kind")
            .bind(owner).bind(from).fetch_all(&mut *tx).await?;
        let recent = sqlx::query_as("SELECT j.id,j.created_at,j.prompt,j.model_id,m.display_name,coalesce(j.params->>'quality','未分类') AS quality,j.status,j.settled FROM generation_jobs j JOIN models m ON m.id=j.model_id WHERE j.owner_id=$1 AND j.created_at >= $2 AND NOT EXISTS (SELECT 1 FROM generation_history_deleted h WHERE h.job_id=j.id) ORDER BY j.created_at DESC,j.id DESC LIMIT 10")
            .bind(owner).bind(from).fetch_all(&mut *tx).await?;
        tx.commit().await?;
        Ok(UsageView {
            days,
            daily,
            qualities,
            previous,
            released_credits,
            kinds,
            recent,
        })
    }
    pub async fn dashboard(&self, days: i32) -> Result<AdminDashboard, AdminError> {
        let mut tx = self.db.begin().await?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            .execute(&mut *tx)
            .await?;
        let from = since(&mut tx, days).await?;
        let u=sqlx::query("SELECT count(*) AS total,count(*) FILTER(WHERE created_at>=$1) AS new_users,(SELECT count(DISTINCT user_id) FROM sessions WHERE last_seen_at>=((clock_timestamp() AT TIME ZONE 'UTC')::date)::timestamp AT TIME ZONE 'UTC') AS active_today FROM users").bind(from).fetch_one(&mut *tx).await?;
        let j=sqlx::query("SELECT count(*) FILTER(WHERE created_at>=$1) AS total,count(*) FILTER(WHERE created_at>=$1 AND status IN ('SUCCEEDED','PARTIAL')) AS succeeded,count(*) FILTER(WHERE created_at>=$1 AND status='FAILED') AS failed,count(*) FILTER(WHERE finished_at IS NULL) AS active FROM generation_jobs").bind(from).fetch_one(&mut *tx).await?;
        let l=sqlx::query("SELECT coalesce(sum(balance_delta) FILTER(WHERE balance_delta>0 AND type<>'REFUND'),0)::bigint AS issued,coalesce(-sum(balance_delta) FILTER(WHERE type='SETTLE'),0)::bigint AS consumed,coalesce(sum(balance_delta) FILTER(WHERE type='REFUND'),0)::bigint AS compensated FROM credit_ledger WHERE created_at>=$1").bind(from).fetch_one(&mut *tx).await?;
        let pending_orders =
            sqlx::query_scalar("SELECT count(*) FROM orders WHERE status='PENDING'")
                .fetch_one(&mut *tx)
                .await?;
        let order_amounts=sqlx::query_as("SELECT currency,sum(amount_cents-refund_cents)::bigint AS amount_cents FROM orders WHERE paid_at>=$1 AND status IN ('FULFILLED','REFUNDED') GROUP BY currency ORDER BY currency").bind(from).fetch_all(&mut *tx).await?;
        let (daily, qualities) = charts(&mut tx, from, None).await?;
        let health=sqlx::query_as("SELECT a.status,count(*) AS accounts,sum(a.concurrency_limit)::bigint AS capacity,sum((SELECT count(*) FROM upstream_leases l WHERE l.account_id=a.id AND NOT l.completed AND l.expires_at>clock_timestamp()))::bigint AS live_slots,sum(a.quota_remaining)::bigint AS quota_remaining FROM upstream_accounts a WHERE a.deleted_at IS NULL GROUP BY a.status ORDER BY a.status").fetch_all(&mut *tx).await?;
        let pending_reviews = sqlx::query_scalar(
            "SELECT count(*) FROM admin_notifications WHERE reviewed_at IS NULL",
        )
        .fetch_one(&mut *tx)
        .await?;
        let notifications=sqlx::query_as("SELECT n.id,n.user_id,u.email,n.kind,n.violation_count,n.created_at FROM admin_notifications n JOIN users u ON u.id=n.user_id WHERE n.reviewed_at IS NULL ORDER BY n.id DESC LIMIT 20").fetch_all(&mut *tx).await?;
        let costs: Value =
            sqlx::query_scalar("SELECT value FROM system_settings WHERE key='upstream_cost_rates'")
                .fetch_one(&mut *tx)
                .await?;
        let rates: Vec<AdminCostRate> =
            serde_json::from_value(costs).map_err(|_| AdminError::Store)?;
        let units:Vec<(String,i64)>=sqlx::query_as("SELECT model_id,sum(units)::bigint FROM (SELECT model_id,sum((settled/cost_per_output)*CASE WHEN kind='video' THEN (params->>'seconds')::bigint ELSE 1 END)::bigint AS units FROM generation_jobs WHERE finished_at>=$1 AND settled>0 GROUP BY model_id UNION ALL SELECT model_id,count(*) AS units FROM chat_turns WHERE finished_at>=$1 AND status='SUCCEEDED' GROUP BY model_id) t GROUP BY model_id").bind(from).fetch_all(&mut *tx).await?;
        let mut estimated = std::collections::BTreeMap::<String, i64>::new();
        let mut unpriced_units = 0i64;
        for (model, units) in units {
            if let Some(rate) = rates.iter().find(|r| r.model_id == model) {
                let amount = units
                    .checked_mul(rate.unit_cost_micros)
                    .ok_or(AdminError::Store)?;
                let total = estimated.entry(rate.currency.clone()).or_default();
                *total = total.checked_add(amount).ok_or(AdminError::Store)?;
            } else {
                unpriced_units = unpriced_units.checked_add(units).ok_or(AdminError::Store)?;
            }
        }
        let view = AdminDashboard {
            days,
            users_total: u.get("total"),
            active_users_today: u.get("active_today"),
            new_users: u.get("new_users"),
            jobs_total: j.get("total"),
            succeeded_jobs: j.get("succeeded"),
            failed_jobs: j.get("failed"),
            active_jobs: j.get("active"),
            issued_credits: l.get("issued"),
            consumed_credits: l.get("consumed"),
            compensated_credits: l.get("compensated"),
            pending_orders,
            order_amounts,
            daily,
            qualities,
            health,
            notifications,
            pending_reviews,
            estimated_costs: estimated
                .into_iter()
                .map(|(currency, amount_micros)| AdminEstimate {
                    currency,
                    amount_micros,
                })
                .collect(),
            unpriced_units,
        };
        tx.commit().await?;
        Ok(view)
    }
}
