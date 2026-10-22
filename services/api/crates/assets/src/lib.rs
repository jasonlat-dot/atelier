//! Private media: validated bytes, owner-scoped metadata and expiring access.
pub mod imaging;
mod service;
pub mod signing;
pub mod storage;
pub mod video;
mod video_service;
mod views;
use atelier_common::ApiError;
use axum::http::StatusCode;
pub use service::AssetService;
pub use views::*;

pub const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;
pub const MAX_VIDEO_BYTES: usize = 200 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum AssetError {
    #[error("Invalid media input")]
    Validation,
    #[error("Media exceeds limits")]
    TooLarge,
    #[error("Media not found")]
    NotFound,
    #[error("Media storage unavailable")]
    Store,
    #[error("Media processing busy")]
    Busy,
    #[error("Media quota exceeded")]
    Quota,
    #[error("Video processing unavailable")]
    VideoUnavailable,
}
impl From<sqlx::Error> for AssetError {
    fn from(_: sqlx::Error) -> Self {
        Self::Store
    }
}
impl From<AssetError> for ApiError {
    fn from(error: AssetError) -> Self {
        let (status, code, message) = match error {
            AssetError::Validation => (
                StatusCode::UNPROCESSABLE_ENTITY,
                "INVALID_MEDIA",
                "Unsupported or invalid media",
            ),
            AssetError::TooLarge => (
                StatusCode::PAYLOAD_TOO_LARGE,
                "MEDIA_TOO_LARGE",
                "Media exceeds upload limits",
            ),
            AssetError::NotFound => (StatusCode::NOT_FOUND, "NOT_FOUND", "Resource not found"),
            AssetError::Store => (
                StatusCode::SERVICE_UNAVAILABLE,
                "SERVICE_UNAVAILABLE",
                "Media service unavailable",
            ),
            AssetError::Busy => (
                StatusCode::TOO_MANY_REQUESTS,
                "TOO_MANY_REQUESTS",
                "Media processing busy; retry later",
            ),
            AssetError::Quota => (
                StatusCode::CONFLICT,
                "ASSET_QUOTA_EXCEEDED",
                "Media storage quota reached",
            ),
            AssetError::VideoUnavailable => (
                StatusCode::SERVICE_UNAVAILABLE,
                "VIDEO_UNAVAILABLE",
                "Video processing unavailable",
            ),
        };
        Self::new(status, code, message)
    }
}
