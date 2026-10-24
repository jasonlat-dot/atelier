use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct WalletSummary {
    pub balance: i64,
    pub held: i64,
    pub available: i64,
    pub local_date: NaiveDate,
    pub timezone: String,
    pub checked_in_today: bool,
    pub streak: i32,
    pub next_reward: i32,
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct CheckinReceipt {
    pub local_date: NaiveDate,
    pub streak: i32,
    pub credits: i32,
    pub already_checked_in: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow, ToSchema)]
pub struct LedgerEntry {
    pub id: i64,
    pub r#type: String,
    pub balance_delta: i64,
    pub held_delta: i64,
    pub ref_type: Option<String>,
    pub ref_id: Option<String>,
    pub reason: Option<String>,
    pub created_at: DateTime<Utc>,
}
#[derive(Serialize, ToSchema)]
pub struct LedgerPage {
    pub items: Vec<LedgerEntry>,
    pub next_cursor: Option<i64>,
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct CreditReceipt {
    pub ledger_id: i64,
    pub credits: i64,
}
#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct RedeemRequest {
    pub code: String,
}
#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct AdjustRequest {
    pub amount: i64,
    pub reason: String,
}
#[derive(Deserialize, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct CreateCodesRequest {
    pub count: u32,
    pub credits: i64,
    pub max_uses: i32,
    pub expires_at: Option<DateTime<Utc>>,
}
#[derive(Serialize, ToSchema)]
pub struct CreatedCode {
    pub id: Uuid,
    pub code: String,
}
#[derive(Serialize, ToSchema)]
pub struct CreatedCodes {
    pub codes: Vec<CreatedCode>,
}
#[derive(Debug, Serialize, sqlx::FromRow, ToSchema)]
pub struct CodeInfo {
    pub id: Uuid,
    pub credits: i64,
    pub max_uses: i32,
    pub used_count: i32,
    pub expires_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub copyable: bool,
    pub disabled_at: Option<DateTime<Utc>>,
    pub deleted_at: Option<DateTime<Utc>>,
    pub revision: i64,
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct CodeStateRequest {
    pub revision: i64,
    pub disabled: bool,
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct CodeDeleteRequest {
    pub revision: i64,
}

#[derive(Serialize, sqlx::FromRow, ToSchema)]
pub struct CreditAdjustment {
    pub id: i64,
    pub user_id: String,
    pub display_name: String,
    pub email: String,
    pub operator: String,
    pub amount: i64,
    pub reason: String,
    pub created_at: DateTime<Utc>,
}
