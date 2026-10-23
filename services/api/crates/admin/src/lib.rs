//! Audited operations. Financial and job mutations delegate to their domain services.
mod controls;
mod read;
mod settings;
mod types;
mod users;
use serde_json::{json, Value};
use sqlx::{PgConnection, PgPool};
pub use types::*;
use uuid::Uuid;
#[derive(Clone)]
pub struct AdminService {
    pub(crate) db: PgPool,
}
impl AdminService {
    pub fn new(db: PgPool) -> Self {
        Self { db }
    }
}
#[derive(Debug, thiserror::Error)]
pub enum AdminError {
    #[error("Invalid administration parameters")]
    Validation,
    #[error("Administrator access required")]
    Forbidden,
    #[error("Record not found")]
    NotFound,
    #[error("Record changed; reload before continuing")]
    Conflict,
    #[error("The last active super administrator must be preserved")]
    LastAdmin,
    #[error("Administration service unavailable")]
    Store,
    #[error(transparent)]
    Wallet(#[from] atelier_wallet::WalletError),
}
impl From<sqlx::Error> for AdminError {
    fn from(e: sqlx::Error) -> Self {
        if e.as_database_error()
            .is_some_and(|e| e.is_unique_violation())
        {
            Self::Conflict
        } else {
            Self::Store
        }
    }
}
impl From<AdminError> for atelier_common::ApiError {
    fn from(e: AdminError) -> Self {
        use axum::http::StatusCode as S;
        if let AdminError::Wallet(w) = e {
            return w.into();
        }
        let (s, c) = match e {
            AdminError::Validation => (S::UNPROCESSABLE_ENTITY, "VALIDATION"),
            AdminError::Forbidden => (S::FORBIDDEN, "FORBIDDEN"),
            AdminError::NotFound => (S::NOT_FOUND, "NOT_FOUND"),
            AdminError::Conflict => (S::CONFLICT, "ADMIN_CONFLICT"),
            AdminError::LastAdmin => (S::CONFLICT, "LAST_SUPER_ADMIN"),
            _ => (S::SERVICE_UNAVAILABLE, "SERVICE_UNAVAILABLE"),
        };
        Self::new(s, c, &e.to_string())
    }
}
pub(crate) async fn actor(
    db: &mut PgConnection,
    id: Uuid,
    super_only: bool,
) -> Result<bool, AdminError> {
    let role: Option<String> =
        sqlx::query_scalar("SELECT role FROM users WHERE id=$1 AND status='ACTIVE' FOR SHARE")
            .bind(id)
            .fetch_optional(db)
            .await?;
    match role.as_deref() {
        Some("SUPER_ADMIN") => Ok(true),
        Some("ADMIN") if !super_only => Ok(false),
        _ => Err(AdminError::Forbidden),
    }
}
pub(crate) fn reason(v: &str) -> Result<(), AdminError> {
    if v.trim().is_empty() || v.chars().count() > 500 || v.contains('\0') {
        Err(AdminError::Validation)
    } else {
        Ok(())
    }
}
pub(crate) fn search(v: &str) -> Result<(), AdminError> {
    if v.chars().count() > 120 || v.contains('\0') {
        Err(AdminError::Validation)
    } else {
        Ok(())
    }
}
pub(crate) async fn identity_lock(db: &mut PgConnection) -> Result<(), AdminError> {
    sqlx::query("SELECT pg_advisory_xact_lock(1096043830)")
        .execute(db)
        .await?;
    Ok(())
}
#[allow(clippy::too_many_arguments)] // An audit fact keeps its actor, target, snapshots and reason explicit.
pub(crate) async fn audit(
    db: &mut PgConnection,
    who: Uuid,
    action: &str,
    kind: &str,
    id: &str,
    before: Value,
    after: Value,
    why: &str,
) -> Result<(), AdminError> {
    sqlx::query("INSERT INTO audit_logs(actor_id,action,target_type,target_id,before,after) VALUES($1,$2,$3,$4,$5,$6)")
        .bind(who).bind(action).bind(kind).bind(id).bind(before).bind(json!({"value":after,"reason":why})).execute(db).await?;
    Ok(())
}
