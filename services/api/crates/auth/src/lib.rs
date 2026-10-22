//! M1 policy and session foundations. Database-backed authentication is not wired yet.
//! There are no development identities or in-memory sessions.
use atelier_common::ApiError;

/// No identity may be established before the M1 authentication flow exists.
pub async fn require_authenticated() -> ApiError {
    ApiError::unauthenticated()
}

pub mod policy;
pub mod session;
