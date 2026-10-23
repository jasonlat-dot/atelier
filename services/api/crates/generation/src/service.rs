use crate::*;
use atelier_assets::AssetService;
use atelier_upstream::{validation, Capabilities};
use atelier_wallet::{Operation, WalletService};
use sha2::{Digest, Sha256};
use sqlx::{PgConnection, PgPool, Postgres, Row, Transaction};
use uuid::Uuid;
#[derive(Clone)]
pub struct GenerationService {
    pub(crate) db: PgPool,
    pub(crate) assets: AssetService,
    pub(crate) wake: std::sync::Arc<tokio::sync::Notify>,
    pub(crate) bus: Option<std::sync::Arc<crate::events::EventBus>>,
}
impl GenerationService {
    pub fn new(db: PgPool, assets: AssetService) -> Self {
        Self {
            db,
            assets,
            wake: std::sync::Arc::new(tokio::sync::Notify::new()),
            bus: None,
        }
    }
    pub(crate) async fn owner_tx(
        &self,
        owner: Uuid,
    ) -> Result<Transaction<'static, Postgres>, GenerationError> {
        let mut tx = self.db.begin().await?;
        let active: Option<Uuid> =
            sqlx::query_scalar("SELECT id FROM users WHERE id=$1 AND status='ACTIVE' FOR UPDATE")
                .bind(owner)
                .fetch_optional(&mut *tx)
                .await?;
        if active.is_none() {
            return Err(GenerationError::NotFound);
        }
        Ok(tx)
    }
    pub async fn quote(&self, owner: Uuid, input: &QuoteInput) -> Result<Quote, GenerationError> {
        let mut tx = self.db.begin().await?;
        let active: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM users WHERE id=$1 AND status='ACTIVE')",
        )
        .bind(owner)
        .fetch_one(&mut *tx)
        .await?;
        if !active {
            return Err(GenerationError::NotFound);
        }
        let q = price(&mut tx, input).await?;
        tx.commit().await?;
        Ok(q)
    }
    pub async fn create(
        &self,
        owner: Uuid,
        key: Uuid,
        mut input: JobInput,
    ) -> Result<JobReceipt, GenerationError> {
        if key.is_nil() {
            return Err(GenerationError::Validation);
        }
        input.prompt = input.prompt.trim().to_owned();
        if input.prompt.is_empty()
            || input.prompt.chars().count() > 4000
            || input.prompt.contains('\0')
            || input.references.len() > 4
            || input
                .references
                .iter()
                .any(|r| r.asset_id.is_nil() || r.role != "reference")
            || input
                .references
                .iter()
                .map(|r| r.asset_id)
                .collect::<std::collections::HashSet<_>>()
                .len()
                != input.references.len()
        {
            return Err(GenerationError::Validation);
        }
        let hash =
            Sha256::digest(serde_json::to_vec(&input).map_err(|_| GenerationError::Validation)?)
                .to_vec();
        let mut tx = self.owner_tx(owner).await?;
        let old = sqlx::query(
            "SELECT id,request_hash FROM generation_jobs WHERE owner_id=$1 AND idempotency_key=$2",
        )
        .bind(owner)
        .bind(key)
        .fetch_optional(&mut *tx)
        .await?;
        if let Some(old) = old {
            if old.get::<Vec<u8>, _>("request_hash") != hash {
                return Err(GenerationError::Conflict);
            }
            let id = old.get("id");
            tx.commit().await?;
            return Ok(JobReceipt {
                job: self.get(owner, id).await?,
            });
        }
        atelier_canvas::CanvasService::validate_generation_link(
            &mut tx,
            owner,
            input.project_id,
            input.node_id.as_deref(),
        )
        .await?;
        if moderated(&mut tx, &input.prompt).await? {
            sqlx::query("INSERT INTO moderation_violations(user_id,source) VALUES($1,'local')")
                .bind(owner)
                .execute(&mut *tx)
                .await?;
            tx.commit().await?;
            return Err(GenerationError::ContentPolicy);
        }
        let quote = price(&mut tx, &input.quote()).await?;
        if quote.kind == "video" && !self.assets.video_enabled() {
            return Err(GenerationError::Model);
        }
        let limit: serde_json::Value = sqlx::query_scalar(
            "SELECT value FROM system_settings WHERE key='max_active_jobs_free'",
        )
        .fetch_one(&mut *tx)
        .await?;
        let limit = limit
            .as_i64()
            .filter(|n| (1..=64).contains(n))
            .ok_or(GenerationError::Store)?;
        let count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM generation_jobs WHERE owner_id=$1 AND finished_at IS NULL",
        )
        .bind(owner)
        .fetch_one(&mut *tx)
        .await?;
        if count >= limit {
            return Err(GenerationError::ActiveLimit);
        }
        let ids: Vec<_> = input.references.iter().map(|r| r.asset_id).collect();
        AssetService::validate_references_in_transaction(&mut tx, owner, &ids).await?;
        let params = JobParams {
            quality: input.quality,
            ratio: input.ratio,
            resolution: input.resolution,
            references: input.references,
            seconds: input.seconds,
        };
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO generation_jobs(id,owner_id,model_id,kind,model_revision,prompt,params,size,cost_per_output,n,cost,idempotency_key,request_hash,project_id,node_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)")
   .bind(id).bind(owner).bind(input.model_id).bind(&quote.kind).bind(quote.model_revision).bind(input.prompt).bind(serde_json::to_value(params).map_err(|_|GenerationError::Store)?).bind(quote.size).bind(quote.cost_per_output).bind(i32::from(input.n)).bind(quote.cost).bind(key).bind(hash).bind(input.project_id).bind(input.node_id).execute(&mut *tx).await?;
        WalletService::apply_in_transaction(
            &mut tx,
            owner,
            Operation::Hold {
                job: id,
                amount: quote.cost,
            },
        )
        .await?;
        event(&mut tx, owner, id).await?;
        sqlx::query("SELECT pg_notify('atelier_generation',$1)")
            .bind(id.to_string())
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        self.wake.notify_waiters();
        Ok(JobReceipt {
            job: self.get(owner, id).await?,
        })
    }
    pub async fn get(&self, owner: Uuid, id: Uuid) -> Result<JobView, GenerationError> {
        let row=sqlx::query("SELECT j.*,m.display_name FROM generation_jobs j JOIN models m ON m.id=j.model_id WHERE j.id=$1 AND j.owner_id=$2").bind(id).bind(owner).fetch_optional(&self.db).await?.ok_or(GenerationError::NotFound)?;
        let output=sqlx::query("SELECT idx,asset_id FROM generation_outputs WHERE job_id=$1 AND status='READY' ORDER BY idx").bind(id).fetch_all(&self.db).await?;
        let mut outputs = Vec::new();
        for o in output {
            match self.assets.get(owner, o.get("asset_id")).await {
                Ok(asset) => outputs.push(JobOutput {
                    idx: o.get("idx"),
                    asset,
                }),
                Err(atelier_assets::AssetError::NotFound) => {}
                Err(_) => return Err(GenerationError::Store),
            }
        }
        Ok(JobView {
            id,
            project_id: row.get("project_id"),
            node_id: row.get("node_id"),
            kind: row.get("kind"),
            model_id: row.get("model_id"),
            display_name: row.get("display_name"),
            prompt: row.get("prompt"),
            params: serde_json::from_value(row.get("params"))
                .map_err(|_| GenerationError::Store)?,
            size: row.get("size"),
            n: row.get("n"),
            cost: row.get("cost"),
            cost_per_output: row.get("cost_per_output"),
            settled: row.get("settled"),
            released: row.get("released"),
            status: row.get("status"),
            error_code: row.get("error_code"),
            attempts: row.get("attempts"),
            progress: row.get("progress"),
            cancel_requested: row.get("cancel_requested"),
            outputs,
            created_at: row.get("created_at"),
            updated_at: row.get("updated_at"),
            finished_at: row.get("finished_at"),
        })
    }
    pub async fn list(
        &self,
        owner: Uuid,
        before: Option<Uuid>,
        status: Option<String>,
        limit: i64,
    ) -> Result<JobPage, GenerationError> {
        self.list_project(owner, before, status, limit, None).await
    }
    pub async fn list_project(
        &self,
        owner: Uuid,
        before: Option<Uuid>,
        status: Option<String>,
        limit: i64,
        project: Option<Uuid>,
    ) -> Result<JobPage, GenerationError> {
        if !(1..=100).contains(&limit) || status.as_deref().is_some_and(|s| !is_status(s)) {
            return Err(GenerationError::Validation);
        }
        let mut ids:Vec<Uuid>=sqlx::query_scalar("SELECT id FROM generation_jobs WHERE owner_id=$1 AND ($2::text IS NULL OR status=$2) AND ($3::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM generation_jobs WHERE id=$3 AND owner_id=$1)) AND ($5::uuid IS NULL OR project_id=$5) ORDER BY created_at DESC,id DESC LIMIT $4")
   .bind(owner).bind(status).bind(before).bind(limit+1).bind(project).fetch_all(&self.db).await?;
        let more = ids.len() > limit as usize;
        ids.truncate(limit as usize);
        let next_cursor = if more { ids.last().copied() } else { None };
        let mut items = Vec::new();
        for id in ids {
            items.push(self.get(owner, id).await?);
        }
        Ok(JobPage { items, next_cursor })
    }
    pub async fn cancel(&self, owner: Uuid, id: Uuid) -> Result<JobReceipt, GenerationError> {
        let mut tx = self.owner_tx(owner).await?;
        let row = sqlx::query(
            "SELECT status FROM generation_jobs WHERE id=$1 AND owner_id=$2 FOR UPDATE",
        )
        .bind(id)
        .bind(owner)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(GenerationError::NotFound)?;
        let status: String = row.get("status");
        if matches!(status.as_str(), "QUEUED" | "ROUTING") {
            terminal_failure(&mut tx, owner, id, "CANCELLED", None).await?;
        } else if matches!(status.as_str(), "RUNNING" | "STORING") {
            let changed=sqlx::query("UPDATE generation_jobs SET cancel_requested=true,updated_at=clock_timestamp() WHERE id=$1 AND cancel_requested=false").bind(id).execute(&mut *tx).await?;
            if changed.rows_affected() > 0 {
                event(&mut tx, owner, id).await?;
            }
        }
        tx.commit().await?;
        self.wake.notify_waiters();
        Ok(JobReceipt {
            job: self.get(owner, id).await?,
        })
    }
    pub async fn events(
        &self,
        owner: Uuid,
        after: i64,
        limit: i64,
    ) -> Result<Vec<JobEvent>, GenerationError> {
        if after < 0 || !(1..=100).contains(&limit) {
            return Err(GenerationError::Validation);
        }
        Ok(sqlx::query_as("SELECT seq,job_id,payload,created_at FROM job_events WHERE user_id=$1 AND seq>$2 ORDER BY seq LIMIT $3").bind(owner).bind(after).bind(limit).fetch_all(&self.db).await?)
    }
}
pub(crate) fn is_status(s: &str) -> bool {
    matches!(
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
}
pub(crate) async fn event(
    tx: &mut PgConnection,
    owner: Uuid,
    id: Uuid,
) -> Result<(), GenerationError> {
    sqlx::query("INSERT INTO job_events(user_id,job_id,payload) SELECT owner_id,id,jsonb_build_object('job_id',id,'status',status,'progress',progress,'cancel_requested',cancel_requested,'error_code',error_code,'outputs',coalesce((SELECT jsonb_agg(jsonb_build_object('idx',o.idx,'asset_id',o.asset_id) ORDER BY o.idx) FROM generation_outputs o WHERE o.job_id=j.id AND o.status='READY'),'[]'::jsonb)) FROM generation_jobs j WHERE j.id=$1 AND owner_id=$2")
  .bind(id).bind(owner).execute(&mut *tx).await?;
    sqlx::query("SELECT pg_notify('atelier_job_events',$1)")
        .bind(owner.to_string())
        .execute(tx)
        .await?;
    Ok(())
}
pub(crate) async fn terminal_failure(
    tx: &mut PgConnection,
    owner: Uuid,
    id: Uuid,
    status: &str,
    code: Option<&str>,
) -> Result<(), GenerationError> {
    let cost: i64 = sqlx::query_scalar(
        "SELECT cost FROM generation_jobs WHERE id=$1 AND owner_id=$2 AND finished_at IS NULL",
    )
    .bind(id)
    .bind(owner)
    .fetch_one(&mut *tx)
    .await?;
    WalletService::apply_in_transaction(
        tx,
        owner,
        Operation::Release {
            job: id,
            amount: cost,
        },
    )
    .await?;
    sqlx::query("UPDATE generation_jobs SET status=$3,error_code=$4,released=cost,finished_at=clock_timestamp(),updated_at=clock_timestamp(),lease_until=NULL,lease_token=NULL,locked_by=NULL WHERE id=$1 AND owner_id=$2 AND finished_at IS NULL")
  .bind(id).bind(owner).bind(status).bind(code).execute(&mut *tx).await?;
    if code == Some("CONTENT_POLICY") {
        sqlx::query(
            "INSERT INTO moderation_violations(user_id,job_id,source) VALUES($1,$2,'upstream')",
        )
        .bind(owner)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    }
    event(tx, owner, id).await
}
async fn price(tx: &mut PgConnection, i: &QuoteInput) -> Result<Quote, GenerationError> {
    if i.model_id.len() > 64
        || i.quality.len() > 16
        || i.ratio.len() > 8
        || i.resolution.len() > 8
        || i.n == 0
        || i.n > 4
        || i.ref_count > 4
    {
        return Err(GenerationError::Validation);
    }
    sqlx::query("SELECT pg_advisory_xact_lock_shared(1096043828)")
        .execute(&mut *tx)
        .await?;
    let maintenance: serde_json::Value =
        sqlx::query_scalar("SELECT value FROM system_settings WHERE key='maintenance_mode'")
            .fetch_one(&mut *tx)
            .await?;
    if maintenance.as_bool() != Some(false) {
        return Err(GenerationError::Store);
    }
    let row =
        sqlx::query("SELECT kind,capabilities,revision FROM models WHERE id=$1 AND enabled=true")
            .bind(&i.model_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(GenerationError::Model)?;
    let kind: String = row.get("kind");
    let caps: Capabilities =
        serde_json::from_value(row.get("capabilities")).map_err(|_| GenerationError::Store)?;
    if !matches!(kind.as_str(), "image" | "video")
        || !caps.qualities.contains(&i.quality)
        || !caps.ratios.contains(&i.ratio)
        || !caps.resolutions.contains(&i.resolution)
        || i.n > caps.max_n
        || i.ref_count > caps.max_refs
        || (kind == "image" && i.ref_count > 0 && !caps.supports_edit)
        || (kind == "image" && i.seconds.is_some())
        || (kind == "video" && (i.n != 1 || i.seconds.is_none_or(|s| !caps.seconds.contains(&s))))
    {
        return Err(GenerationError::Validation);
    }
    if kind == "image" {
        let free: serde_json::Value =
            sqlx::query_scalar("SELECT value FROM system_settings WHERE key='free_max_resolution'")
                .fetch_one(&mut *tx)
                .await?;
        let level = |s: &str| match s {
            "1K" => 1,
            "2K" => 2,
            "4K" => 3,
            _ => 0,
        };
        if level(&i.resolution) > level(free.as_str().ok_or(GenerationError::Store)?) {
            return Err(GenerationError::Tier);
        }
    }
    let size = validation::size_for(&kind, &i.ratio, &i.resolution, &caps)
        .map_err(|_| GenerationError::Validation)?;
    let rule=sqlx::query("SELECT p.base_credits,p.edit_surcharge,m.multiplier FROM pricing_rules p JOIN pricing_multipliers m ON m.resolution=$3 WHERE p.model_id=$1 AND p.quality=$2")
  .bind(&i.model_id).bind(&i.quality).bind(&i.resolution).fetch_optional(&mut *tx).await?.ok_or(GenerationError::Model)?;
    let unit = i64::from(rule.get::<i32, _>("base_credits"))
        * i64::from(rule.get::<i32, _>("multiplier"))
        + if kind == "image" && i.ref_count > 0 {
            i64::from(rule.get::<i32, _>("edit_surcharge"))
        } else {
            0
        };
    let unit = unit
        * if kind == "video" {
            i64::from(i.seconds.ok_or(GenerationError::Validation)?)
        } else {
            1
        };
    if !(1..=1_000_000_000_000).contains(&unit) {
        return Err(GenerationError::Validation);
    }
    let pricing: serde_json::Value =
        sqlx::query_scalar("SELECT value FROM system_settings WHERE key='pricing_revision'")
            .fetch_one(tx)
            .await?;
    Ok(Quote {
        kind,
        cost: unit * i64::from(i.n),
        cost_per_output: unit,
        size,
        model_revision: row.get("revision"),
        pricing_revision: pricing.as_i64().ok_or(GenerationError::Store)?,
        timeout_seconds: if i.quality == "high" || i.resolution != "1K" {
            300
        } else {
            120
        },
    })
}
async fn moderated(tx: &mut PgConnection, prompt: &str) -> Result<bool, GenerationError> {
    let rows = sqlx::query(
        "SELECT pattern,is_regex FROM moderation_rules WHERE enabled ORDER BY id LIMIT 1001",
    )
    .fetch_all(tx)
    .await?;
    if rows.len() > 1000 {
        return Err(GenerationError::Store);
    }
    for row in rows {
        let p: String = row.get("pattern");
        let matched = if row.get::<bool, _>("is_regex") {
            regex::RegexBuilder::new(&p)
                .size_limit(1_048_576)
                .dfa_size_limit(1_048_576)
                .build()
                .map_err(|_| GenerationError::Store)?
                .is_match(prompt)
        } else {
            prompt.to_lowercase().contains(&p.to_lowercase())
        };
        if matched {
            return Ok(true);
        }
    }
    Ok(false)
}
/// Shared content boundary for other paid text entry points. Caller commits a rejection audit.
pub async fn content_is_blocked(
    tx: &mut PgConnection,
    owner: Uuid,
    prompt: &str,
) -> Result<bool, GenerationError> {
    let blocked = moderated(tx, prompt).await?;
    if blocked {
        sqlx::query("INSERT INTO moderation_violations(user_id,source) VALUES($1,'local')")
            .bind(owner)
            .execute(tx)
            .await?;
    }
    Ok(blocked)
}
