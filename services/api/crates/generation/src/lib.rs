//! Durable generation jobs; financial writes always go through wallet service.
mod service;
mod types;
mod worker;
use atelier_common::ApiError;
use axum::http::StatusCode;
pub use service::GenerationService;
pub use types::*;
pub use worker::GenerationWorker;
#[derive(Debug, thiserror::Error)]
pub enum GenerationError {
    #[error("Invalid generation input")]
    Validation,
    #[error("Idempotency key reused with different parameters")]
    Conflict,
    #[error("Resource not found")]
    NotFound,
    #[error("Model unavailable or configuration changed")]
    Model,
    #[error("Too many active jobs")]
    ActiveLimit,
    #[error("Content rejected")]
    ContentPolicy,
    #[error("Generation service unavailable")]
    Store,
    #[error("Generation cannot be changed")]
    State,
    #[error("Requested resolution is unavailable for this account")]
    Tier,
    #[error(transparent)]
    Wallet(#[from] atelier_wallet::WalletError),
}
impl From<sqlx::Error> for GenerationError {
    fn from(_: sqlx::Error) -> Self {
        Self::Store
    }
}
impl From<atelier_assets::AssetError> for GenerationError {
    fn from(e: atelier_assets::AssetError) -> Self {
        match e {
            atelier_assets::AssetError::NotFound => Self::NotFound,
            atelier_assets::AssetError::Validation | atelier_assets::AssetError::TooLarge => {
                Self::Validation
            }
            _ => Self::Store,
        }
    }
}
impl From<GenerationError> for ApiError {
    fn from(error: GenerationError) -> Self {
        if let GenerationError::Wallet(e) = error {
            return e.into();
        }
        let (s, c) = match &error {
            GenerationError::Validation => (StatusCode::UNPROCESSABLE_ENTITY, "VALIDATION"),
            GenerationError::Conflict => (StatusCode::UNPROCESSABLE_ENTITY, "IDEMPOTENCY_CONFLICT"),
            GenerationError::NotFound => (StatusCode::NOT_FOUND, "NOT_FOUND"),
            GenerationError::Model => (StatusCode::SERVICE_UNAVAILABLE, "MODEL_UNAVAILABLE"),
            GenerationError::ActiveLimit => (StatusCode::TOO_MANY_REQUESTS, "TOO_MANY_ACTIVE_JOBS"),
            GenerationError::ContentPolicy => (StatusCode::UNPROCESSABLE_ENTITY, "CONTENT_POLICY"),
            GenerationError::Tier => (StatusCode::FORBIDDEN, "RESOLUTION_NOT_ALLOWED"),
            GenerationError::State => (StatusCode::CONFLICT, "JOB_STATE_CONFLICT"),
            _ => (StatusCode::SERVICE_UNAVAILABLE, "SERVICE_UNAVAILABLE"),
        };
        Self::new(s, c, &error.to_string())
    }
}
