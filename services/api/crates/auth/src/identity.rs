use crate::{
    oidc_provider::VerifiedIdentity,
    policy::{
        canonical_email, registration_allowed, PolicyError, RegistrationContext, RegistrationMode,
    },
    session::SessionSecrets,
};
use atelier_common::ApiError;
use axum::http::StatusCode;
use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};
use std::{collections::HashSet, future::Future, net::IpAddr, pin::Pin};
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AuthFailure {
    Identity,
    State,
    Closed,
    Invite,
    Alias,
    Disabled,
    Forbidden,
    Mfa,
    MfaEnrollmentExpired,
    Rate(u64),
    Store,
}
pub type AuthFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, AuthFailure>> + Send + 'a>>;
impl From<sqlx::Error> for AuthFailure {
    fn from(_: sqlx::Error) -> Self {
        Self::Store
    }
}
impl From<AuthFailure> for ApiError {
    fn from(e: AuthFailure) -> Self {
        let (status, code, message) = match e {
            AuthFailure::Identity | AuthFailure::State => (
                StatusCode::UNAUTHORIZED,
                "UNAUTHENTICATED",
                "Login verification failed",
            ),
            AuthFailure::Closed => (
                StatusCode::FORBIDDEN,
                "REGISTRATION_CLOSED",
                "New registrations are closed",
            ),
            AuthFailure::Invite => (
                StatusCode::FORBIDDEN,
                "INVITE_REQUIRED",
                "A valid invitation is required",
            ),
            AuthFailure::Alias => (
                StatusCode::CONFLICT,
                "IDENTITY_CONFLICT",
                "This email identity is already registered",
            ),
            AuthFailure::Disabled => (
                StatusCode::FORBIDDEN,
                "ACCOUNT_DISABLED",
                "Account is disabled",
            ),
            AuthFailure::Forbidden => (StatusCode::FORBIDDEN, "FORBIDDEN", "Permission denied"),
            AuthFailure::Mfa => (
                StatusCode::UNAUTHORIZED,
                "MFA_INVALID",
                "Verification code invalid, expired or already used",
            ),
            AuthFailure::MfaEnrollmentExpired => (
                StatusCode::CONFLICT,
                "MFA_ENROLLMENT_EXPIRED",
                "Authenticator enrollment has expired",
            ),
            AuthFailure::Rate(_) => (
                StatusCode::TOO_MANY_REQUESTS,
                "TOO_MANY_REQUESTS",
                "Please retry later",
            ),
            AuthFailure::Store => (
                StatusCode::SERVICE_UNAVAILABLE,
                "SERVICE_UNAVAILABLE",
                "Service temporarily unavailable",
            ),
        };
        Self::new(status, code, message)
    }
}
pub fn canonical_ip(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v) => v.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(ip),
        _ => ip,
    }
}
pub struct LoginContext {
    pub ip: IpAddr,
    pub user_agent: String,
    pub invite: Option<String>,
    pub previous_token_hash: Option<[u8; 32]>,
}
#[derive(Clone, Serialize, utoipa::ToSchema)]
pub struct PublicConfig {
    pub registration_mode: String,
    pub version: String,
}
pub trait IdentityRepository: Send + Sync {
    fn login(
        &self,
        identity: VerifiedIdentity,
        context: LoginContext,
    ) -> AuthFuture<'_, SessionSecrets>;
    fn public_config(&self) -> AuthFuture<'_, PublicConfig>;
}
#[derive(Clone)]
pub struct PostgresIdentity {
    pub(crate) pool: PgPool,
    bootstrap: HashSet<String>,
}
impl PostgresIdentity {
    pub fn new(pool: PgPool, bootstrap: HashSet<String>) -> Self {
        Self { pool, bootstrap }
    }
}
impl IdentityRepository for PostgresIdentity {
    fn public_config(&self) -> AuthFuture<'_, PublicConfig> {
        Box::pin(async move {
            let mode: serde_json::Value = sqlx::query_scalar(
                "SELECT value FROM system_settings WHERE key='registration_mode'",
            )
            .fetch_one(&self.pool)
            .await?;
            let mode = mode
                .as_str()
                .filter(|m| ["OPEN", "INVITE_ONLY", "CLOSED"].contains(m))
                .ok_or(AuthFailure::Store)?;
            Ok(PublicConfig {
                registration_mode: mode.into(),
                version: env!("CARGO_PKG_VERSION").into(),
            })
        })
    }
    fn login(
        &self,
        verified: VerifiedIdentity,
        context: LoginContext,
    ) -> AuthFuture<'_, SessionSecrets> {
        Box::pin(async move {
            let identity = verified.identity();
            let ip = canonical_ip(context.ip).to_string();
            let mut tx = self.pool.begin().await?;
            let mut locks = [
                format!("identity:ip:{ip}"),
                format!("identity:sub:{}", identity.google_sub),
                format!("identity:email:{}", identity.canonical_email),
            ];
            locks.sort();
            for key in locks {
                sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
                    .bind(key)
                    .execute(&mut *tx)
                    .await?;
            }
            let rows=sqlx::query("SELECT key,value FROM system_settings WHERE key IN ('registration_mode','registration_whitelist','signup_max_per_ip_24h') ORDER BY key FOR SHARE").fetch_all(&mut *tx).await?;
            let settings: std::collections::HashMap<String, serde_json::Value> = rows
                .into_iter()
                .map(|r| (r.get("key"), r.get("value")))
                .collect();
            let mode = match settings.get("registration_mode").and_then(|v| v.as_str()) {
                Some("OPEN") => RegistrationMode::Open,
                Some("INVITE_ONLY") => RegistrationMode::InviteOnly,
                Some("CLOSED") => RegistrationMode::Closed,
                _ => return Err(AuthFailure::Store),
            };
            let max = settings
                .get("signup_max_per_ip_24h")
                .and_then(|v| v.as_u64())
                .filter(|v| *v <= 10000)
                .ok_or(AuthFailure::Store)? as u32;
            let whitelist = settings
                .get("registration_whitelist")
                .and_then(|v| v.as_array())
                .ok_or(AuthFailure::Store)?;
            let whitelisted = whitelist
                .iter()
                .filter_map(|v| v.as_str())
                .filter_map(|v| canonical_email(v).ok())
                .any(|v| v == identity.canonical_email);
            let existing =
                sqlx::query("SELECT id,status FROM users WHERE google_sub=$1 FOR UPDATE")
                    .bind(&identity.google_sub)
                    .fetch_optional(&mut *tx)
                    .await?;
            let (owner, registered) = if let Some(row) = existing {
                if row.get::<String, _>("status") != "ACTIVE" {
                    return Err(AuthFailure::Disabled);
                }
                (row.get::<uuid::Uuid, _>("id"), false)
            } else {
                if sqlx::query_scalar::<_, bool>(
                    "SELECT EXISTS(SELECT 1 FROM users WHERE canonical_email=$1)",
                )
                .bind(&identity.canonical_email)
                .fetch_one(&mut *tx)
                .await?
                {
                    return Err(AuthFailure::Alias);
                }
                let count:i64=sqlx::query_scalar("SELECT count(*) FROM users WHERE signup_ip=$1::inet AND created_at>now()-interval '24 hours'").bind(&ip).fetch_one(&mut *tx).await?;
                let bootstrap = self.bootstrap.contains(&identity.canonical_email);
                let needs_invite =
                    mode == RegistrationMode::InviteOnly && !bootstrap && !whitelisted;
                let invite = if needs_invite {
                    if let Some(code) = &context.invite {
                        sqlx::query_scalar::<_,uuid::Uuid>("SELECT id FROM invite_codes WHERE code_hash=$1 AND revoked_at IS NULL AND used_count<max_uses AND (expires_at IS NULL OR expires_at>now()) FOR UPDATE").bind(Sha256::digest(code.as_bytes()).as_slice()).fetch_optional(&mut *tx).await?
                    } else {
                        None
                    }
                } else {
                    None
                };
                registration_allowed(
                    mode,
                    RegistrationContext {
                        existing_user: false,
                        bootstrap_admin: bootstrap,
                        whitelisted,
                        valid_invite: invite.is_some(),
                        registrations_24h: count.try_into().unwrap_or(u32::MAX),
                        max_registrations_24h: max,
                    },
                )
                .map_err(|e| match e {
                    PolicyError::RegistrationClosed => AuthFailure::Closed,
                    PolicyError::InviteRequired => AuthFailure::Invite,
                    _ => AuthFailure::Rate(3600),
                })?;
                if let Some(invite) = invite {
                    sqlx::query("UPDATE invite_codes SET used_count=used_count+1 WHERE id=$1")
                        .bind(invite)
                        .execute(&mut *tx)
                        .await?;
                }
                let owner:uuid::Uuid=sqlx::query_scalar("INSERT INTO users(google_sub,email,canonical_email,display_name,role,signup_ip) VALUES($1,$2,$3,$4,$5,$6::inet) RETURNING id").bind(&identity.google_sub).bind(&identity.email).bind(&identity.canonical_email).bind(verified.display_name()).bind(if bootstrap {"SUPER_ADMIN"}else{"USER"}).bind(&ip).fetch_one(&mut *tx).await?;
                (owner, true)
            };
            if registered {
                atelier_wallet::WalletService::signup_in_transaction(&mut tx, owner)
                    .await
                    .map_err(|_| AuthFailure::Store)?;
            }
            let secrets = SessionSecrets::generate().map_err(|_| AuthFailure::Store)?;
            if let Some(hash) = context.previous_token_hash {
                sqlx::query("UPDATE sessions SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL").bind(hash.as_slice()).execute(&mut *tx).await?;
            }
            let ua: String = context
                .user_agent
                .chars()
                .filter(|c| !c.is_control())
                .take(512)
                .collect();
            sqlx::query("INSERT INTO sessions(token_hash,user_id,csrf_token,ip,user_agent,expires_at) VALUES($1,$2,$3,$4::inet,$5,now()+interval '720 hours')").bind(secrets.token_hash().as_slice()).bind(owner).bind(secrets.csrf_token()).bind(&ip).bind(ua).execute(&mut *tx).await?;
            sqlx::query("UPDATE users SET last_login_at=now() WHERE id=$1")
                .bind(owner)
                .execute(&mut *tx)
                .await?;
            sqlx::query("INSERT INTO audit_logs(actor_id,action,target_type,target_id,ip) VALUES($1,$2,'users',$3,$4::inet)").bind(owner).bind(if registered {"USER_REGISTERED"}else{"USER_LOGIN"}).bind(owner.to_string()).bind(&ip).execute(&mut *tx).await?;
            tx.commit().await?;
            Ok(secrets)
        })
    }
}
