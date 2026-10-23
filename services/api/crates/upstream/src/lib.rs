//! Server-only credentials, guarded transport and upstream capacity routing.
mod chat;
pub mod crypto;
pub mod egress;
pub mod provider;
mod runtime;
pub mod slots;
pub use runtime::{RouteLease, RouteRequirements};
mod service;
pub mod types;
pub mod validation;
use atelier_common::ApiError;
use axum::http::StatusCode;
pub use service::UpstreamService;
pub use types::*;
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Invalid upstream configuration")]
    Validation,
    #[error("Resource not found")]
    NotFound,
    #[error("Configuration changed; reload before editing")]
    Conflict,
    #[error("Upstream service unavailable")]
    Store,
    #[error("No upstream capacity")]
    NoCapacity,
    #[error("Upstream address rejected")]
    UnsafeUrl,
    #[error("Upstream operation failed")]
    Provider(ProviderFailure),
}
impl From<sqlx::Error> for Error {
    fn from(error: sqlx::Error) -> Self {
        match error.as_database_error().and_then(|e| e.code()).as_deref() {
            Some("23505" | "40001" | "40P01") => Self::Conflict,
            Some("23503" | "23514" | "22003") => Self::Validation,
            _ => Self::Store,
        }
    }
}
impl From<Error> for ApiError {
    fn from(error: Error) -> Self {
        let (status, code, message) = match error {
            Error::Validation => (
                StatusCode::UNPROCESSABLE_ENTITY,
                "INVALID_UPSTREAM_CONFIG",
                "Invalid upstream configuration",
            ),
            Error::NotFound => (StatusCode::NOT_FOUND, "NOT_FOUND", "Resource not found"),
            Error::Conflict => (
                StatusCode::CONFLICT,
                "CONFIG_CONFLICT",
                "Configuration changed; reload before editing",
            ),
            Error::Store => (
                StatusCode::SERVICE_UNAVAILABLE,
                "SERVICE_UNAVAILABLE",
                "Upstream management unavailable",
            ),
            Error::NoCapacity => (
                StatusCode::SERVICE_UNAVAILABLE,
                "NO_CAPACITY",
                "No upstream capacity available",
            ),
            Error::UnsafeUrl => (
                StatusCode::UNPROCESSABLE_ENTITY,
                "UPSTREAM_ADDRESS_REJECTED",
                "Upstream address rejected",
            ),
            Error::Provider(_) => (
                StatusCode::BAD_GATEWAY,
                "UPSTREAM_UNAVAILABLE",
                "Upstream operation failed",
            ),
        };
        Self::new(status, code, message)
    }
}
