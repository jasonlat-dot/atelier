use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;
#[derive(Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct Reference {
    pub asset_id: Uuid,
    pub role: String,
}
#[derive(Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct JobInput {
    pub model_id: String,
    pub prompt: String,
    pub quality: String,
    pub ratio: String,
    pub resolution: String,
    pub n: u8,
    #[serde(default)]
    pub references: Vec<Reference>,
    pub seconds: Option<u32>,
    pub project_id: Option<Uuid>,
    pub node_id: Option<String>,
}
#[derive(Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct QuoteInput {
    pub model_id: String,
    pub quality: String,
    pub ratio: String,
    pub resolution: String,
    pub n: u8,
    pub ref_count: u8,
    pub seconds: Option<u32>,
}
impl JobInput {
    pub fn quote(&self) -> QuoteInput {
        QuoteInput {
            model_id: self.model_id.clone(),
            quality: self.quality.clone(),
            ratio: self.ratio.clone(),
            resolution: self.resolution.clone(),
            n: self.n,
            ref_count: self.references.len().try_into().unwrap_or(u8::MAX),
            seconds: self.seconds,
        }
    }
}
#[derive(Clone, Serialize, Deserialize, ToSchema)]
pub struct Quote {
    pub kind: String,
    pub cost: i64,
    pub cost_per_output: i64,
    pub size: String,
    pub model_revision: i64,
    pub pricing_revision: i64,
    pub timeout_seconds: u64,
}
#[derive(Clone, Serialize, Deserialize, ToSchema)]
pub struct JobParams {
    pub quality: String,
    pub ratio: String,
    pub resolution: String,
    pub references: Vec<Reference>,
    pub seconds: Option<u32>,
}
#[derive(Serialize, ToSchema)]
pub struct JobOutput {
    pub idx: i32,
    pub asset: atelier_assets::AssetView,
}
#[derive(Serialize, ToSchema)]
pub struct JobView {
    pub id: Uuid,
    pub kind: String,
    pub model_id: String,
    pub display_name: String,
    pub prompt: String,
    pub params: JobParams,
    pub size: String,
    pub n: i32,
    pub cost: i64,
    pub cost_per_output: i64,
    pub settled: i64,
    pub released: i64,
    pub status: String,
    pub error_code: Option<String>,
    pub attempts: i32,
    pub progress: i32,
    pub cancel_requested: bool,
    pub outputs: Vec<JobOutput>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
}
#[derive(Serialize, ToSchema)]
pub struct JobReceipt {
    pub job: JobView,
}
#[derive(Serialize, ToSchema)]
pub struct JobPage {
    pub items: Vec<JobView>,
    pub next_cursor: Option<Uuid>,
}
#[derive(Clone, Serialize, Deserialize, ToSchema, sqlx::FromRow)]
pub struct JobEvent {
    pub seq: i64,
    pub job_id: Uuid,
    pub payload: serde_json::Value,
    pub created_at: DateTime<Utc>,
}
#[derive(Serialize, ToSchema)]
pub struct GenerationLimits {
    pub tier: String,
    pub max_resolution: String,
    pub max_active_jobs: i64,
    pub video_enabled: bool,
}
#[derive(Serialize, Deserialize, ToSchema)]
pub struct GenerationEvent {
    pub job_id: Uuid,
    pub status: String,
    pub progress: i32,
    pub cancel_requested: bool,
    pub error_code: Option<String>,
    pub outputs: Vec<EventOutput>,
}
#[derive(Serialize, Deserialize, ToSchema)]
pub struct EventOutput {
    pub idx: i32,
    pub asset_id: Uuid,
    pub url: Option<String>,
    pub width: Option<i32>,
    pub height: Option<i32>,
}
