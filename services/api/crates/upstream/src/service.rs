use crate::{
    crypto::SecretCipher, egress::SafeHttp, validation as validate, AccountInput, AccountPage,
    AccountStats, AccountView, BindingInput, Error, ErrorCount, ModelInput, ModelView, Pricing,
    QuotaInput,
};
use serde_json::{json, Value};
use sqlx::{PgPool, Postgres, Row, Transaction};
use std::sync::Arc;
use uuid::Uuid;

#[derive(Clone)]
pub struct UpstreamService {
    pub(crate) inner: Arc<Inner>,
}
pub(crate) struct Inner {
    pub db: PgPool,
    pub cipher: SecretCipher,
    pub http: SafeHttp,
}
impl UpstreamService {
    pub fn new(db: PgPool, cipher: SecretCipher, http: SafeHttp) -> Self {
        Self {
            inner: Arc::new(Inner { db, cipher, http }),
        }
    }
    async fn admin_tx(&self, actor: Uuid) -> Result<Transaction<'static, Postgres>, Error> {
        let mut tx = self.inner.db.begin().await?;
        let valid:Option<Uuid>=sqlx::query_scalar("SELECT id FROM users WHERE id=$1 AND role IN ('ADMIN','SUPER_ADMIN') AND status='ACTIVE' FOR SHARE").bind(actor).fetch_optional(&mut *tx).await?;
        if valid.is_none() {
            return Err(Error::NotFound);
        }
        sqlx::query("SELECT pg_advisory_xact_lock(1096043828)")
            .execute(&mut *tx)
            .await?;
        Ok(tx)
    }
    pub async fn accounts(&self, search: &str, before: Option<Uuid>) -> Result<AccountPage, Error> {
        if search.chars().count() > 100 {
            return Err(Error::Validation);
        }
        let rows=sqlx::query_as::<_,AccountView>("SELECT a.id,a.name,a.kind,a.secret_last4,true AS endpoint_configured,a.group_tag,a.priority,a.weight,a.concurrency_limit,a.quota_total,a.quota_remaining,a.quota_reset_at,a.status,a.cooldown_until,a.consecutive_failures,a.last_error,a.last_used_at,a.revision,a.created_at,(SELECT count(*) FROM upstream_leases l WHERE l.account_id=a.id AND l.completed=false AND l.expires_at>clock_timestamp()) AS in_flight FROM upstream_accounts a WHERE a.deleted_at IS NULL AND (strpos(lower(a.name),lower($1))>0 OR strpos(lower(a.group_tag),lower($1))>0) AND ($2::uuid IS NULL OR (a.created_at,a.id)<(SELECT created_at,id FROM upstream_accounts WHERE id=$2 AND deleted_at IS NULL)) ORDER BY a.created_at DESC,a.id DESC LIMIT 51").bind(search).bind(before).fetch_all(&self.inner.db).await?;
        let more = rows.len() > 50;
        let items: Vec<_> = rows.into_iter().take(50).collect();
        let next_cursor = if more {
            items.last().map(|a| a.id)
        } else {
            None
        };
        Ok(AccountPage { items, next_cursor })
    }
    pub async fn account(&self, id: Uuid) -> Result<AccountView, Error> {
        account_in(&self.inner.db, id).await
    }
    async fn validate_account(&self, input: &AccountInput) -> Result<(), Error> {
        validate::label(&input.name, 120)?;
        validate::identifier(&input.group_tag, 64)?;
        validate::quota(input.quota_total, input.quota_remaining)?;
        if !(0..=1000).contains(&input.priority)
            || !(1..=1000).contains(&input.weight)
            || !(1..=64).contains(&input.concurrency_limit)
        {
            return Err(Error::Validation);
        }
        if let Some(url) = input.base_url.as_deref().filter(|s| !s.is_empty()) {
            self.inner.http.policy.validate(url).await?;
        }
        Ok(())
    }
    pub async fn save_account(
        &self,
        actor: Uuid,
        id: Option<Uuid>,
        input: AccountInput,
    ) -> Result<AccountView, Error> {
        self.validate_account(&input).await?;
        let mut tx = self.admin_tx(actor).await?;
        let output = self.write_account(&mut tx, id, input).await?;
        audit(
            &mut tx,
            actor,
            "upstream.account.save",
            &output.0.to_string(),
            output.1,
            output.2,
        )
        .await?;
        tx.commit().await?;
        self.account(output.0).await
    }
    async fn write_account(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        id: Option<Uuid>,
        input: AccountInput,
    ) -> Result<(Uuid, Value, Value), Error> {
        let existing = if let Some(id) = id {
            Some(locked_account(tx, id).await?)
        } else {
            None
        };
        let id = id.unwrap_or_else(Uuid::new_v4);
        let new_secret = input.secret.as_deref().filter(|s| !s.is_empty());
        let new_url = input.base_url.as_deref().filter(|s| !s.is_empty());
        let enc = new_secret
            .map(|s| self.inner.cipher.seal(id, s))
            .transpose()?;
        let last4 = new_secret.map(|s| s[s.len() - 4..].to_owned());
        if let Some(before) = &existing {
            if input.revision != Some(before.revision) {
                return Err(Error::Conflict);
            }
            let repair = enc.is_some() || new_url.is_some() || before.status == "DISABLED";
            let status = if !input.enabled {
                "DISABLED"
            } else if input.quota_remaining == 0 {
                "QUOTA_EXHAUSTED"
            } else if repair {
                "ACTIVE"
            } else {
                &before.status
            };
            sqlx::query("UPDATE upstream_accounts SET name=$2,base_url=coalesce($3,base_url),secret_enc=coalesce($4,secret_enc),secret_last4=coalesce($5,secret_last4),group_tag=$6,priority=$7,weight=$8,concurrency_limit=$9,quota_total=$10,quota_remaining=$11,quota_reset_at=$12,status=$13,cooldown_until=CASE WHEN $14 THEN NULL ELSE cooldown_until END,consecutive_failures=CASE WHEN $14 THEN 0 ELSE consecutive_failures END,last_error=CASE WHEN $14 THEN NULL ELSE last_error END,revision=revision+1 WHERE id=$1 AND deleted_at IS NULL")
                .bind(id).bind(&input.name).bind(new_url).bind(enc).bind(last4).bind(&input.group_tag).bind(input.priority).bind(input.weight).bind(input.concurrency_limit).bind(input.quota_total).bind(input.quota_remaining).bind(input.quota_reset_at).bind(status).bind(repair).execute(&mut **tx).await?;
        } else {
            if input.revision.is_some() || enc.is_none() || new_url.is_none() {
                return Err(Error::Validation);
            }
            let count: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM upstream_accounts WHERE deleted_at IS NULL",
            )
            .fetch_one(&mut **tx)
            .await?;
            if count >= 500 {
                return Err(Error::Validation);
            }
            let status = if !input.enabled {
                "DISABLED"
            } else if input.quota_remaining == 0 {
                "QUOTA_EXHAUSTED"
            } else {
                "ACTIVE"
            };
            sqlx::query("INSERT INTO upstream_accounts(id,name,base_url,secret_enc,secret_last4,group_tag,priority,weight,concurrency_limit,quota_total,quota_remaining,quota_reset_at,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)")
                .bind(id).bind(&input.name).bind(new_url).bind(enc).bind(last4).bind(&input.group_tag).bind(input.priority).bind(input.weight).bind(input.concurrency_limit).bind(input.quota_total).bind(input.quota_remaining).bind(input.quota_reset_at).bind(status).execute(&mut **tx).await?;
        }
        let before = existing
            .map(serde_json::to_value)
            .transpose()
            .map_err(|_| Error::Store)?
            .unwrap_or(Value::Null);
        let after =
            serde_json::to_value(account_in(&mut **tx, id).await?).map_err(|_| Error::Store)?;
        Ok((id, before, after))
    }
    pub async fn import_accounts(
        &self,
        actor: Uuid,
        inputs: Vec<AccountInput>,
    ) -> Result<Vec<AccountView>, Error> {
        if inputs.is_empty() || inputs.len() > 100 {
            return Err(Error::Validation);
        }
        for input in &inputs {
            self.validate_account(input).await?;
        }
        let mut tx = self.admin_tx(actor).await?;
        let mut ids = Vec::new();
        for input in inputs {
            let (id, before, after) = self.write_account(&mut tx, None, input).await?;
            audit(
                &mut tx,
                actor,
                "upstream.account.import",
                &id.to_string(),
                before,
                after,
            )
            .await?;
            ids.push(id);
        }
        tx.commit().await?;
        let mut views = Vec::new();
        for id in ids {
            views.push(self.account(id).await?);
        }
        Ok(views)
    }
    pub async fn delete_account(&self, actor: Uuid, id: Uuid, revision: i64) -> Result<(), Error> {
        let mut tx = self.admin_tx(actor).await?;
        let before = locked_account(&mut tx, id).await?;
        if before.revision != revision || before.in_flight > 0 {
            return Err(Error::Conflict);
        }
        sqlx::query("UPDATE upstream_accounts SET deleted_at=clock_timestamp(),status='DISABLED',revision=revision+1 WHERE id=$1").bind(id).execute(&mut *tx).await?;
        audit(
            &mut tx,
            actor,
            "upstream.account.delete",
            &id.to_string(),
            serde_json::to_value(before).map_err(|_| Error::Store)?,
            json!({"deleted":true}),
        )
        .await?;
        tx.commit().await?;
        Ok(())
    }
    pub async fn refresh_quota(
        &self,
        actor: Uuid,
        id: Uuid,
        input: QuotaInput,
    ) -> Result<AccountView, Error> {
        validate::quota(input.quota_total, input.quota_remaining)?;
        let mut tx = self.admin_tx(actor).await?;
        let before = locked_account(&mut tx, id).await?;
        if before.revision != input.revision {
            return Err(Error::Conflict);
        }
        sqlx::query("UPDATE upstream_accounts SET quota_total=$2,quota_remaining=$3,quota_reset_at=$4,status=CASE WHEN status IN ('INVALID','DISABLED') THEN status WHEN $3=0 THEN 'QUOTA_EXHAUSTED' ELSE 'ACTIVE' END,cooldown_until=NULL,revision=revision+1 WHERE id=$1")
            .bind(id).bind(input.quota_total).bind(input.quota_remaining).bind(input.quota_reset_at).execute(&mut *tx).await?;
        let after = account_in(&mut *tx, id).await?;
        audit(
            &mut tx,
            actor,
            "upstream.account.quota",
            &id.to_string(),
            serde_json::to_value(before).map_err(|_| Error::Store)?,
            serde_json::to_value(&after).map_err(|_| Error::Store)?,
        )
        .await?;
        tx.commit().await?;
        Ok(after)
    }
    pub async fn models(&self) -> Result<Vec<ModelView>, Error> {
        models_in(&self.inner.db).await
    }
    pub async fn save_model(
        &self,
        actor: Uuid,
        existing: bool,
        input: ModelInput,
    ) -> Result<ModelView, Error> {
        validate::identifier(&input.id, 64)?;
        validate::label(&input.display_name, 120)?;
        validate::capabilities(&input.kind, &input.capabilities)?;
        if !(-10000..=10000).contains(&input.sort_order) {
            return Err(Error::Validation);
        }
        if let Some(name) = input.upstream_model.as_deref().filter(|s| !s.is_empty()) {
            validate::label(name, 200)?;
        }
        let mut tx = self.admin_tx(actor).await?;
        let before = models_in(&mut *tx)
            .await?
            .into_iter()
            .find(|m| m.id == input.id);
        if existing {
            let old = before.as_ref().ok_or(Error::NotFound)?;
            if input.revision != Some(old.revision) {
                return Err(Error::Conflict);
            }
            if input.kind != old.kind {
                return Err(Error::Validation);
            }
            sqlx::query("UPDATE models SET display_name=$2,upstream_model=coalesce($3,upstream_model),enabled=$4,capabilities=$5,sort_order=$6,revision=revision+1,updated_at=clock_timestamp() WHERE id=$1")
                .bind(&input.id).bind(&input.display_name).bind(input.upstream_model.as_deref().filter(|s|!s.is_empty())).bind(input.enabled).bind(serde_json::to_value(&input.capabilities).map_err(|_|Error::Validation)?).bind(input.sort_order).execute(&mut *tx).await?;
        } else {
            if before.is_some() {
                return Err(Error::Conflict);
            }
            if input.enabled || input.revision.is_some() {
                return Err(Error::Validation);
            }
            let count: i64 = sqlx::query_scalar("SELECT count(*) FROM models")
                .fetch_one(&mut *tx)
                .await?;
            if count >= 200 {
                return Err(Error::Validation);
            }
            let upstream = input
                .upstream_model
                .as_deref()
                .filter(|s| !s.is_empty())
                .ok_or(Error::Validation)?;
            sqlx::query("INSERT INTO models(id,kind,display_name,upstream_model,capabilities,sort_order) VALUES($1,$2,$3,$4,$5,$6)")
                .bind(&input.id).bind(&input.kind).bind(&input.display_name).bind(upstream).bind(serde_json::to_value(&input.capabilities).map_err(|_|Error::Validation)?).bind(input.sort_order).execute(&mut *tx).await?;
        }
        ensure_enabled(&mut tx).await?;
        let after = models_in(&mut *tx)
            .await?
            .into_iter()
            .find(|m| m.id == input.id)
            .ok_or(Error::Store)?;
        audit(
            &mut tx,
            actor,
            "upstream.model.save",
            &input.id,
            serde_json::to_value(before).map_err(|_| Error::Store)?,
            serde_json::to_value(&after).map_err(|_| Error::Store)?,
        )
        .await?;
        tx.commit().await?;
        Ok(after)
    }
    pub async fn bind_accounts(
        &self,
        actor: Uuid,
        id: &str,
        input: BindingInput,
    ) -> Result<ModelView, Error> {
        if input.account_ids.len() > 500 || input.group_tags.len() > 32 {
            return Err(Error::Validation);
        }
        for tag in &input.group_tags {
            validate::identifier(tag, 64)?;
        }
        if input
            .account_ids
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len()
            != input.account_ids.len()
            || input
                .group_tags
                .iter()
                .collect::<std::collections::HashSet<_>>()
                .len()
                != input.group_tags.len()
        {
            return Err(Error::Validation);
        }
        let mut tx = self.admin_tx(actor).await?;
        let before = models_in(&mut *tx)
            .await?
            .into_iter()
            .find(|m| m.id == id)
            .ok_or(Error::NotFound)?;
        if before.revision != input.revision {
            return Err(Error::Conflict);
        }
        let count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM upstream_accounts WHERE id=ANY($1) AND deleted_at IS NULL",
        )
        .bind(&input.account_ids)
        .fetch_one(&mut *tx)
        .await?;
        if count != input.account_ids.len() as i64 {
            return Err(Error::NotFound);
        }
        sqlx::query("DELETE FROM account_models WHERE model_id=$1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        for account in &input.account_ids {
            sqlx::query("INSERT INTO account_models(account_id,model_id) VALUES($1,$2)")
                .bind(account)
                .bind(id)
                .execute(&mut *tx)
                .await?;
        }
        sqlx::query("UPDATE models SET group_tags=$2,revision=revision+1,updated_at=clock_timestamp() WHERE id=$1").bind(id).bind(&input.group_tags).execute(&mut *tx).await?;
        ensure_enabled(&mut tx).await?;
        let after = models_in(&mut *tx)
            .await?
            .into_iter()
            .find(|m| m.id == id)
            .ok_or(Error::Store)?;
        audit(
            &mut tx,
            actor,
            "upstream.model.bind",
            id,
            serde_json::to_value(before).map_err(|_| Error::Store)?,
            serde_json::to_value(&after).map_err(|_| Error::Store)?,
        )
        .await?;
        tx.commit().await?;
        Ok(after)
    }
    pub async fn pricing(&self) -> Result<Pricing, Error> {
        pricing_in(&self.inner.db).await
    }
    pub async fn save_pricing(&self, actor: Uuid, input: Pricing) -> Result<Pricing, Error> {
        if input.rules.len() > 600 || input.multipliers.len() != 6 {
            return Err(Error::Validation);
        }
        let mut tx = self.admin_tx(actor).await?;
        let before = pricing_in(&mut *tx).await?;
        if before.revision != input.revision {
            return Err(Error::Conflict);
        }
        let models = models_in(&mut *tx).await?;
        let mut seen = std::collections::HashSet::new();
        for rule in &input.rules {
            let model = models
                .iter()
                .find(|m| m.id == rule.model_id)
                .ok_or(Error::NotFound)?;
            let minimum = if model.kind == "chat" { 0 } else { 1 };
            if !model.capabilities.qualities.contains(&rule.quality)
                || !seen.insert((&rule.model_id, &rule.quality))
                || !(minimum..=1_000_000).contains(&rule.base_credits)
                || !(0..=1_000_000).contains(&rule.edit_surcharge)
            {
                return Err(Error::Validation);
            }
        }
        let mut resolutions = std::collections::HashSet::new();
        for mult in &input.multipliers {
            if !["1K", "2K", "4K", "720p", "1080p", "text"].contains(&mult.resolution.as_str())
                || !(1..=100).contains(&mult.multiplier)
                || !resolutions.insert(&mult.resolution)
            {
                return Err(Error::Validation);
            }
        }
        sqlx::query("DELETE FROM pricing_rules")
            .execute(&mut *tx)
            .await?;
        for rule in &input.rules {
            sqlx::query("INSERT INTO pricing_rules(model_id,quality,base_credits,edit_surcharge) VALUES($1,$2,$3,$4)").bind(&rule.model_id).bind(&rule.quality).bind(rule.base_credits).bind(rule.edit_surcharge).execute(&mut *tx).await?;
        }
        for mult in &input.multipliers {
            sqlx::query("UPDATE pricing_multipliers SET multiplier=$2 WHERE resolution=$1")
                .bind(&mult.resolution)
                .bind(mult.multiplier)
                .execute(&mut *tx)
                .await?;
        }
        sqlx::query("UPDATE system_settings SET value=to_jsonb($1::bigint),updated_by=$2,updated_at=clock_timestamp() WHERE key='pricing_revision'").bind(before.revision+1).bind(actor).execute(&mut *tx).await?;
        ensure_enabled(&mut tx).await?;
        let after = pricing_in(&mut *tx).await?;
        audit(
            &mut tx,
            actor,
            "upstream.pricing.save",
            "pricing",
            serde_json::to_value(before).map_err(|_| Error::Store)?,
            serde_json::to_value(&after).map_err(|_| Error::Store)?,
        )
        .await?;
        tx.commit().await?;
        Ok(after)
    }
    pub async fn stats(&self, id: Uuid) -> Result<AccountStats, Error> {
        self.account(id).await?;
        let row=sqlx::query("SELECT count(*) AS total,count(*) FILTER (WHERE code='SUCCESS') AS successes,avg(elapsed_ms)::float8 AS average_ms FROM upstream_attempts WHERE account_id=$1 AND created_at>clock_timestamp()-interval '24 hours'").bind(id).fetch_one(&self.inner.db).await?;
        let errors=sqlx::query_as::<_,ErrorCount>("SELECT code,count(*) AS count FROM upstream_attempts WHERE account_id=$1 AND created_at>clock_timestamp()-interval '24 hours' AND code NOT IN ('SUCCESS','CANCELLED') GROUP BY code ORDER BY code").bind(id).fetch_all(&self.inner.db).await?;
        Ok(AccountStats {
            total: row.get("total"),
            successes: row.get("successes"),
            average_ms: row.get("average_ms"),
            errors,
        })
    }
}
pub(crate) async fn account_in<'e, E: sqlx::Executor<'e, Database = Postgres>>(
    db: E,
    id: Uuid,
) -> Result<AccountView, Error> {
    sqlx::query_as("SELECT a.id,a.name,a.kind,a.secret_last4,true AS endpoint_configured,a.group_tag,a.priority,a.weight,a.concurrency_limit,a.quota_total,a.quota_remaining,a.quota_reset_at,a.status,a.cooldown_until,a.consecutive_failures,a.last_error,a.last_used_at,a.revision,a.created_at,(SELECT count(*) FROM upstream_leases l WHERE l.account_id=a.id AND l.completed=false AND l.expires_at>clock_timestamp()) AS in_flight FROM upstream_accounts a WHERE a.id=$1 AND a.deleted_at IS NULL")
    .bind(id)
    .fetch_optional(db)
    .await?
    .ok_or(Error::NotFound)
}
pub(crate) async fn models_in<'e, E: sqlx::Executor<'e, Database = Postgres>>(
    db: E,
) -> Result<Vec<ModelView>, Error> {
    let rows=sqlx::query("SELECT m.id,m.kind,m.display_name,m.enabled,m.capabilities,m.sort_order,m.revision,m.group_tags,ARRAY(SELECT account_id FROM account_models WHERE model_id=m.id ORDER BY account_id) AS account_ids FROM models m ORDER BY m.sort_order,m.id LIMIT 201").fetch_all(db).await?;
    rows.into_iter()
        .map(|row| {
            Ok(ModelView {
                id: row.get("id"),
                kind: row.get("kind"),
                display_name: row.get("display_name"),
                enabled: row.get("enabled"),
                upstream_configured: true,
                capabilities: serde_json::from_value(row.get("capabilities"))
                    .map_err(|_| Error::Store)?,
                sort_order: row.get("sort_order"),
                revision: row.get("revision"),
                group_tags: row.get("group_tags"),
                account_ids: row.get("account_ids"),
            })
        })
        .collect()
}
async fn pricing_in<'e, E: sqlx::Executor<'e, Database = Postgres>>(
    db: E,
) -> Result<Pricing, Error> {
    let value:Value=sqlx::query_scalar("SELECT jsonb_build_object('revision',(SELECT (value#>>'{}')::bigint FROM system_settings WHERE key='pricing_revision'),'rules',coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.model_id,p.quality) FROM pricing_rules p),'[]'::jsonb),'multipliers',coalesce((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.resolution) FROM pricing_multipliers m),'[]'::jsonb))").fetch_one(db).await?;
    serde_json::from_value(value).map_err(|_| Error::Store)
}
async fn locked_account(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
) -> Result<AccountView, Error> {
    sqlx::query("SELECT id FROM upstream_accounts WHERE id=$1 AND deleted_at IS NULL FOR UPDATE")
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(Error::NotFound)?;
    account_in(&mut **tx, id).await
}
pub(crate) async fn audit(
    tx: &mut Transaction<'_, Postgres>,
    actor: Uuid,
    action: &str,
    target: &str,
    before: Value,
    after: Value,
) -> Result<(), Error> {
    sqlx::query("INSERT INTO audit_logs(actor_id,action,target_type,target_id,before,after) VALUES($1,$2,'upstream',$3,$4,$5)").bind(actor).bind(action).bind(target).bind(before).bind(after).execute(&mut **tx).await?;
    Ok(())
}
async fn ensure_enabled(tx: &mut Transaction<'_, Postgres>) -> Result<(), Error> {
    let invalid:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM models m WHERE m.enabled AND (NOT EXISTS(SELECT 1 FROM upstream_accounts a WHERE a.deleted_at IS NULL AND (a.group_tag=ANY(m.group_tags) OR EXISTS(SELECT 1 FROM account_models b WHERE b.account_id=a.id AND b.model_id=m.id))) OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(m.capabilities->'qualities') q WHERE NOT EXISTS(SELECT 1 FROM pricing_rules p WHERE p.model_id=m.id AND p.quality=q.value))))").fetch_one(&mut **tx).await?;
    if invalid {
        return Err(Error::Validation);
    }
    Ok(())
}
