//! M0 security boundary. Replaced by database-backed authentication in M1.
//! There are no development identities or in-memory sessions.
use atelier_common::ApiError;

/// No identity may be established before the M1 authentication flow exists.
pub async fn require_authenticated() -> ApiError {
    ApiError::unauthenticated()
}
