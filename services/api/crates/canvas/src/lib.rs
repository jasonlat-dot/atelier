//! Versioned owner-scoped graphs. Media bytes and money remain in their own services.
mod archive;
mod graph;
pub use archive::MAX_ARCHIVE_BYTES;
mod service;
use atelier_common::ApiError;
use axum::http::StatusCode;
pub use graph::*;
pub use service::*;

#[derive(Debug, thiserror::Error)]
pub enum CanvasError {
    #[error("Invalid project graph")]
    Validation,
    #[error("Project not found")]
    NotFound,
    #[error("Project revision changed")]
    Conflict,
    #[error("Project quota reached")]
    Quota,
    #[error("Project service unavailable")]
    Store,
    #[error("Archive exceeds limits")]
    TooLarge,
    #[error("Archive operation busy")]
    Busy,
}
impl From<sqlx::Error> for CanvasError {
    fn from(_: sqlx::Error) -> Self {
        Self::Store
    }
}
impl From<atelier_assets::AssetError> for CanvasError {
    fn from(error: atelier_assets::AssetError) -> Self {
        match error {
            atelier_assets::AssetError::NotFound => Self::NotFound,
            atelier_assets::AssetError::Validation => Self::Validation,
            _ => Self::Store,
        }
    }
}
impl From<CanvasError> for ApiError {
    fn from(error: CanvasError) -> Self {
        let (status, code, message) = match error {
            CanvasError::TooLarge => (
                StatusCode::PAYLOAD_TOO_LARGE,
                "ARCHIVE_TOO_LARGE",
                "Archive exceeds limits",
            ),
            CanvasError::Busy => (
                StatusCode::TOO_MANY_REQUESTS,
                "TOO_MANY_REQUESTS",
                "Archive processing busy",
            ),
            CanvasError::Validation => (
                StatusCode::UNPROCESSABLE_ENTITY,
                "INVALID_GRAPH",
                "Invalid project or graph",
            ),
            CanvasError::NotFound => (StatusCode::NOT_FOUND, "NOT_FOUND", "Resource not found"),
            CanvasError::Conflict => (
                StatusCode::CONFLICT,
                "REVISION_CONFLICT",
                "Project changed; reload or save a copy",
            ),
            CanvasError::Quota => (
                StatusCode::CONFLICT,
                "PROJECT_QUOTA_EXCEEDED",
                "Project limit reached",
            ),
            CanvasError::Store => (
                StatusCode::SERVICE_UNAVAILABLE,
                "SERVICE_UNAVAILABLE",
                "Project service unavailable",
            ),
        };
        Self::new(status, code, message)
    }
}
