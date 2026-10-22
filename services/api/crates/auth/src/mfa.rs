use crate::{
    identity::{AuthFailure, AuthFuture, PostgresIdentity},
    policy::Role,
    service::AuthenticatedSession,
    transient::{RateDecision, RateRule, TransientStore},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use chacha20poly1305::{
    aead::{Aead, Payload},
    ChaCha20Poly1305, KeyInit, Nonce,
};
use chrono::Utc;
use sqlx::Row;
use std::sync::Arc;
use uuid::Uuid;
#[derive(Clone)]
pub struct MfaCipher {
    cipher: ChaCha20Poly1305,
}
impl std::fmt::Debug for MfaCipher {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("MfaCipher([REDACTED])")
    }
}
impl MfaCipher {
    pub fn from_base64(key: &str) -> Result<Self, AuthFailure> {
        let key = STANDARD.decode(key).map_err(|_| AuthFailure::Store)?;
        let cipher = ChaCha20Poly1305::new_from_slice(&key).map_err(|_| AuthFailure::Store)?;
        Ok(Self { cipher })
    }
    pub fn seal(&self, owner: Uuid, secret: &[u8]) -> Result<Vec<u8>, AuthFailure> {
        let mut nonce = [0u8; 12];
        getrandom::fill(&mut nonce).map_err(|_| AuthFailure::Store)?;
        let ciphertext = self
            .cipher
            .encrypt(
                &Nonce::from(nonce),
                Payload {
                    msg: secret,
                    aad: owner.as_bytes(),
                },
            )
            .map_err(|_| AuthFailure::Store)?;
        let mut result = vec![1];
        result.extend_from_slice(&nonce);
        result.extend(ciphertext);
        Ok(result)
    }
    pub fn open(&self, owner: Uuid, value: &[u8]) -> Result<Vec<u8>, AuthFailure> {
        if value.len() < 29 || value[0] != 1 {
            return Err(AuthFailure::Store);
        }
        let nonce: [u8; 12] = value[1..13].try_into().map_err(|_| AuthFailure::Store)?;
        self.cipher
            .decrypt(
                &Nonce::from(nonce),
                Payload {
                    msg: &value[13..],
                    aad: owner.as_bytes(),
                },
            )
            .map_err(|_| AuthFailure::Store)
    }
}
pub fn totp(secret: &[u8], email: &str) -> Result<totp_rs::Totp, AuthFailure> {
    totp_rs::Builder::new()
        .with_secret(secret.to_vec())
        .with_digits(6)
        .with_skew(1)
        .with_step_duration(30)
        .with_account_name(email)
        .with_issuer(Some("Atelier"))
        .build()
        .map_err(|_| AuthFailure::Store)
}
#[derive(serde::Serialize, utoipa::ToSchema)]
pub struct MfaSetup {
    pub otpauth_uri: String,
}
#[derive(serde::Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct MfaCode {
    pub code: String,
}
pub struct MfaMaterial {
    pub enabled: bool,
    pub encrypted: Vec<u8>,
}
pub trait MfaRepository: Send + Sync {
    fn material(&self, owner: Uuid, session: Uuid) -> AuthFuture<'_, MfaMaterial>;
    fn pending(&self, owner: Uuid, session: Uuid, encrypted: Vec<u8>) -> AuthFuture<'_, ()>;
    fn accept(
        &self,
        owner: Uuid,
        session: Uuid,
        encrypted: Vec<u8>,
        step: i64,
        enroll: bool,
    ) -> AuthFuture<'_, bool>;
}
#[derive(Clone)]
pub struct MfaService {
    repository: Arc<dyn MfaRepository>,
    limits: Arc<dyn TransientStore>,
    cipher: MfaCipher,
}
impl MfaService {
    pub fn new(
        repository: Arc<dyn MfaRepository>,
        limits: Arc<dyn TransientStore>,
        cipher: MfaCipher,
    ) -> Self {
        Self {
            repository,
            limits,
            cipher,
        }
    }
    async fn guard(&self, actor: &AuthenticatedSession) -> Result<(), AuthFailure> {
        if actor.user().role == Role::User {
            return Err(AuthFailure::Forbidden);
        }
        match self
            .limits
            .rate_limit(
                format!("auth:mfa:{}", actor.user().id),
                RateRule {
                    limit: 5,
                    window_seconds: 300,
                },
            )
            .await
            .map_err(|_| AuthFailure::Store)?
        {
            RateDecision::Allowed => Ok(()),
            RateDecision::Limited {
                retry_after_seconds,
            } => Err(AuthFailure::Rate(retry_after_seconds)),
        }
    }
    pub async fn setup(&self, actor: &AuthenticatedSession) -> Result<MfaSetup, AuthFailure> {
        self.guard(actor).await?;
        let mut secret = [0u8; 20];
        getrandom::fill(&mut secret).map_err(|_| AuthFailure::Store)?;
        let uri = totp(&secret, &actor.user().email)?
            .to_url()
            .map_err(|_| AuthFailure::Store)?;
        let encrypted = self.cipher.seal(actor.user().id, &secret)?;
        self.repository
            .pending(actor.user().id, actor.session_id(), encrypted)
            .await?;
        Ok(MfaSetup { otpauth_uri: uri })
    }
    pub async fn verify(
        &self,
        actor: &AuthenticatedSession,
        code: &str,
    ) -> Result<(), AuthFailure> {
        self.guard(actor).await?;
        if code.len() != 6 || !code.bytes().all(|b| b.is_ascii_digit()) {
            return Err(AuthFailure::Mfa);
        }
        let record = self
            .repository
            .material(actor.user().id, actor.session_id())
            .await?;
        let secret = self.cipher.open(actor.user().id, &record.encrypted)?;
        let now = Utc::now().timestamp();
        let step = totp(&secret, &actor.user().email)?
            .check(code, now.try_into().map_err(|_| AuthFailure::Store)?)
            .ok_or(AuthFailure::Mfa)?;
        if !self
            .repository
            .accept(
                actor.user().id,
                actor.session_id(),
                record.encrypted,
                step.try_into().map_err(|_| AuthFailure::Mfa)?,
                !record.enabled,
            )
            .await?
        {
            return Err(AuthFailure::Mfa);
        }
        Ok(())
    }
}
async fn lock_actor(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    owner: Uuid,
    session: Uuid,
) -> Result<(), AuthFailure> {
    let user = sqlx::query("SELECT role,status FROM users WHERE id=$1 FOR UPDATE")
        .bind(owner)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(AuthFailure::Forbidden)?;
    if user.get::<String, _>("status") != "ACTIVE"
        || !["ADMIN", "SUPER_ADMIN"].contains(&user.get::<String, _>("role").as_str())
    {
        return Err(AuthFailure::Forbidden);
    }
    let valid:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM sessions WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>now() AND last_seen_at>now()-interval '168 hours')").bind(session).bind(owner).fetch_one(&mut **tx).await?;
    if !valid {
        return Err(AuthFailure::Forbidden);
    }
    Ok(())
}
impl MfaRepository for PostgresIdentity {
    fn material(&self, owner: Uuid, session: Uuid) -> AuthFuture<'_, MfaMaterial> {
        Box::pin(async move {
            let mut tx = self.pool.begin().await?;
            lock_actor(&mut tx, owner, session).await?;
            let row=sqlx::query("SELECT mfa_enabled,mfa_secret_enc,mfa_pending_enc,mfa_pending_expires_at<=clock_timestamp() AS pending_expired,mfa_pending_session FROM users WHERE id=$1").bind(owner).fetch_one(&mut *tx).await?;
            let enabled: bool = row.get("mfa_enabled");
            let encrypted = if enabled {
                row.get::<Option<Vec<u8>>, _>("mfa_secret_enc")
            } else {
                if row.get::<Option<Uuid>, _>("mfa_pending_session") != Some(session) {
                    return Err(AuthFailure::Mfa);
                }
                match row.get::<Option<bool>, _>("pending_expired") {
                    Some(true) => return Err(AuthFailure::MfaEnrollmentExpired),
                    None => return Err(AuthFailure::Mfa),
                    Some(false) => {}
                }
                row.get("mfa_pending_enc")
            };
            tx.commit().await?;
            Ok(MfaMaterial {
                enabled,
                encrypted: encrypted.ok_or(AuthFailure::Mfa)?,
            })
        })
    }
    fn pending(&self, owner: Uuid, session: Uuid, encrypted: Vec<u8>) -> AuthFuture<'_, ()> {
        Box::pin(async move {
            let mut tx = self.pool.begin().await?;
            lock_actor(&mut tx, owner, session).await?;
            let updated=sqlx::query("UPDATE users SET mfa_pending_enc=$2,mfa_pending_session=$3,mfa_pending_expires_at=clock_timestamp()+interval '10 minutes' WHERE id=$1 AND NOT mfa_enabled").bind(owner).bind(encrypted).bind(session).execute(&mut *tx).await?;
            if updated.rows_affected() != 1 {
                return Err(AuthFailure::Forbidden);
            }
            sqlx::query("INSERT INTO audit_logs(actor_id,action,target_type,target_id) VALUES($1,'MFA_SETUP_STARTED','users',$2)").bind(owner).bind(owner.to_string()).execute(&mut *tx).await?;
            tx.commit().await?;
            Ok(())
        })
    }
    fn accept(
        &self,
        owner: Uuid,
        session: Uuid,
        encrypted: Vec<u8>,
        step: i64,
        enroll: bool,
    ) -> AuthFuture<'_, bool> {
        Box::pin(async move {
            let mut tx = self.pool.begin().await?;
            lock_actor(&mut tx, owner, session).await?;
            let updated = if enroll {
                sqlx::query("UPDATE users SET mfa_enabled=true,mfa_secret_enc=mfa_pending_enc,mfa_pending_enc=NULL,mfa_pending_session=NULL,mfa_pending_expires_at=NULL,mfa_last_step=$4 WHERE id=$1 AND NOT mfa_enabled AND mfa_pending_enc=$2 AND mfa_pending_session=$3 AND mfa_pending_expires_at>clock_timestamp() AND (mfa_last_step IS NULL OR mfa_last_step<$4)").bind(owner).bind(&encrypted).bind(session).bind(step).execute(&mut *tx).await?
            } else {
                sqlx::query("UPDATE users SET mfa_last_step=$3 WHERE id=$1 AND mfa_enabled AND mfa_secret_enc=$2 AND (mfa_last_step IS NULL OR mfa_last_step<$3)").bind(owner).bind(&encrypted).bind(step).execute(&mut *tx).await?
            };
            if updated.rows_affected() != 1 {
                if enroll {
                    let expired: bool = sqlx::query_scalar("SELECT COALESCE(NOT mfa_enabled AND mfa_pending_enc=$2 AND mfa_pending_session=$3 AND mfa_pending_expires_at<=clock_timestamp(),false) FROM users WHERE id=$1")
                        .bind(owner).bind(&encrypted).bind(session).fetch_one(&mut *tx).await?;
                    if expired {
                        return Err(AuthFailure::MfaEnrollmentExpired);
                    }
                }
                return Ok(false);
            }
            sqlx::query("UPDATE sessions SET mfa_verified_at=now() WHERE id=$1 AND user_id=$2")
                .bind(session)
                .bind(owner)
                .execute(&mut *tx)
                .await?;
            sqlx::query("INSERT INTO audit_logs(actor_id,action,target_type,target_id) VALUES($1,$2,'users',$3)").bind(owner).bind(if enroll {"MFA_ENABLED"}else{"MFA_VERIFIED"}).bind(owner.to_string()).execute(&mut *tx).await?;
            tx.commit().await?;
            Ok(true)
        })
    }
}
