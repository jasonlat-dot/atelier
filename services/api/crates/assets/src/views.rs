use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

#[derive(Serialize, ToSchema)]
pub struct AssetView {
    pub id: Uuid,
    pub name: String,
    pub kind: String,
    pub source: String,
    pub state: String,
    pub error_code: Option<String>,
    pub bytes: i64,
    pub width: Option<i32>,
    pub height: Option<i32>,
    pub duration_ms: Option<i64>,
    pub media_url: Option<String>,
    pub thumbnail_url: Option<String>,
    pub expires_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}
#[derive(Serialize, ToSchema)]
pub struct AssetPage {
    pub items: Vec<AssetView>,
    pub next_cursor: Option<Uuid>,
    pub total: i64,
}
#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct DeleteAssets {
    pub ids: Vec<Uuid>,
}
#[derive(Serialize, ToSchema)]
pub struct AssetLimits {
    pub image_max_bytes: usize,
    pub video_max_bytes: usize,
    pub video_enabled: bool,
    pub max_video_seconds: u32,
}

#[derive(sqlx::FromRow)]
pub(crate) struct AssetRecord {
    pub id: Uuid,
    pub owner_id: Uuid,
    pub name: String,
    pub kind: String,
    pub source: String,
    pub state: String,
    pub error_code: Option<String>,
    pub object_key: String,
    pub thumb_key: String,
    pub bytes: i64,
    pub thumb_bytes: i64,
    pub width: Option<i32>,
    pub height: Option<i32>,
    pub duration_ms: Option<i64>,
    pub mime: String,
    pub expires_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}
