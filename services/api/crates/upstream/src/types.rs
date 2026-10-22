use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum FailureCode {
    AccountInvalid,
    RateLimited,
    UpstreamError,
    ContentPolicy,
    BadRequest,
}
impl FailureCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AccountInvalid => "ACCOUNT_INVALID",
            Self::RateLimited => "RATE_LIMITED",
            Self::UpstreamError => "UPSTREAM_ERROR",
            Self::ContentPolicy => "CONTENT_POLICY",
            Self::BadRequest => "BAD_REQUEST",
        }
    }
    pub fn retryable(self) -> bool {
        matches!(
            self,
            Self::AccountInvalid | Self::RateLimited | Self::UpstreamError
        )
    }
}
#[derive(Clone, Debug)]
pub struct ProviderFailure {
    pub code: FailureCode,
    pub retry_after: Option<u64>,
    pub quota_exhausted: bool,
    pub produced: bool,
}
impl ProviderFailure {
    pub fn network() -> Self {
        Self {
            code: FailureCode::UpstreamError,
            retry_after: None,
            quota_exhausted: false,
            produced: false,
        }
    }
}
#[derive(Clone, Serialize, Deserialize, ToSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Capabilities {
    #[serde(default)]
    pub qualities: Vec<String>,
    #[serde(default)]
    pub ratios: Vec<String>,
    #[serde(default)]
    pub resolutions: Vec<String>,
    #[serde(default = "one")]
    pub max_n: u8,
    #[serde(default)]
    pub max_refs: u8,
    #[serde(default = "flex")]
    pub size_mode: String,
    #[serde(default)]
    pub sizes: Vec<String>,
    #[serde(default)]
    pub seconds: Vec<u32>,
    #[serde(default)]
    pub supports_edit: bool,
}
fn one() -> u8 {
    1
}
fn flex() -> String {
    "flex".into()
}
#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct AccountInput {
    pub name: String,
    #[schema(write_only)]
    pub base_url: Option<String>,
    #[schema(write_only)]
    pub secret: Option<String>,
    pub group_tag: String,
    pub priority: i32,
    pub weight: i32,
    pub concurrency_limit: i32,
    pub quota_total: i64,
    pub quota_remaining: i64,
    pub quota_reset_at: Option<DateTime<Utc>>,
    pub enabled: bool,
    pub revision: Option<i64>,
}
#[derive(Clone, Serialize, Deserialize, ToSchema, sqlx::FromRow)]
pub struct AccountView {
    pub id: Uuid,
    pub name: String,
    pub kind: String,
    pub secret_last4: String,
    pub endpoint_configured: bool,
    pub group_tag: String,
    pub priority: i32,
    pub weight: i32,
    pub concurrency_limit: i32,
    pub quota_total: i64,
    pub quota_remaining: i64,
    pub quota_reset_at: Option<DateTime<Utc>>,
    pub status: String,
    pub cooldown_until: Option<DateTime<Utc>>,
    pub consecutive_failures: i32,
    pub last_error: Option<String>,
    pub last_used_at: Option<DateTime<Utc>>,
    pub revision: i64,
    pub in_flight: i64,
    pub requests_24h: i64,
    pub successes_24h: i64,
    pub average_ms: Option<f64>,
    pub created_at: DateTime<Utc>,
}
#[derive(Serialize, ToSchema)]
pub struct AccountPage {
    pub items: Vec<AccountView>,
    pub next_cursor: Option<Uuid>,
}
#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct QuotaInput {
    pub revision: i64,
    pub quota_total: i64,
    pub quota_remaining: i64,
    pub quota_reset_at: Option<DateTime<Utc>>,
}
#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ModelInput {
    pub id: String,
    pub kind: String,
    pub display_name: String,
    #[schema(write_only)]
    pub upstream_model: Option<String>,
    pub enabled: bool,
    pub capabilities: Capabilities,
    pub sort_order: i32,
    pub revision: Option<i64>,
}
#[derive(Clone, Serialize, Deserialize, ToSchema)]
pub struct ModelView {
    pub id: String,
    pub kind: String,
    pub display_name: String,
    pub enabled: bool,
    pub upstream_configured: bool,
    pub capabilities: Capabilities,
    pub sort_order: i32,
    pub revision: i64,
    pub account_ids: Vec<Uuid>,
    pub group_tags: Vec<String>,
}
#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct BindingInput {
    pub revision: i64,
    pub account_ids: Vec<Uuid>,
    pub group_tags: Vec<String>,
}
#[derive(Clone, Serialize, Deserialize, ToSchema, sqlx::FromRow)]
#[serde(deny_unknown_fields)]
pub struct PriceRule {
    pub model_id: String,
    pub quality: String,
    pub base_credits: i32,
    pub edit_surcharge: i32,
}
#[derive(Clone, Serialize, Deserialize, ToSchema, sqlx::FromRow)]
#[serde(deny_unknown_fields)]
pub struct SizeMultiplier {
    pub resolution: String,
    pub multiplier: i32,
}
#[derive(Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct Pricing {
    pub revision: i64,
    pub rules: Vec<PriceRule>,
    pub multipliers: Vec<SizeMultiplier>,
}
#[derive(Serialize, ToSchema)]
pub struct ProbeResult {
    pub ok: bool,
    pub code: Option<FailureCode>,
    pub elapsed_ms: i64,
}
#[derive(Serialize, ToSchema)]
pub struct AccountStats {
    pub total: i64,
    pub successes: i64,
    pub average_ms: Option<f64>,
    pub errors: Vec<ErrorCount>,
}
#[derive(Serialize, ToSchema, sqlx::FromRow)]
pub struct ErrorCount {
    pub code: String,
    pub count: i64,
}

#[derive(Serialize, ToSchema)]
pub struct CatalogModel {
    pub id: String,
    pub kind: String,
    pub display_name: String,
    pub capabilities: Capabilities,
    pub prices: Vec<PriceRule>,
}
#[derive(Serialize, ToSchema)]
pub struct Catalog {
    pub models: Vec<CatalogModel>,
    pub multipliers: Vec<SizeMultiplier>,
}
