use crate::{
    service::{event, terminal_failure},
    *,
};
use atelier_assets::AssetService;
use atelier_upstream::{
    provider::{ImageRequest, MediaOutput, ReferenceImage, VideoRequest, VideoStatus},
    Error as UpstreamError, ProviderFailure, RouteLease, RouteRequirements, UpstreamService,
};
use atelier_wallet::{Operation, WalletService};
use chrono::{DateTime, Utc};
use sqlx::{Postgres, Row, Transaction};
use std::{collections::HashSet, time::Duration};
use uuid::Uuid;
#[derive(Clone, sqlx::FromRow)]
struct Work {
    id: Uuid,
    owner_id: Uuid,
    model_id: String,
    model_revision: i64,
    kind: String,
    prompt: String,
    params: sqlx::types::Json<JobParams>,
    size: String,
    n: i32,
    attempts: i32,
    account_id: Option<Uuid>,
    account_revision: Option<i64>,
    upstream_job_id: Option<String>,
    dispatch_started: bool,
    usage_key: Option<Uuid>,
    retry_reserved: bool,
    lease_token: Uuid,
    created_at: DateTime<Utc>,
    run_deadline: Option<DateTime<Utc>>,
    cost: i64,
    cost_per_output: i64,
}
#[derive(Clone)]
pub struct GenerationWorker {
    service: GenerationService,
    upstream: UpstreamService,
    name: String,
}
enum Control {
    Lost,
    Cancel,
}
impl GenerationWorker {
    pub fn new(service: GenerationService, upstream: UpstreamService) -> Self {
        Self {
            service,
            upstream,
            name: format!("generation:{}", Uuid::new_v4()),
        }
    }
    pub async fn run(self) {
        let mut tasks = tokio::task::JoinSet::new();
        for _ in 0..4 {
            let worker = self.clone();
            tasks.spawn(async move{loop{match worker.run_once().await{Ok(true)=>continue,Ok(false)=>{},Err(_)=>tracing::error!("Generation worker operation unavailable")};tokio::select!{_=worker.service.wake.notified()=>{},_=tokio::time::sleep(Duration::from_secs(2))=>{}}}});
        }
        let mut recovery = tokio::time::interval(Duration::from_secs(30));
        // A crashed worker is restarted; its fenced database lease is recovered separately.
        loop {
            tokio::select! {
            _=recovery.tick()=>{if self.recover_expired().await.is_err(){tracing::error!("Generation recovery unavailable");}},
            result=tasks.join_next()=>{
            if matches!(result,Some(Err(_))) {
                let worker = self.clone();
                tasks.spawn(async move {
                    loop {
                        let _ = worker.run_once().await;
                        tokio::time::sleep(Duration::from_secs(2)).await;
                    }
                });
            }
            }
            }
        }
    }
    pub async fn run_once(&self) -> Result<bool, GenerationError> {
        let token = Uuid::new_v4();
        let work:Option<Work>=sqlx::query_as("WITH pick AS (SELECT id FROM generation_jobs WHERE finished_at IS NULL AND status IN ('QUEUED','ROUTING') AND lease_until IS NULL AND next_attempt_at<=clock_timestamp() ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED) UPDATE generation_jobs j SET locked_by=$1,lease_token=$2,lease_until=clock_timestamp()+interval '60 seconds' FROM pick WHERE j.id=pick.id RETURNING j.*")
   .bind(&self.name).bind(token).fetch_optional(&self.service.db).await?;
        let Some(work) = work else { return Ok(false) };
        tokio::select! {
         biased;
         control=self.control(&work)=>{if matches!(control,Control::Cancel){self.fail(&work,"CANCELLED",None).await?;}},
         result=self.execute(work.clone())=>result?,
        }
        Ok(true)
    }
    async fn control(&self, w: &Work) -> Control {
        let mut ticks = tokio::time::interval(Duration::from_millis(500));
        let mut last = std::time::Instant::now();
        loop {
            ticks.tick().await;
            let row=sqlx::query("SELECT j.cancel_requested,u.status='ACTIVE' AS active FROM generation_jobs j JOIN users u ON u.id=j.owner_id WHERE j.id=$1 AND j.owner_id=$2 AND j.lease_token=$3 AND j.lease_until>clock_timestamp() AND j.finished_at IS NULL")
    .bind(w.id).bind(w.owner_id).bind(w.lease_token).fetch_optional(&self.service.db).await;
            match row {
                Ok(Some(r)) => {
                    if r.get::<bool, _>("cancel_requested") || !r.get::<bool, _>("active") {
                        return Control::Cancel;
                    }
                }
                _ => return Control::Lost,
            }
            if last.elapsed() >= Duration::from_secs(20) {
                let renewed=sqlx::query("UPDATE generation_jobs SET lease_until=clock_timestamp()+interval '60 seconds' WHERE id=$1 AND lease_token=$2 AND lease_until>clock_timestamp() AND finished_at IS NULL")
     .bind(w.id).bind(w.lease_token).execute(&self.service.db).await;
                if !matches!(renewed,Ok(r) if r.rows_affected()==1) {
                    return Control::Lost;
                }
                last = std::time::Instant::now();
            }
        }
    }
    async fn locked(
        &self,
        w: &Work,
    ) -> Result<Option<(Transaction<'static, Postgres>, Work)>, GenerationError> {
        let mut tx = self.service.db.begin().await?;
        let active: Option<String> =
            sqlx::query_scalar("SELECT status FROM users WHERE id=$1 FOR UPDATE")
                .bind(w.owner_id)
                .fetch_optional(&mut *tx)
                .await?;
        if active.is_none() {
            return Ok(None);
        }
        let fresh:Option<Work>=sqlx::query_as("SELECT * FROM generation_jobs WHERE id=$1 AND owner_id=$2 AND lease_token=$3 AND lease_until>clock_timestamp() AND finished_at IS NULL FOR UPDATE")
   .bind(w.id).bind(w.owner_id).bind(w.lease_token).fetch_optional(&mut *tx).await?;
        let Some(fresh) = fresh else { return Ok(None) };
        let cancelled: bool =
            sqlx::query_scalar("SELECT cancel_requested FROM generation_jobs WHERE id=$1")
                .bind(w.id)
                .fetch_one(&mut *tx)
                .await?;
        if cancelled || active.as_deref() != Some("ACTIVE") {
            terminal_failure(
                &mut tx,
                w.owner_id,
                w.id,
                "CANCELLED",
                if active.as_deref() != Some("ACTIVE") {
                    Some("ACCOUNT_DISABLED")
                } else {
                    None
                },
            )
            .await?;
            tx.commit().await?;
            self.service
                .assets
                .discard_generated(w.owner_id, w.id)
                .await?;
            self.service.wake.notify_waiters();
            return Ok(None);
        }
        Ok(Some((tx, fresh)))
    }
    async fn status(&self, w: &Work, status: &str, progress: i32) -> Result<bool, GenerationError> {
        let Some((mut tx, _)) = self.locked(w).await? else {
            return Ok(false);
        };
        let changed=sqlx::query("UPDATE generation_jobs SET status=$2,progress=$3,updated_at=clock_timestamp() WHERE id=$1 AND (status<>$2 OR progress<>$3)").bind(w.id).bind(status).bind(progress).execute(&mut *tx).await?;
        if changed.rows_affected() > 0 {
            event(&mut tx, w.owner_id, w.id).await?;
        }
        tx.commit().await?;
        self.service.wake.notify_waiters();
        Ok(true)
    }
    async fn fail(
        &self,
        w: &Work,
        status: &str,
        code: Option<&str>,
    ) -> Result<(), GenerationError> {
        let Some((mut tx, _)) = self.locked(w).await? else {
            return Ok(());
        };
        terminal_failure(&mut tx, w.owner_id, w.id, status, code).await?;
        tx.commit().await?;
        self.service
            .assets
            .discard_generated(w.owner_id, w.id)
            .await?;
        self.service.wake.notify_waiters();
        Ok(())
    }
    async fn defer(&self, w: &Work) -> Result<(), GenerationError> {
        if (Utc::now() - w.created_at).num_seconds() >= 300 {
            return self.fail(w, "FAILED", Some("NO_CAPACITY")).await;
        }
        let Some((mut tx, _)) = self.locked(w).await? else {
            return Ok(());
        };
        sqlx::query("UPDATE generation_jobs SET status='ROUTING',next_attempt_at=clock_timestamp()+interval '2 seconds',lease_token=NULL,lease_until=NULL,locked_by=NULL,updated_at=clock_timestamp() WHERE id=$1")
   .bind(w.id).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(())
    }
    async fn start(&self, w: &Work, lease: &RouteLease) -> Result<Option<Work>, GenerationError> {
        let Some((mut tx, fresh)) = self.locked(w).await? else {
            return Ok(None);
        };
        let resume = fresh.upstream_job_id.is_some();
        let attempts = if fresh.retry_reserved || resume {
            fresh.attempts.max(1)
        } else {
            fresh.attempts + 1
        };
        if attempts > 3 {
            terminal_failure(&mut tx, w.owner_id, w.id, "FAILED", Some("WORKER_LOST")).await?;
            tx.commit().await?;
            return Ok(None);
        }
        let seconds =
            if w.kind == "video" || w.params.quality == "high" || w.params.resolution != "1K" {
                300.0
            } else {
                120.0
            };
        let result=sqlx::query_as("UPDATE generation_jobs SET status='RUNNING',progress=5,attempts=$2,retry_reserved=false,account_id=$3,account_revision=$4,usage_key=CASE WHEN $5 THEN usage_key ELSE $6 END,dispatch_started=true,tried_accounts=CASE WHEN $3=ANY(tried_accounts) THEN tried_accounts ELSE array_append(tried_accounts,$3) END,run_deadline=coalesce(run_deadline,clock_timestamp()+make_interval(secs=>$7)),updated_at=clock_timestamp() WHERE id=$1 RETURNING *")
   .bind(w.id).bind(attempts).bind(lease.account_id).bind(lease.account_revision()).bind(resume).bind(w.lease_token).bind(seconds).fetch_one(&mut *tx).await?;
        event(&mut tx, w.owner_id, w.id).await?;
        tx.commit().await?;
        self.service.wake.notify_waiters();
        Ok(Some(result))
    }
    async fn checkpoint_video(&self, w: &Work, id: &str) -> Result<bool, GenerationError> {
        let Some((mut tx, _)) = self.locked(w).await? else {
            return Ok(false);
        };
        sqlx::query("UPDATE generation_jobs SET upstream_job_id=$2,updated_at=clock_timestamp() WHERE id=$1 AND upstream_job_id IS NULL").bind(w.id).bind(id).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(true)
    }
    async fn checkpoint_output(
        &self,
        w: &Work,
        idx: i32,
        id: Uuid,
    ) -> Result<bool, GenerationError> {
        let Some((mut tx, _)) = self.locked(w).await? else {
            return Ok(false);
        };
        sqlx::query("INSERT INTO generation_outputs(job_id,idx,asset_id,attempt_token,status) VALUES($1,$2,$3,$4,'STAGED') ON CONFLICT(job_id,idx) DO UPDATE SET asset_id=EXCLUDED.asset_id,attempt_token=EXCLUDED.attempt_token WHERE generation_outputs.status='STAGED'")
   .bind(w.id).bind(idx).bind(id).bind(w.lease_token).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(true)
    }
    async fn execute(&self, mut w: Work) -> Result<(), GenerationError> {
        if !self.status(&w, "ROUTING", 0).await? {
            return Ok(());
        }
        let mut tx = self.service.db.begin().await?;
        let staged = AssetService::staged_ready_in_transaction(&mut tx, w.owner_id, w.id).await?;
        tx.commit().await?;
        if !staged.is_empty() {
            if self.status(&w, "STORING", 90).await? {
                self.complete(&w).await?;
            }
            return Ok(());
        }
        if w.kind == "video" && w.dispatch_started && w.upstream_job_id.is_none() {
            return self.fail(&w, "FAILED", Some("WORKER_LOST")).await;
        }
        if w.run_deadline.is_some_and(|d| d <= Utc::now()) {
            return self.fail(&w, "FAILED", Some("TIMEOUT")).await;
        }
        let mut refs = Vec::new();
        for r in &w.params.references {
            match self
                .service
                .assets
                .reference_bytes(w.owner_id, r.asset_id)
                .await
            {
                Ok(bytes) => refs.push(ReferenceImage {
                    bytes: bytes.into(),
                    mime: "image/png".into(),
                }),
                Err(_) => return self.fail(&w, "FAILED", Some("ASSET_UNAVAILABLE")).await,
            }
        }
        let requirements = RouteRequirements {
            quality: w.params.quality.clone(),
            ratio: w.params.ratio.clone(),
            resolution: w.params.resolution.clone(),
            n: w.n as u8,
            reference_count: refs.len() as u8,
            seconds: w.params.seconds,
        };
        let account = if let Some(account) = w.account_id.filter(|_| w.upstream_job_id.is_some()) {
            self.upstream
                .resume_on(account, &w.model_id, &requirements)
                .await
        } else {
            let tried: Vec<Uuid> =
                sqlx::query_scalar("SELECT tried_accounts FROM generation_jobs WHERE id=$1")
                    .bind(w.id)
                    .fetch_one(&self.service.db)
                    .await?;
            self.upstream
                .acquire_avoiding(
                    &w.model_id,
                    &requirements,
                    &tried.into_iter().collect::<HashSet<_>>(),
                )
                .await
        };
        let lease = match account {
            Ok(lease) => lease,
            Err(UpstreamError::NoCapacity) => return self.defer(&w).await,
            Err(UpstreamError::Store) => return Err(GenerationError::Store),
            Err(_) => return self.fail(&w, "FAILED", Some("MODEL_UNAVAILABLE")).await,
        };
        if lease.model_revision() != Some(w.model_revision)
            || (w.upstream_job_id.is_some() && w.account_revision != Some(lease.account_revision()))
        {
            return self.fail(&w, "FAILED", Some("MODEL_UNAVAILABLE")).await;
        }
        let Some(started) = self.start(&w, &lease).await? else {
            return Ok(());
        };
        w = started;
        let timeout = (w.run_deadline.ok_or(GenerationError::Store)? - Utc::now())
            .to_std()
            .unwrap_or(Duration::ZERO);
        let accepted = std::sync::atomic::AtomicBool::new(w.upstream_job_id.is_some());
        let operation = async {
            if w.kind == "image" {
                lease
                    .image_once(
                        &ImageRequest {
                            prompt: w.prompt.clone(),
                            quality: w.params.quality.clone(),
                            ratio: w.params.ratio.clone(),
                            resolution: w.params.resolution.clone(),
                            n: w.n as u8,
                            references: refs,
                        },
                        &w.size,
                    )
                    .await
            } else {
                let id = if let Some(id) = &w.upstream_job_id {
                    id.clone()
                } else {
                    let id = lease
                        .submit_video_once(
                            &VideoRequest {
                                prompt: w.prompt.clone(),
                                ratio: w.params.ratio.clone(),
                                resolution: w.params.resolution.clone(),
                                seconds: w.params.seconds.ok_or(UpstreamError::Validation)?,
                                reference: refs.into_iter().next(),
                            },
                            &w.size,
                        )
                        .await?;
                    accepted.store(true, std::sync::atomic::Ordering::Release);
                    if !self
                        .checkpoint_video(&w, &id)
                        .await
                        .map_err(|_| UpstreamError::Store)?
                    {
                        return Err(UpstreamError::Store);
                    }
                    id
                };
                let mut failures = 0;
                loop {
                    match lease.poll_video_once(&id).await {
                        Ok(VideoStatus::Complete) => {
                            return Ok(vec![lease.fetch_video_once(&id).await?])
                        }
                        Ok(VideoStatus::Pending(progress)) => {
                            failures = 0;
                            if !self
                                .status(&w, "RUNNING", i32::from(progress).clamp(5, 85))
                                .await
                                .map_err(|_| UpstreamError::Store)?
                            {
                                return Err(UpstreamError::Store);
                            }
                        }
                        Err(UpstreamError::Provider(f)) if f.code.retryable() && failures < 2 => {
                            failures += 1;
                        }
                        Err(e) => return Err(e),
                    }
                    tokio::time::sleep(Duration::from_secs(2)).await;
                }
            }
        };
        let (result, timed_out) = match tokio::time::timeout(timeout, operation).await {
            Ok(result) => (result, false),
            Err(_) => (
                Err(UpstreamError::Provider(ProviderFailure::network())),
                true,
            ),
        };
        let outputs = match result {
            Ok(outputs) => outputs,
            Err(UpstreamError::Provider(failure)) => {
                let retry = failure.code.retryable()
                    && !failure.produced
                    && !timed_out
                    && !accepted.load(std::sync::atomic::Ordering::Acquire);
                let code = if timed_out {
                    "TIMEOUT"
                } else {
                    failure.code.as_str()
                };
                let _ = lease.finish_failure(failure, &w.kind).await;
                if retry && w.attempts < 3 {
                    return self.retry(&w).await;
                }
                return self.fail(&w, "FAILED", Some(code)).await;
            }
            Err(UpstreamError::Store) => return Err(GenerationError::Store),
            Err(_) => return self.fail(&w, "FAILED", Some("LOCAL_ERROR")).await,
        };
        let outputs: Vec<MediaOutput> = outputs.into_iter().take(w.n as usize).collect();
        let used = if w.kind == "video" {
            w.params.seconds.unwrap_or(0) as i32
        } else {
            outputs.len() as i32
        };
        if lease
            .finish_generation(w.usage_key.ok_or(GenerationError::Store)?, used, &w.kind)
            .await
            .is_err()
        {
            tracing::error!("Generation upstream usage finalization unavailable");
        }
        if !self.status(&w, "STORING", 90).await? {
            return Ok(());
        }
        for (idx, output) in outputs.into_iter().enumerate() {
            if let Ok(id) = self
                .service
                .assets
                .stage_generated(
                    w.owner_id,
                    w.id,
                    w.lease_token,
                    &w.kind,
                    &output.mime,
                    output.bytes.to_vec(),
                )
                .await
            {
                if !self.checkpoint_output(&w, idx as i32, id).await? {
                    return Ok(());
                }
            }
        }
        self.complete(&w).await
    }
    async fn retry(&self, w: &Work) -> Result<(), GenerationError> {
        let Some((mut tx, _)) = self.locked(w).await? else {
            return Ok(());
        };
        sqlx::query("UPDATE generation_jobs SET status='ROUTING',progress=0,dispatch_started=false,usage_key=NULL,lease_token=NULL,lease_until=NULL,locked_by=NULL,next_attempt_at=clock_timestamp()+interval '2 seconds',updated_at=clock_timestamp() WHERE id=$1").bind(w.id).execute(&mut *tx).await?;
        event(&mut tx, w.owner_id, w.id).await?;
        tx.commit().await?;
        self.service.wake.notify_waiters();
        Ok(())
    }
    async fn complete(&self, w: &Work) -> Result<(), GenerationError> {
        let Some((mut tx, fresh)) = self.locked(w).await? else {
            return Ok(());
        };
        let staged = AssetService::staged_ready_in_transaction(&mut tx, w.owner_id, w.id).await?;
        if staged.is_empty() {
            terminal_failure(&mut tx, w.owner_id, w.id, "FAILED", Some("STORAGE_FAILED")).await?;
            tx.commit().await?;
            self.service
                .assets
                .discard_generated(w.owner_id, w.id)
                .await?;
            self.service.wake.notify_waiters();
            return Ok(());
        }
        let ids: Vec<Uuid> = staged.iter().map(|(_, id)| *id).collect();
        AssetService::publish_generated_in_transaction(&mut tx, w.owner_id, w.id, &ids).await?;
        let settled = fresh.cost_per_output * staged.len() as i64;
        let released = fresh.cost - settled;
        for (idx, _) in staged {
            WalletService::apply_in_transaction(
                &mut tx,
                w.owner_id,
                Operation::Settle {
                    job: w.id,
                    index: idx as u32,
                    amount: fresh.cost_per_output,
                },
            )
            .await?;
        }
        if released > 0 {
            WalletService::apply_in_transaction(
                &mut tx,
                w.owner_id,
                Operation::Release {
                    job: w.id,
                    amount: released,
                },
            )
            .await?;
        }
        sqlx::query(
            "UPDATE generation_outputs SET status='READY' WHERE job_id=$1 AND asset_id=ANY($2)",
        )
        .bind(w.id)
        .bind(ids)
        .execute(&mut *tx)
        .await?;
        sqlx::query("UPDATE generation_jobs SET status=$2,settled=$3,released=$4,progress=100,finished_at=clock_timestamp(),updated_at=clock_timestamp(),lease_token=NULL,lease_until=NULL,locked_by=NULL WHERE id=$1")
   .bind(w.id).bind(if released>0{"PARTIAL"}else{"SUCCEEDED"}).bind(settled).bind(released).execute(&mut *tx).await?;
        event(&mut tx, w.owner_id, w.id).await?;
        tx.commit().await?;
        self.service.wake.notify_waiters();
        Ok(())
    }
    pub async fn recover_expired(&self) -> Result<u64, GenerationError> {
        let rows=sqlx::query("SELECT id,owner_id FROM generation_jobs WHERE finished_at IS NULL AND lease_until<=clock_timestamp() ORDER BY lease_until LIMIT 100").fetch_all(&self.service.db).await?;
        let mut count = 0;
        for row in rows {
            let id: Uuid = row.get("id");
            let owner: Uuid = row.get("owner_id");
            let mut tx = self.service.db.begin().await?;
            let active: String =
                sqlx::query_scalar("SELECT status FROM users WHERE id=$1 FOR UPDATE")
                    .bind(owner)
                    .fetch_one(&mut *tx)
                    .await?;
            let job=sqlx::query("SELECT attempts,cancel_requested,kind,dispatch_started,upstream_job_id FROM generation_jobs WHERE id=$1 AND finished_at IS NULL AND lease_until<=clock_timestamp() FOR UPDATE").bind(id).fetch_optional(&mut *tx).await?;
            let Some(job) = job else { continue };
            let attempts: i32 = job.get("attempts");
            let staged = AssetService::staged_ready_in_transaction(&mut tx, owner, id).await?;
            let cancelled = job.get::<bool, _>("cancel_requested") || active != "ACTIVE";
            if cancelled {
                terminal_failure(&mut tx, owner, id, "CANCELLED", None).await?;
            } else if staged.is_empty()
                && (attempts >= 3
                    || (job.get::<String, _>("kind") == "video"
                        && job.get::<bool, _>("dispatch_started")
                        && job.get::<Option<String>, _>("upstream_job_id").is_none()))
            {
                terminal_failure(&mut tx, owner, id, "FAILED", Some("WORKER_LOST")).await?;
            } else {
                sqlx::query("UPDATE generation_jobs SET status='QUEUED',attempts=$2,retry_reserved=true,lease_token=NULL,lease_until=NULL,locked_by=NULL,next_attempt_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1")
     .bind(id).bind(if staged.is_empty(){(attempts+1).min(3)}else{attempts}).execute(&mut *tx).await?;
                event(&mut tx, owner, id).await?;
            }
            tx.commit().await?;
            self.service.assets.discard_generated(owner, id).await?;
            count += 1;
        }
        self.service.wake.notify_waiters();
        Ok(count)
    }
}
