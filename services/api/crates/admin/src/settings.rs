use crate::*;
const KEYS: [&str; 17] = [
    "registration_mode",
    "registration_whitelist",
    "signup_max_per_ip_24h",
    "signup_bonus",
    "checkin_base",
    "checkin_streak_cap",
    "checkin_tz",
    "free_max_resolution",
    "max_active_jobs_free",
    "asset_retention_days_free",
    "chat_credits_per_message",
    "chat_context_window",
    "chat_output_tokens",
    "maintenance_mode",
    "admin_adjust_limit",
    "moderation_threshold",
    "upstream_cost_rates",
];
pub(crate) async fn values(db: &mut PgConnection) -> Result<AdminSettingsValues, AdminError> {
    let value: Value = sqlx::query_scalar(
        "SELECT jsonb_object_agg(key,value) FROM system_settings WHERE key=ANY($1)",
    )
    .bind(&KEYS[..])
    .fetch_one(db)
    .await?;
    serde_json::from_value(value).map_err(|_| AdminError::Store)
}
impl AdminService {
    pub async fn settings(&self) -> Result<AdminSettings, AdminError> {
        let mut tx = self.db.begin().await?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            .execute(&mut *tx)
            .await?;
        let revision: Value = sqlx::query_scalar(
            "SELECT value FROM system_settings WHERE key='admin_settings_revision'",
        )
        .fetch_one(&mut *tx)
        .await?;
        let values = values(&mut tx).await?;
        let models =
            sqlx::query_as("SELECT id,display_name,kind FROM models ORDER BY sort_order,id")
                .fetch_all(&mut *tx)
                .await?;
        tx.commit().await?;
        Ok(AdminSettings {
            revision: revision.as_i64().ok_or(AdminError::Store)?,
            values,
            models,
        })
    }
    pub async fn save_settings(
        &self,
        who: Uuid,
        input: &AdminSettingsUpdate,
    ) -> Result<AdminSettings, AdminError> {
        reason(&input.reason)?;
        let v = &input.values;
        if !matches!(
            v.registration_mode.as_str(),
            "CLOSED" | "OPEN" | "INVITE_ONLY"
        ) || v.registration_whitelist.len() > 200
            || !(0..=1000000).contains(&v.signup_bonus)
            || !(0..=1000000).contains(&v.checkin_base)
            || !(0..=1000).contains(&v.checkin_streak_cap)
            || !(1..=100).contains(&v.signup_max_per_ip_24h)
            || !matches!(v.free_max_resolution.as_str(), "1K" | "2K")
            || !(1..=64).contains(&v.max_active_jobs_free)
            || !(1..=3650).contains(&v.asset_retention_days_free)
            || !(0..=10000).contains(&v.chat_credits_per_message)
            || !(2048..=131072).contains(&v.chat_context_window)
            || !(128..=8192).contains(&v.chat_output_tokens)
            || v.chat_context_window <= v.chat_output_tokens * 2
            || !(1..=1000000).contains(&v.admin_adjust_limit)
            || !(1..=100).contains(&v.moderation_threshold)
            || v.checkin_tz.len() > 100
            || v.upstream_cost_rates.len() > 200
        {
            return Err(AdminError::Validation);
        }
        let mut unique = std::collections::HashSet::new();
        for email in &v.registration_whitelist {
            let normalized =
                atelier_auth::policy::canonical_email(email).map_err(|_| AdminError::Validation)?;
            if !unique.insert(normalized) {
                return Err(AdminError::Validation);
            }
        }
        let mut tx = self.db.begin().await?;
        identity_lock(&mut tx).await?;
        actor(&mut tx, who, true).await?;
        sqlx::query("SELECT pg_advisory_xact_lock(1096043828)")
            .execute(&mut *tx)
            .await?;
        let revision: Value = sqlx::query_scalar(
            "SELECT value FROM system_settings WHERE key='admin_settings_revision' FOR UPDATE",
        )
        .fetch_one(&mut *tx)
        .await?;
        if revision.as_i64() != Some(input.revision) {
            return Err(AdminError::Conflict);
        }
        let timezone: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=$1)")
                .bind(&v.checkin_tz)
                .fetch_one(&mut *tx)
                .await?;
        if !timezone {
            return Err(AdminError::Validation);
        }
        unique.clear();
        for r in &v.upstream_cost_rates {
            if !matches!(r.currency.as_str(), "CNY" | "USD")
                || !(0..=1000000000000).contains(&r.unit_cost_micros)
                || !unique.insert(r.model_id.clone())
            {
                return Err(AdminError::Validation);
            }
            let exists: bool =
                sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM models WHERE id=$1)")
                    .bind(&r.model_id)
                    .fetch_one(&mut *tx)
                    .await?;
            if !exists {
                return Err(AdminError::Validation);
            }
        }
        let old = values(&mut tx).await?;
        let mut updated = v.clone();
        updated.registration_whitelist = v
            .registration_whitelist
            .iter()
            .map(|e| atelier_auth::policy::canonical_email(e).map_err(|_| AdminError::Validation))
            .collect::<Result<_, _>>()?;
        let map = serde_json::to_value(&updated).map_err(|_| AdminError::Store)?;
        for (key, value) in map.as_object().ok_or(AdminError::Store)? {
            sqlx::query("UPDATE system_settings SET value=$2,updated_by=$3,updated_at=clock_timestamp() WHERE key=$1").bind(key).bind(value).bind(who).execute(&mut *tx).await?;
        }
        sqlx::query("UPDATE system_settings SET value=to_jsonb($1::bigint),updated_by=$2,updated_at=clock_timestamp() WHERE key='admin_settings_revision'").bind(input.revision+1).bind(who).execute(&mut *tx).await?;
        audit(
            &mut tx,
            who,
            "ADMIN_SETTINGS_UPDATED",
            "settings",
            "global",
            json!(old),
            json!(updated),
            &input.reason,
        )
        .await?;
        tx.commit().await?;
        self.settings().await
    }
}
