use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::ToSchema;
use uuid::Uuid;
#[derive(Clone, Serialize, Deserialize, sqlx::FromRow, ToSchema)]
pub struct AdminUser {
    pub id: Uuid,
    pub email: String,
    pub display_name: String,
    pub role: String,
    pub status: String,
    pub disabled_reason: Option<String>,
    pub revision: i64,
    pub mfa_enabled: bool,
    pub created_at: DateTime<Utc>,
    pub last_login_at: Option<DateTime<Utc>>,
    pub balance: i64,
    pub held: i64,
    pub violations: i64,
}
#[derive(Serialize, ToSchema)]
pub struct AdminUserPage {
    pub items: Vec<AdminUser>,
    pub next_cursor: Option<Uuid>,
}
#[derive(Serialize, ToSchema)]
pub struct AdminUserDetail {
    pub adjust_limit: i64,
    pub user: AdminUser,
    pub ledger: atelier_wallet::LedgerPage,
    pub jobs: Vec<AdminJob>,
    pub sessions: Vec<AdminSession>,
}
#[derive(Serialize, sqlx::FromRow, ToSchema)]
pub struct AdminSession {
    pub id: Uuid,
    pub created_at: DateTime<Utc>,
    pub last_seen_at: DateTime<Utc>,
    pub ip: Option<String>,
    pub user_agent: Option<String>,
}
#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct AdminUserAction {
    pub revision: i64,
    pub reason: String,
    pub role: Option<String>,
}
#[derive(Clone, Serialize, Deserialize, sqlx::FromRow, ToSchema)]
pub struct AdminJob {
    pub id: Uuid,
    pub owner_id: Uuid,
    pub email: String,
    pub model_id: String,
    pub display_name: String,
    pub kind: String,
    pub status: String,
    pub cost: i64,
    pub settled: i64,
    pub released: i64,
    pub refunded: i64,
    pub progress: i32,
    pub attempts: i32,
    pub cancel_requested: bool,
    pub error_code: Option<String>,
    pub created_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
}
#[derive(Serialize, ToSchema)]
pub struct AdminJobPage {
    pub items: Vec<AdminJob>,
    pub next_cursor: Option<Uuid>,
}
#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct AdminJobAction {
    pub reason: String,
    pub expected_credits: Option<i64>,
}
#[derive(Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct AdminCostRate {
    pub model_id: String,
    pub currency: String,
    pub unit_cost_micros: i64,
}
#[derive(Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct AdminSettingsValues {
    pub registration_mode: String,
    pub registration_whitelist: Vec<String>,
    pub signup_max_per_ip_24h: i64,
    pub signup_bonus: i64,
    pub checkin_base: i64,
    pub checkin_streak_cap: i64,
    pub checkin_tz: String,
    pub free_max_resolution: String,
    pub max_active_jobs_free: i64,
    pub asset_retention_days_free: i64,
    pub chat_credits_per_message: i64,
    pub chat_context_window: i64,
    pub chat_output_tokens: i64,
    pub maintenance_mode: bool,
    pub admin_adjust_limit: i64,
    pub moderation_threshold: i64,
    pub upstream_cost_rates: Vec<AdminCostRate>,
}
#[derive(Serialize, sqlx::FromRow, ToSchema)]
pub struct AdminCostModel {
    pub id: String,
    pub display_name: String,
    pub kind: String,
}
#[derive(Serialize, ToSchema)]
pub struct AdminSettings {
    pub revision: i64,
    pub values: AdminSettingsValues,
    pub models: Vec<AdminCostModel>,
}
#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct AdminSettingsUpdate {
    pub revision: i64,
    pub values: AdminSettingsValues,
    pub reason: String,
}
#[derive(Clone, Serialize, Deserialize, sqlx::FromRow, ToSchema)]
pub struct AdminRule {
    pub id: i64,
    pub pattern: String,
    pub is_regex: bool,
    pub enabled: bool,
    pub revision: i64,
}
#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct AdminRuleInput {
    pub pattern: String,
    pub is_regex: bool,
    pub enabled: bool,
    pub revision: Option<i64>,
    pub reason: String,
}
#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct AdminRevisionReason {
    pub revision: i64,
    pub reason: String,
}
#[derive(Serialize, ToSchema)]
pub struct AdminRulePage {
    pub items: Vec<AdminRule>,
    pub next_cursor: Option<i64>,
}
#[derive(Clone, Serialize, Deserialize, sqlx::FromRow, ToSchema)]
pub struct AdminInvite {
    pub id: Uuid,
    pub label: String,
    pub last4: Option<String>,
    pub max_uses: i32,
    pub used_count: i32,
    pub expires_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub revoked_at: Option<DateTime<Utc>>,
    pub revision: i64,
}
#[derive(Serialize, ToSchema)]
pub struct AdminInvitePage {
    pub items: Vec<AdminInvite>,
    pub next_cursor: Option<Uuid>,
}
#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct AdminInviteInput {
    pub label: String,
    pub max_uses: i32,
    pub expires_at: Option<DateTime<Utc>>,
    pub reason: String,
}
#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct AdminInviteUpdate {
    pub revision: i64,
    pub details: AdminInviteInput,
}
#[derive(Serialize, ToSchema)]
pub struct AdminInviteCreated {
    pub invite: AdminInvite,
    pub code: String,
}
#[derive(Serialize, sqlx::FromRow, ToSchema)]
pub struct AdminAudit {
    pub id: i64,
    pub actor_id: Uuid,
    pub email: String,
    pub action: String,
    pub target_type: Option<String>,
    pub target_id: Option<String>,
    pub before: Value,
    pub after: Value,
    pub created_at: DateTime<Utc>,
}
#[derive(Serialize, ToSchema)]
pub struct AdminAuditPage {
    pub items: Vec<AdminAudit>,
    pub next_cursor: Option<i64>,
}
#[derive(Serialize, sqlx::FromRow, ToSchema)]
pub struct AdminDay {
    pub day: String,
    pub jobs: i64,
    pub succeeded: i64,
    pub failed: i64,
    pub consumed: i64,
}
#[derive(Serialize, sqlx::FromRow, ToSchema)]
pub struct AdminQuality {
    pub quality: String,
    pub jobs: i64,
}
#[derive(Serialize, sqlx::FromRow, ToSchema)]
pub struct AdminHealth {
    pub status: String,
    pub accounts: i64,
    pub capacity: i64,
    pub live_slots: i64,
    pub quota_remaining: i64,
}
#[derive(Serialize, sqlx::FromRow, ToSchema)]
pub struct AdminNotification {
    pub id: i64,
    pub user_id: Uuid,
    pub email: String,
    pub kind: String,
    pub violation_count: i64,
    pub created_at: DateTime<Utc>,
}
#[derive(Serialize, ToSchema)]
pub struct AdminEstimate {
    pub currency: String,
    pub amount_micros: i64,
}
#[derive(Serialize, sqlx::FromRow, ToSchema)]
pub struct AdminOrderAmount {
    pub currency: String,
    pub amount_cents: i64,
}
#[derive(Serialize, ToSchema)]
pub struct AdminDashboard {
    pub days: i32,
    pub users_total: i64,
    pub active_users_today: i64,
    pub new_users: i64,
    pub jobs_total: i64,
    pub succeeded_jobs: i64,
    pub failed_jobs: i64,
    pub active_jobs: i64,
    pub issued_credits: i64,
    pub consumed_credits: i64,
    pub compensated_credits: i64,
    pub pending_orders: i64,
    pub order_amounts: Vec<AdminOrderAmount>,
    pub daily: Vec<AdminDay>,
    pub qualities: Vec<AdminQuality>,
    pub health: Vec<AdminHealth>,
    pub notifications: Vec<AdminNotification>,
    pub pending_reviews: i64,
    pub estimated_costs: Vec<AdminEstimate>,
    pub unpriced_units: i64,
}
#[derive(Serialize, ToSchema)]
pub struct UsageView {
    pub days: i32,
    pub daily: Vec<AdminDay>,
    pub qualities: Vec<AdminQuality>,
}
