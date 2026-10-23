//! Redis carries wakeups only; PostgreSQL remains the replay authority.
use crate::{GenerationError, GenerationLimits, GenerationService};
use atelier_upstream::slots::SlotStore;
use futures_util::StreamExt;
use redis::{
    aio::{ConnectionManager, ConnectionManagerConfig},
    AsyncCommands,
};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use uuid::Uuid;
pub(crate) struct EventBus {
    client: redis::Client,
    connection: ConnectionManager,
    channel: String,
    slots: SlotStore,
    local: Arc<Semaphore>,
}
pub struct EventPermit {
    slots: SlotStore,
    owner: Uuid,
    token: String,
    live: Arc<AtomicBool>,
    renewal: tokio::task::JoinHandle<()>,
    _local: OwnedSemaphorePermit,
}
impl EventPermit {
    pub fn valid(&self) -> bool {
        self.live.load(Ordering::Acquire)
    }
}
impl Drop for EventPermit {
    fn drop(&mut self) {
        self.renewal.abort();
        let slots = self.slots.clone();
        let owner = self.owner;
        let token = self.token.clone();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let _ = slots.release(owner, &token).await;
            });
        }
    }
}
impl GenerationService {
    pub async fn with_events(mut self, url: &str, prefix: &str) -> Result<Self, GenerationError> {
        let slots = SlotStore::connect(url, &format!("{prefix}:events"))
            .await
            .map_err(|_| GenerationError::Store)?;
        let client = redis::Client::open(url).map_err(|_| GenerationError::Store)?;
        let config = ConnectionManagerConfig::new()
            .set_connection_timeout(Some(Duration::from_secs(3)))
            .set_response_timeout(Some(Duration::from_secs(3)));
        let connection = tokio::time::timeout(
            Duration::from_secs(5),
            ConnectionManager::new_with_config(client.clone(), config),
        )
        .await
        .map_err(|_| GenerationError::Store)?
        .map_err(|_| GenerationError::Store)?;
        self.bus = Some(Arc::new(EventBus {
            client,
            connection,
            channel: format!("{prefix}:job-events"),
            slots,
            local: Arc::new(Semaphore::new(128)),
        }));
        Ok(self)
    }
    pub async fn open_events(&self, owner: Uuid) -> Result<EventPermit, GenerationError> {
        let bus = self.bus.as_ref().ok_or(GenerationError::Store)?;
        let local = bus
            .local
            .clone()
            .try_acquire_owned()
            .map_err(|_| GenerationError::EventLimit)?;
        let token = Uuid::new_v4().to_string();
        if !bus
            .slots
            .claim(owner, &token, 3, 60)
            .await
            .map_err(|_| GenerationError::Store)?
        {
            return Err(GenerationError::EventLimit);
        }
        let live = Arc::new(AtomicBool::new(true));
        let alive = live.clone();
        let slots = bus.slots.clone();
        let renew_token = token.clone();
        let renewal = tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(20)).await;
                if !slots.renew(owner, &renew_token, 60).await.unwrap_or(false) {
                    alive.store(false, Ordering::Release);
                    break;
                }
            }
        });
        Ok(EventPermit {
            slots: bus.slots.clone(),
            owner,
            token,
            live,
            renewal,
            _local: local,
        })
    }
    pub async fn event_cursor(&self, owner: Uuid, requested: i64) -> Result<i64, GenerationError> {
        if requested < 0 {
            return Err(GenerationError::Validation);
        }
        let latest: i64 =
            sqlx::query_scalar("SELECT coalesce(max(seq),0) FROM job_events WHERE user_id=$1")
                .bind(owner)
                .fetch_one(&self.db)
                .await?;
        Ok(requested.min(latest))
    }
    pub async fn limits(&self) -> Result<GenerationLimits, GenerationError> {
        let settings:serde_json::Value=sqlx::query_scalar("SELECT jsonb_object_agg(key,value) FROM system_settings WHERE key IN ('free_max_resolution','max_active_jobs_free')").fetch_one(&self.db).await?;
        let resolution = settings["free_max_resolution"]
            .as_str()
            .filter(|s| ["1K", "2K", "4K"].contains(s))
            .ok_or(GenerationError::Store)?;
        let jobs = settings["max_active_jobs_free"]
            .as_i64()
            .filter(|n| (1..=64).contains(n))
            .ok_or(GenerationError::Store)?;
        Ok(GenerationLimits {
            tier: "FREE".into(),
            max_resolution: resolution.into(),
            max_active_jobs: jobs,
            video_enabled: self.assets.video_enabled(),
        })
    }
    pub async fn wait_events(&self) {
        self.wake.notified().await;
    }
    pub async fn event_loop(self) {
        let Some(bus) = self.bus.clone() else {
            return;
        };
        let publisher = async {
            loop {
                let run: Result<(), sqlx::Error> = async {
                    let mut listener = sqlx::postgres::PgListener::connect_with(&self.db).await?;
                    listener.listen("atelier_job_events").await?;
                    loop {
                        let n = listener.recv().await?;
                        if Uuid::parse_str(n.payload()).is_ok() {
                            let mut c = bus.connection.clone();
                            let sent: Result<i64, _> = c.publish(&bus.channel, n.payload()).await;
                            if sent.is_err() {
                                tracing::error!("Generation event broadcast unavailable");
                            }
                            self.wake.notify_waiters();
                        }
                    }
                }
                .await;
                if run.is_err() {
                    tracing::error!("Generation event listener unavailable");
                }
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        };
        let subscriber = async {
            loop {
                let run = async {
                    let mut subscription =
                        tokio::time::timeout(Duration::from_secs(5), bus.client.get_async_pubsub())
                            .await
                            .map_err(|_| GenerationError::Store)?
                            .map_err(|_| GenerationError::Store)?;
                    tokio::time::timeout(
                        Duration::from_secs(3),
                        subscription.subscribe(&bus.channel),
                    )
                    .await
                    .map_err(|_| GenerationError::Store)?
                    .map_err(|_| GenerationError::Store)?;
                    let mut messages = subscription.on_message();
                    while let Some(message) = messages.next().await {
                        if message
                            .get_payload::<String>()
                            .ok()
                            .and_then(|s| Uuid::parse_str(&s).ok())
                            .is_some()
                        {
                            self.wake.notify_waiters();
                        }
                    }
                    Ok::<(), GenerationError>(())
                }
                .await;
                if run.is_err() {
                    tracing::error!("Generation event subscription unavailable");
                }
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        };
        tokio::join!(publisher, subscriber);
    }
}
