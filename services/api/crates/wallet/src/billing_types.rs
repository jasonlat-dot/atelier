use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PlanInput {
    pub name: String,
    pub kind: String,
    pub description: String,
    pub price_cents: i32,
    pub currency: String,
    pub credits: i64,
    pub period_days: Option<i32>,
    pub rollover: bool,
    pub concurrency_limit: i32,
    pub max_resolution: String,
    pub retention_days: i32,
    pub active: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct PlanView {
    pub id: Uuid,
    pub revision: i64,
    pub details: PlanInput,
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct OrderInput {
    pub plan_id: Uuid,
    pub plan_revision: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PaidInput {
    pub amount_cents: i32,
    pub currency: String,
    pub trade_no: String,
    pub reason: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct RefundInput {
    pub expected_credits: i64,
    pub confirm_external_refund: bool,
    pub reason: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow, ToSchema)]
pub struct OrderView {
    pub id: Uuid,
    pub user_id: Uuid,
    pub plan_id: Uuid,
    #[schema(value_type = PlanInput)]
    pub plan_snapshot: serde_json::Value,
    pub amount_cents: i32,
    pub currency: String,
    pub provider: String,
    pub provider_trade_no: Option<String>,
    pub status: String,
    pub created_at: DateTime<Utc>,
    pub paid_at: Option<DateTime<Utc>>,
    pub refund_cents: i32,
    pub recovered_credits: i64,
}
#[derive(Serialize, ToSchema)]
pub struct OrderPage {
    pub items: Vec<OrderView>,
    pub next_cursor: Option<Uuid>,
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct RefundQuote {
    pub refundable_credits: i64,
    pub refund_cents: i32,
    pub held_credits: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Entitlements {
    pub tier: String,
    pub plan_name: Option<String>,
    pub current_period_end: Option<DateTime<Utc>>,
    pub max_active_jobs: i64,
    pub max_resolution: String,
    pub retention_days: i32,
    pub scheduled_periods: i64,
}
#[derive(Debug, thiserror::Error)]
pub enum BillingError {
    #[error("Invalid billing parameters")]
    Validation,
    #[error("Billing record not found")]
    NotFound,
    #[error("Order or plan changed; reload before continuing")]
    Conflict,
    #[error("Payment amount or currency does not match the order")]
    PaymentMismatch,
    #[error("Payment reference is already assigned to an order")]
    DuplicateTrade,
    #[error("Finish or cancel active jobs before refunding credits")]
    CreditsHeld,
    #[error("Billing service unavailable")]
    Store,
    #[error(transparent)]
    Wallet(#[from] crate::WalletError),
}
impl From<sqlx::Error> for BillingError {
    fn from(error: sqlx::Error) -> Self {
        if error
            .as_database_error()
            .is_some_and(|e| e.is_unique_violation())
        {
            Self::Conflict
        } else {
            Self::Store
        }
    }
}
impl From<BillingError> for atelier_common::ApiError {
    fn from(error: BillingError) -> Self {
        use axum::http::StatusCode as S;
        if let BillingError::Wallet(error) = error {
            return error.into();
        }
        let (status, code) = match error {
            BillingError::Validation => (S::UNPROCESSABLE_ENTITY, "VALIDATION"),
            BillingError::NotFound => (S::NOT_FOUND, "NOT_FOUND"),
            BillingError::Conflict => (S::CONFLICT, "BILLING_CONFLICT"),
            BillingError::PaymentMismatch => (S::UNPROCESSABLE_ENTITY, "PAYMENT_MISMATCH"),
            BillingError::DuplicateTrade => (S::CONFLICT, "DUPLICATE_TRADE"),
            BillingError::CreditsHeld => (S::CONFLICT, "ORDER_CREDITS_HELD"),
            _ => (S::SERVICE_UNAVAILABLE, "SERVICE_UNAVAILABLE"),
        };
        Self::new(status, code, &error.to_string())
    }
}
