use crate::{
    provider::{ImageRequest, MediaOutput, Provider, ProviderAccount, VideoRequest, VideoStatus},
    service::{account_in, audit},
    slots::SlotStore,
    Capabilities, Error, FailureCode, ProbeResult, ProviderFailure, UpstreamService,
};
use chrono::Utc;
use sqlx::Row;
use std::{
    collections::HashSet,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tokio::task::JoinHandle;
use uuid::Uuid;
#[derive(Clone)]
pub struct RouteRequirements {
    pub quality: String,
    pub ratio: String,
    pub resolution: String,
    pub n: u8,
    pub reference_count: u8,
    pub seconds: Option<u32>,
}
#[derive(sqlx::FromRow)]
struct Candidate {
    id: Uuid,
    priority: i32,
    weight: i32,
    concurrency_limit: i32,
    quota_total: i64,
    quota_remaining: i64,
}
struct ModelSnapshot {
    kind: String,
    caps: Capabilities,
    upstream: String,
    revision: i64,
}
pub struct RouteLease {
    pub account_id: Uuid,
    service: UpstreamService,
    slots: SlotStore,
    id: Uuid,
    token: Uuid,
    member: String,
    revision: i64,
    units: i32,
    context: ProviderAccount,
    model: Option<ModelSnapshot>,
    valid: Arc<AtomicBool>,
    heartbeat: JoinHandle<()>,
    done: bool,
    usage_key: Option<Uuid>,
}
struct PendingSlot {
    slots: SlotStore,
    account: Uuid,
    member: String,
    armed: bool,
}
impl Drop for PendingSlot {
    fn drop(&mut self) {
        if self.armed {
            let slots = self.slots.clone();
            let account = self.account;
            let member = self.member.clone();
            if let Ok(handle) = tokio::runtime::Handle::try_current() {
                handle.spawn(async move {
                    let _ = slots.release(account, &member).await;
                });
            }
        }
    }
}
impl Drop for RouteLease {
    fn drop(&mut self) {
        self.heartbeat.abort();
        self.valid.store(false, Ordering::Release);
        if self.done {
            return;
        }
        let service = self.service.clone();
        let slots = self.slots.clone();
        let account = self.account_id;
        let id = self.id;
        let token = self.token;
        let member = self.member.clone();
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move{let _=slots.release(account,&member).await;let _=tokio::time::timeout(Duration::from_secs(5),sqlx::query("UPDATE upstream_leases SET completed=true WHERE id=$1 AND token=$2 AND completed=false").bind(id).bind(token).execute(&service.inner.db)).await;});
        }
    }
}
impl RouteLease {
    pub(crate) async fn open_chat(
        &self,
        input: &atelier_agent_core::ChatRequest,
    ) -> Result<crate::egress::GuardedResponse, Error> {
        if self.model.as_ref().is_none_or(|m| m.kind != "chat") {
            return Err(Error::Validation);
        }
        tokio::select! {result=crate::chat::open(&self.service.inner.http,&self.context,input)=>result,_=self.invalid()=>Err(Error::Store)}
    }
    pub fn model_revision(&self) -> Option<i64> {
        self.model.as_ref().map(|m| m.revision)
    }
    pub fn account_revision(&self) -> i64 {
        self.revision
    }
    pub async fn image_once(
        &self,
        input: &ImageRequest,
        size: &str,
    ) -> Result<Vec<MediaOutput>, Error> {
        tokio::select! { r=self.service.inner.provider.images(&self.context,input,size)=>r,_=self.invalid()=>Err(Error::Store) }
    }
    pub async fn submit_video_once(
        &self,
        input: &VideoRequest,
        size: &str,
    ) -> Result<String, Error> {
        tokio::select! { r=self.service.inner.provider.submit_video(&self.context,input,size)=>r,_=self.invalid()=>Err(Error::Store) }
    }
    pub async fn poll_video_once(&self, id: &str) -> Result<VideoStatus, Error> {
        tokio::select! { r=self.service.inner.provider.poll_video(&self.context,id)=>r,_=self.invalid()=>Err(Error::Store) }
    }
    pub async fn fetch_video_once(&self, id: &str) -> Result<MediaOutput, Error> {
        tokio::select! { r=self.service.inner.provider.video_content(&self.context,id)=>r,_=self.invalid()=>Err(Error::Store) }
    }
    pub async fn finish_generation(
        mut self,
        key: Uuid,
        used: i32,
        operation: &str,
    ) -> Result<(), Error> {
        self.usage_key = Some(key);
        self.finish(None, used, operation, 0, None, false).await
    }
    pub fn is_valid(&self) -> bool {
        self.valid.load(Ordering::Acquire)
    }
    async fn invalid(&self) {
        while self.is_valid() {
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }
    pub async fn finish_success(self, used: i32, operation: &str) -> Result<(), Error> {
        self.finish(None, used, operation, 0, None, false).await
    }
    pub async fn finish_failure(
        self,
        failure: ProviderFailure,
        operation: &str,
    ) -> Result<(), Error> {
        self.finish(Some(failure), 0, operation, 0, None, false)
            .await
    }
    async fn finish(
        mut self,
        failure: Option<ProviderFailure>,
        used: i32,
        operation: &str,
        elapsed: i64,
        actor: Option<Uuid>,
        recover: bool,
    ) -> Result<(), Error> {
        if !(0..=self.units).contains(&used)
            || !["probe", "image", "video", "chat"].contains(&operation)
        {
            return Err(Error::Validation);
        }
        let mut tx = if let Some(actor) = actor {
            self.service.admin_tx(actor).await?
        } else {
            self.service.inner.db.begin().await?
        };
        let current=sqlx::query("SELECT revision,consecutive_failures,quota_reset_at,quota_remaining,status FROM upstream_accounts WHERE id=$1 FOR UPDATE").bind(self.account_id).fetch_one(&mut *tx).await?;
        let before = if actor.is_some() {
            Some(
                serde_json::to_value(account_in(&mut *tx, self.account_id).await?)
                    .map_err(|_| Error::Store)?,
            )
        } else {
            None
        };
        let completed=sqlx::query("UPDATE upstream_leases SET completed=true WHERE id=$1 AND token=$2 AND completed=false AND expires_at>clock_timestamp()")
            .bind(self.id).bind(self.token).execute(&mut *tx).await?;
        if completed.rows_affected() != 1 || !self.is_valid() {
            return Err(Error::Store);
        }
        let revision: i64 = current.get("revision");
        if failure.is_none() && used > 0 {
            let charge = if let Some(key) = self.usage_key {
                let inserted=sqlx::query("INSERT INTO upstream_usage(request_id,account_id,units) VALUES($1,$2,$3) ON CONFLICT DO NOTHING")
                    .bind(key).bind(self.account_id).bind(used).execute(&mut *tx).await?;
                if inserted.rows_affected() == 0 {
                    let matches: bool = sqlx::query_scalar(
                        "SELECT account_id=$2 AND units=$3 FROM upstream_usage WHERE request_id=$1",
                    )
                    .bind(key)
                    .bind(self.account_id)
                    .bind(used)
                    .fetch_one(&mut *tx)
                    .await?;
                    if !matches {
                        return Err(Error::Store);
                    }
                }
                inserted.rows_affected() == 1
            } else {
                true
            };
            if charge {
                sqlx::query("UPDATE upstream_accounts SET quota_remaining=greatest(quota_remaining-$2,0),status=CASE WHEN status='ACTIVE' AND quota_remaining<=$2 THEN 'QUOTA_EXHAUSTED' ELSE status END WHERE id=$1")
                .bind(self.account_id).bind(used as i64).execute(&mut *tx).await?;
            }
        }
        if revision == self.revision {
            if let Some(failure) = &failure {
                let failures: i32 = current.get("consecutive_failures");
                let next = (failures + 1).min(1_000_000);
                match failure.code {
                    FailureCode::AccountInvalid => {
                        sqlx::query("UPDATE upstream_accounts SET status=CASE WHEN status='DISABLED' THEN status ELSE 'INVALID' END,last_error='ACCOUNT_INVALID' WHERE id=$1").bind(self.account_id).execute(&mut *tx).await?;
                    }
                    FailureCode::RateLimited => {
                        let reset: Option<chrono::DateTime<Utc>> = current.get("quota_reset_at");
                        let cooldown = failure
                            .retry_after
                            .unwrap_or_else(|| {
                                reset
                                    .map(|r| (r - Utc::now()).num_seconds().max(1) as u64)
                                    .unwrap_or(3600)
                            })
                            .clamp(1, 86400) as i32;
                        sqlx::query("UPDATE upstream_accounts SET status=CASE WHEN status='DISABLED' THEN status WHEN $2 THEN 'QUOTA_EXHAUSTED' ELSE 'COOLDOWN' END,quota_remaining=CASE WHEN $2 THEN 0 ELSE quota_remaining END,cooldown_until=clock_timestamp()+make_interval(secs=>$3),last_error='RATE_LIMITED' WHERE id=$1")
                            .bind(self.account_id).bind(failure.quota_exhausted).bind(cooldown as f64).execute(&mut *tx).await?;
                    }
                    FailureCode::UpstreamError => {
                        let cooldown = (300u64 * 2u64.pow((next.saturating_sub(3) as u32).min(4)))
                            .min(3600) as f64;
                        sqlx::query("UPDATE upstream_accounts SET consecutive_failures=$2,last_error='UPSTREAM_ERROR',status=CASE WHEN status IN ('INVALID','DISABLED') THEN status WHEN $2>=3 THEN 'COOLDOWN' ELSE status END,cooldown_until=CASE WHEN $2>=3 THEN clock_timestamp()+make_interval(secs=>$3) ELSE cooldown_until END WHERE id=$1")
                            .bind(self.account_id).bind(next).bind(cooldown).execute(&mut *tx).await?;
                    }
                    FailureCode::ContentPolicy | FailureCode::BadRequest => {}
                }
            } else {
                sqlx::query("UPDATE upstream_accounts SET consecutive_failures=0,last_error=NULL,quota_remaining=CASE WHEN $2 AND status='QUOTA_EXHAUSTED' AND quota_reset_at<=clock_timestamp() THEN quota_total ELSE quota_remaining END,quota_reset_at=CASE WHEN $2 AND status='QUOTA_EXHAUSTED' AND quota_reset_at<=clock_timestamp() THEN NULL ELSE quota_reset_at END,status=CASE WHEN $2 AND status<>'DISABLED' AND (quota_remaining>0 OR (status='QUOTA_EXHAUSTED' AND quota_reset_at<=clock_timestamp())) THEN 'ACTIVE' ELSE status END,cooldown_until=CASE WHEN $2 THEN NULL ELSE cooldown_until END WHERE id=$1")
                    .bind(self.account_id).bind(recover).execute(&mut *tx).await?;
            }
        }
        let code = failure
            .as_ref()
            .map(|f| f.code.as_str())
            .unwrap_or("SUCCESS");
        sqlx::query("INSERT INTO upstream_attempts(account_id,operation,code,elapsed_ms) VALUES($1,$2,$3,$4)")
            .bind(self.account_id).bind(operation).bind(code).bind(elapsed.clamp(0,3_600_000)).execute(&mut *tx).await?;
        if let Some(actor) = actor {
            let after = serde_json::to_value(account_in(&mut *tx, self.account_id).await?)
                .map_err(|_| Error::Store)?;
            audit(
                &mut tx,
                actor,
                "upstream.account.test",
                &self.account_id.to_string(),
                before.unwrap_or(serde_json::Value::Null),
                after,
            )
            .await?;
        }
        tx.commit().await?;
        self.done = true;
        self.heartbeat.abort();
        self.valid.store(false, Ordering::Release);
        self.slots.release(self.account_id, &self.member).await?;
        Ok(())
    }
}
impl UpstreamService {
    pub async fn acquire_avoiding(
        &self,
        model: &str,
        requirements: &RouteRequirements,
        exclude: &HashSet<Uuid>,
    ) -> Result<RouteLease, Error> {
        self.acquire_excluding(model, requirements, exclude).await
    }
    pub async fn resume_on(
        &self,
        account: Uuid,
        model: &str,
        requirements: &RouteRequirements,
    ) -> Result<RouteLease, Error> {
        let snapshot = self.snapshot(model).await?;
        validate_requirements(&snapshot, requirements)?;
        let units = if snapshot.kind == "video" {
            requirements.seconds.ok_or(Error::Validation)? as i32
        } else {
            requirements.n as i32
        };
        self.claim(account, Some((model, snapshot)), units, false, false)
            .await?
            .ok_or(Error::NoCapacity)
    }
    pub fn with_slots(mut self, slots: SlotStore) -> Self {
        Arc::make_mut(&mut self.inner).slots = Some(slots);
        self
    }
    pub fn with_provider(mut self, provider: Arc<dyn Provider>) -> Self {
        Arc::make_mut(&mut self.inner).provider = provider;
        self
    }
    async fn snapshot(&self, id: &str) -> Result<ModelSnapshot, Error> {
        let row = sqlx::query(
            "SELECT kind,capabilities,upstream_model,revision FROM models WHERE id=$1 AND enabled=true",
        )
        .bind(id)
        .fetch_optional(&self.inner.db)
        .await?
        .ok_or(Error::NotFound)?;
        let caps: Capabilities =
            serde_json::from_value(row.get("capabilities")).map_err(|_| Error::Store)?;
        Ok(ModelSnapshot {
            kind: row.get("kind"),
            caps,
            upstream: row.get("upstream_model"),
            revision: row.get("revision"),
        })
    }
    pub async fn acquire(
        &self,
        model_id: &str,
        requirements: &RouteRequirements,
    ) -> Result<RouteLease, Error> {
        self.acquire_excluding(model_id, requirements, &HashSet::new())
            .await
    }
    async fn acquire_excluding(
        &self,
        model_id: &str,
        requirements: &RouteRequirements,
        exclude: &HashSet<Uuid>,
    ) -> Result<RouteLease, Error> {
        let model = self.snapshot(model_id).await?;
        validate_requirements(&model, requirements)?;
        let units = if model.kind == "video" {
            requirements.seconds.ok_or(Error::Validation)? as i32
        } else {
            requirements.n as i32
        };
        let rows:Vec<Candidate>=sqlx::query_as("SELECT a.id,a.priority,a.weight,a.concurrency_limit,a.quota_total,a.quota_remaining FROM upstream_accounts a JOIN models m ON m.id=$1 WHERE a.deleted_at IS NULL AND a.status='ACTIVE' AND (a.cooldown_until IS NULL OR a.cooldown_until<=clock_timestamp()) AND a.quota_remaining>0 AND (a.group_tag=ANY(m.group_tags) OR EXISTS(SELECT 1 FROM account_models b WHERE b.account_id=a.id AND b.model_id=$1)) ORDER BY a.priority,a.id LIMIT 500")
            .bind(model_id).fetch_all(&self.inner.db).await?;
        let slots = self.inner.slots.as_ref().ok_or(Error::Store)?;
        let counts = slots
            .counts(&rows.iter().map(|r| r.id).collect::<Vec<_>>())
            .await?;
        if counts.len() != rows.len() {
            return Err(Error::Store);
        }
        let mut candidates = Vec::new();
        for (row, count) in rows.into_iter().zip(counts) {
            if exclude.contains(&row.id)
                || count >= row.concurrency_limit as i64
                || row.quota_remaining < units as i64
            {
                continue;
            }
            let score = row.weight as f64
                * (1. - count as f64 / row.concurrency_limit as f64)
                * (0.5 + 0.5 * row.quota_remaining as f64 / row.quota_total as f64);
            let mut salt = [0u8; 8];
            getrandom::fill(&mut salt).map_err(|_| Error::Store)?;
            candidates.push((row, score, u64::from_le_bytes(salt)));
        }
        candidates.sort_by(|a, b| {
            a.0.priority
                .cmp(&b.0.priority)
                .then_with(|| b.1.total_cmp(&a.1))
                .then_with(|| a.2.cmp(&b.2))
        });
        for (candidate, _, _) in candidates {
            let fresh_model = self.snapshot(model_id).await?;
            validate_requirements(&fresh_model, requirements)?;
            if let Some(lease) = self
                .claim(
                    candidate.id,
                    Some((model_id, fresh_model)),
                    units,
                    false,
                    false,
                )
                .await?
            {
                return Ok(lease);
            }
        }
        Err(Error::NoCapacity)
    }
    async fn claim(
        &self,
        account: Uuid,
        model: Option<(&str, ModelSnapshot)>,
        units: i32,
        probe: bool,
        automatic: bool,
    ) -> Result<Option<RouteLease>, Error> {
        let slots = self.inner.slots.clone().ok_or(Error::Store)?;
        let mut tx = self.inner.db.begin().await?;
        if let Some((id, snapshot)) = &model {
            if sqlx::query(
                "SELECT id FROM models WHERE id=$1 AND enabled=true AND revision=$2 FOR SHARE",
            )
            .bind(id)
            .bind(snapshot.revision)
            .fetch_optional(&mut *tx)
            .await?
            .is_none()
            {
                return Ok(None);
            }
        }
        let row=sqlx::query("SELECT id,base_url,secret_enc,revision,concurrency_limit,quota_remaining,status,deleted_at,cooldown_until,quota_reset_at FROM upstream_accounts WHERE id=$1 FOR UPDATE").bind(account).fetch_optional(&mut *tx).await?.ok_or(Error::NotFound)?;
        let deleted: Option<chrono::DateTime<Utc>> = row.get("deleted_at");
        let status: String = row.get("status");
        let cooldown: Option<chrono::DateTime<Utc>> = row.get("cooldown_until");
        let reset: Option<chrono::DateTime<Utc>> = row.get("quota_reset_at");
        if automatic
            && !((status == "COOLDOWN" && cooldown.is_some_and(|d| d <= Utc::now()))
                || (status == "QUOTA_EXHAUSTED" && reset.is_some_and(|d| d <= Utc::now())))
        {
            return Ok(None);
        }
        if deleted.is_some()
            || (!probe && (status != "ACTIVE" || cooldown.is_some_and(|d| d > Utc::now())))
        {
            return Ok(None);
        }
        if let Some((model_id, _)) = &model {
            let bound:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM models m JOIN upstream_accounts a ON a.id=$2 WHERE m.id=$1 AND (a.group_tag=ANY(m.group_tags) OR EXISTS(SELECT 1 FROM account_models b WHERE b.account_id=a.id AND b.model_id=m.id)))").bind(model_id).bind(account).fetch_one(&mut *tx).await?;
            if !bound {
                return Ok(None);
            }
        }
        let reserved:i64=sqlx::query_scalar("SELECT coalesce(sum(units),0)::bigint FROM upstream_leases WHERE account_id=$1 AND completed=false AND expires_at>clock_timestamp()").bind(account).fetch_one(&mut *tx).await?;
        if !probe && row.get::<i64, _>("quota_remaining") - reserved < units as i64 {
            return Ok(None);
        }
        let revision: i64 = row.get("revision");
        let encrypted: Vec<u8> = row.get("secret_enc");
        let secret = self.inner.cipher.open(account, &encrypted)?;
        let id = Uuid::new_v4();
        let token = Uuid::new_v4();
        let member = format!("{id}:{token}");
        if !slots
            .claim(account, &member, row.get("concurrency_limit"), 60)
            .await?
        {
            return Ok(None);
        }
        let mut pending = PendingSlot {
            slots: slots.clone(),
            account,
            member: member.clone(),
            armed: true,
        };
        sqlx::query("INSERT INTO upstream_leases(id,account_id,token,account_revision,units,expires_at) VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '60 seconds')")
            .bind(id).bind(account).bind(token).bind(revision).bind(units).execute(&mut *tx).await?;
        sqlx::query("UPDATE upstream_accounts SET last_used_at=clock_timestamp() WHERE id=$1")
            .bind(account)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        let valid = Arc::new(AtomicBool::new(true));
        let heartbeat = heartbeat(
            self.clone(),
            slots.clone(),
            account,
            id,
            token,
            member.clone(),
            valid.clone(),
        );
        pending.armed = false;
        let model = model.map(|(_, m)| m);
        let upstream = model
            .as_ref()
            .map(|m| m.upstream.clone())
            .unwrap_or_default();
        Ok(Some(RouteLease {
            account_id: account,
            service: self.clone(),
            slots,
            id,
            token,
            member,
            revision,
            units,
            context: ProviderAccount {
                base_url: row.get("base_url"),
                secret,
                upstream_model: upstream,
            },
            model,
            valid,
            heartbeat,
            done: false,
            usage_key: None,
        }))
    }
    pub async fn probe(&self, actor: Uuid, id: Uuid) -> Result<ProbeResult, Error> {
        let tx = self.admin_tx(actor).await?;
        tx.commit().await?;
        self.do_probe(id, Some(actor)).await
    }
    async fn do_probe(&self, id: Uuid, actor: Option<Uuid>) -> Result<ProbeResult, Error> {
        let lease = self
            .claim(id, None, 0, true, actor.is_none())
            .await?
            .ok_or(Error::NoCapacity)?;
        let started = Instant::now();
        let result = tokio::select! {result=self.inner.provider.probe(&lease.context)=>result,_=lease.invalid()=>Err(Error::Store)};
        let result = upstream_only(result)?;
        let failure = result.as_ref().err().map(error_failure);
        let elapsed = started.elapsed().as_millis() as i64;
        let code = failure.as_ref().map(|f| f.code);
        lease
            .finish(failure, 0, "probe", elapsed, actor, true)
            .await?;
        Ok(ProbeResult {
            ok: result.is_ok(),
            code,
            elapsed_ms: elapsed,
        })
    }
    pub async fn run_image(
        &self,
        id: &str,
        input: ImageRequest,
    ) -> Result<Vec<MediaOutput>, Error> {
        validate_prompt(&input.prompt)?;
        let req = RouteRequirements {
            quality: input.quality.clone(),
            ratio: input.ratio.clone(),
            resolution: input.resolution.clone(),
            n: input.n,
            reference_count: input
                .references
                .len()
                .try_into()
                .map_err(|_| Error::Validation)?,
            seconds: None,
        };
        let mut exclude = HashSet::new();
        let mut last = None;
        for _ in 0..3 {
            let lease = match self.acquire_excluding(id, &req, &exclude).await {
                Ok(lease) => lease,
                Err(Error::NoCapacity) if last.is_some() => break,
                Err(error) => return Err(error),
            };
            exclude.insert(lease.account_id);
            let model = lease.model.as_ref().ok_or(Error::Store)?;
            if model.kind != "image" {
                return Err(Error::Validation);
            }
            let size =
                crate::validation::size_for("image", &input.ratio, &input.resolution, &model.caps)?;
            let started = Instant::now();
            let result = tokio::select! {result=self.inner.provider.images(&lease.context,&input,&size)=>result,_=lease.invalid()=>Err(Error::Store)};
            let result = upstream_only(result)?;
            let failure = result.as_ref().err().map(error_failure);
            let retry = failure
                .as_ref()
                .is_some_and(|f| f.code.retryable() && !f.produced);
            let used = result.as_ref().map(|v| v.len() as i32).unwrap_or(0);
            lease
                .finish(
                    failure,
                    used,
                    "image",
                    started.elapsed().as_millis() as i64,
                    None,
                    false,
                )
                .await?;
            match result {
                Ok(outputs) => return Ok(outputs),
                Err(error) => {
                    last = Some(error);
                    if !retry {
                        break;
                    }
                }
            }
        }
        Err(last.unwrap_or(Error::NoCapacity))
    }
    pub async fn run_video(&self, id: &str, input: VideoRequest) -> Result<MediaOutput, Error> {
        validate_prompt(&input.prompt)?;
        let req = RouteRequirements {
            quality: "standard".into(),
            ratio: input.ratio.clone(),
            resolution: input.resolution.clone(),
            n: 1,
            reference_count: u8::from(input.reference.is_some()),
            seconds: Some(input.seconds),
        };
        let mut excluded = HashSet::new();
        let mut last = None;
        for _ in 0..3 {
            let lease = match self.acquire_excluding(id, &req, &excluded).await {
                Ok(lease) => lease,
                Err(Error::NoCapacity) if last.is_some() => break,
                Err(error) => return Err(error),
            };
            excluded.insert(lease.account_id);
            let model = lease.model.as_ref().ok_or(Error::Store)?;
            if model.kind != "video" {
                return Err(Error::Validation);
            }
            let size =
                crate::validation::size_for("video", &input.ratio, &input.resolution, &model.caps)?;
            let started = Instant::now();
            let accepted = AtomicBool::new(false);
            let operation = async {
                let job = self
                    .inner
                    .provider
                    .submit_video(&lease.context, &input, &size)
                    .await?;
                accepted.store(true, Ordering::Release);
                let mut errors = 0;
                loop {
                    match self.inner.provider.poll_video(&lease.context, &job).await {
                        Ok(VideoStatus::Complete) => {
                            return self
                                .inner
                                .provider
                                .video_content(&lease.context, &job)
                                .await
                        }
                        Ok(VideoStatus::Pending(_)) => {
                            errors = 0;
                        }
                        Err(error) => {
                            let failure = error_failure(&error);
                            errors += 1;
                            if !failure.code.retryable() || errors >= 3 {
                                return Err(error);
                            }
                        }
                    }
                    tokio::time::sleep(Duration::from_secs(2)).await;
                }
            };
            let result = tokio::select! {result=tokio::time::timeout(Duration::from_secs(300),operation)=>result.unwrap_or_else(|_|Err(Error::Provider(ProviderFailure::network()))),_=lease.invalid()=>Err(Error::Store)};
            let result = upstream_only(result)?;
            let failure = result.as_ref().err().map(|e| {
                let mut f = error_failure(e);
                f.produced |= accepted.load(Ordering::Acquire);
                f
            });
            let retry = failure
                .as_ref()
                .is_some_and(|f| f.code.retryable() && !f.produced);
            let used = if result.is_ok() {
                input.seconds as i32
            } else {
                0
            };
            lease
                .finish(
                    failure,
                    used,
                    "video",
                    started.elapsed().as_millis() as i64,
                    None,
                    false,
                )
                .await?;
            match result {
                Ok(output) => return Ok(output),
                Err(error) => {
                    last = Some(error);
                    if !retry {
                        break;
                    }
                }
            }
        }
        Err(last.unwrap_or(Error::NoCapacity))
    }
    pub async fn recover_due(&self) -> Result<u64, Error> {
        let ids:Vec<Uuid>=sqlx::query_scalar("SELECT id FROM upstream_accounts WHERE deleted_at IS NULL AND ((status='COOLDOWN' AND cooldown_until<=clock_timestamp()) OR (status='QUOTA_EXHAUSTED' AND quota_reset_at<=clock_timestamp())) ORDER BY id LIMIT 50").fetch_all(&self.inner.db).await?;
        let mut count = 0;
        for id in ids {
            if self.do_probe(id, None).await.is_ok_and(|r| r.ok) {
                count += 1;
            }
        }
        sqlx::query("UPDATE upstream_leases SET completed=true WHERE completed=false AND expires_at<=clock_timestamp()").execute(&self.inner.db).await?;
        sqlx::query(
            "DELETE FROM upstream_attempts WHERE created_at<clock_timestamp()-interval '7 days'",
        )
        .execute(&self.inner.db)
        .await?;
        sqlx::query("DELETE FROM upstream_leases WHERE completed=true AND created_at<clock_timestamp()-interval '7 days'").execute(&self.inner.db).await?;
        Ok(count)
    }
    pub async fn maintenance_loop(self) {
        let mut interval = tokio::time::interval(Duration::from_secs(300));
        loop {
            interval.tick().await;
            if self.recover_due().await.is_err() {
                tracing::error!("Upstream health recovery unavailable");
            }
        }
    }
}
fn validate_prompt(prompt: &str) -> Result<(), Error> {
    if prompt.trim().is_empty() || prompt.chars().count() > 4000 || prompt.contains('\0') {
        return Err(Error::Validation);
    }
    Ok(())
}
fn validate_requirements(model: &ModelSnapshot, input: &RouteRequirements) -> Result<(), Error> {
    if !model.caps.qualities.contains(&input.quality)
        || !model.caps.resolutions.contains(&input.resolution)
        || input.n == 0
        || input.n > model.caps.max_n
        || input.reference_count > model.caps.max_refs
        || (!model.caps.ratios.is_empty() && !model.caps.ratios.contains(&input.ratio))
        || (model.kind == "image" && input.reference_count > 0 && !model.caps.supports_edit)
        || (model.kind == "video"
            && !input
                .seconds
                .is_some_and(|s| model.caps.seconds.contains(&s)))
    {
        return Err(Error::Validation);
    }
    Ok(())
}
fn error_failure(error: &Error) -> ProviderFailure {
    match error {
        Error::Provider(f) => f.clone(),
        _ => {
            let mut f = ProviderFailure::network();
            f.produced = true;
            f
        }
    }
}
// Local validation, transport capacity and storage errors are not upstream health events.
// Returning early drops the lease and releases capacity without cooling a healthy account.
fn upstream_only<T>(result: Result<T, Error>) -> Result<Result<T, Error>, Error> {
    match result {
        Err(error) if !matches!(&error, Error::Provider(_)) => Err(error),
        result => Ok(result),
    }
}
fn heartbeat(
    service: UpstreamService,
    slots: SlotStore,
    account: Uuid,
    id: Uuid,
    token: Uuid,
    member: String,
    valid: Arc<AtomicBool>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(20)).await;
            let renewed=tokio::time::timeout(Duration::from_secs(5),async{
            if !slots.renew(account,&member,60).await?{return Err(Error::Store);}
            let result=sqlx::query("UPDATE upstream_leases SET expires_at=clock_timestamp()+interval '60 seconds' WHERE id=$1 AND token=$2 AND completed=false AND expires_at>clock_timestamp()").bind(id).bind(token).execute(&service.inner.db).await?;
            if result.rows_affected()!=1{return Err(Error::Store);}Ok::<_,Error>(())
        }).await;
            if !matches!(renewed, Ok(Ok(()))) {
                valid.store(false, Ordering::Release);
                let _ = slots.release(account, &member).await;
                break;
            }
        }
    })
}
