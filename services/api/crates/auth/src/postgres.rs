//! PostgreSQL persistence only. No balance mutation or identity from request JSON.
use crate::{
    policy::{Role, SessionWindow, UserStatus},
    repository::{RepoFuture, RepositoryError, SessionRecord, SessionRepository},
    views::{DeviceSession, SessionUser},
};
use chrono::{DateTime, Utc};
use sqlx::{PgPool, Row};
use uuid::Uuid;

pub struct PostgresSessions {
    pool: PgPool,
}
impl PostgresSessions {
    pub async fn revoke_owner_in_transaction(
        db: &mut sqlx::PgConnection,
        owner: Uuid,
    ) -> Result<u64, sqlx::Error> {
        Ok(sqlx::query("UPDATE sessions SET revoked_at=clock_timestamp() WHERE user_id=$1 AND revoked_at IS NULL").bind(owner).execute(db).await?.rows_affected())
    }
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}
impl SessionRepository for PostgresSessions {
    fn lookup(&self, hash: [u8; 32]) -> RepoFuture<'_, Option<SessionRecord>> {
        Box::pin(async move {
            let row = sqlx::query("SELECT s.id,s.token_hash,s.csrf_token,s.created_at,s.last_seen_at,s.expires_at,s.revoked_at,s.mfa_verified_at,u.id AS user_id,u.email,u.display_name,u.role,u.status,u.mfa_enabled FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1")
            .bind(hash.as_slice()).fetch_optional(&self.pool).await.map_err(|_| RepositoryError)?;
            row.map(|r| {
                let status: String = r.get("status");
                Ok(SessionRecord {
                    id: r.get("id"),
                    token_hash: r
                        .get::<Vec<u8>, _>("token_hash")
                        .try_into()
                        .map_err(|_| RepositoryError)?,
                    csrf_token: r.get("csrf_token"),
                    mfa_verified_at: r.get("mfa_verified_at"),
                    user: SessionUser {
                        id: r.get("user_id"),
                        email: r.get("email"),
                        display_name: r.get("display_name"),
                        role: Role::try_from(r.get::<String, _>("role").as_str())
                            .map_err(|_| RepositoryError)?,
                        mfa_enabled: r.get("mfa_enabled"),
                    },
                    status: match status.as_str() {
                        "ACTIVE" => UserStatus::Active,
                        "DISABLED" => UserStatus::Disabled,
                        _ => return Err(RepositoryError),
                    },
                    window: SessionWindow {
                        created_at: r.get("created_at"),
                        last_seen_at: r.get("last_seen_at"),
                        expires_at: r.get("expires_at"),
                        revoked: r.get::<Option<DateTime<Utc>>, _>("revoked_at").is_some(),
                    },
                })
            })
            .transpose()
        })
    }
    fn touch(&self, hash: [u8; 32], role: Role, now: DateTime<Utc>) -> RepoFuture<'_, bool> {
        Box::pin(async move {
            let result = sqlx::query("UPDATE sessions s SET last_seen_at=GREATEST(s.last_seen_at,$2) FROM users u WHERE s.token_hash=$1 AND u.id=s.user_id AND u.status='ACTIVE' AND u.role=$3 AND s.revoked_at IS NULL AND s.expires_at>$2 AND s.created_at>$2-interval '720 hours' AND s.last_seen_at>$2-interval '168 hours'")
            .bind(hash.as_slice()).bind(now).bind(role.as_str()).execute(&self.pool).await.map_err(|_| RepositoryError)?;
            Ok(result.rows_affected() == 1)
        })
    }
    fn rename(&self, owner: Uuid, name: String) -> RepoFuture<'_, bool> {
        Box::pin(async move {
            let mut tx = self.pool.begin().await.map_err(|_| RepositoryError)?;
            let previous: Option<String> = sqlx::query_scalar(
                "SELECT display_name FROM users WHERE id=$1 AND status='ACTIVE' FOR UPDATE",
            )
            .bind(owner)
            .fetch_optional(&mut *tx)
            .await
            .map_err(|_| RepositoryError)?;
            let Some(previous) = previous else {
                return Ok(false);
            };
            sqlx::query("UPDATE users SET display_name=$2 WHERE id=$1")
                .bind(owner)
                .bind(&name)
                .execute(&mut *tx)
                .await
                .map_err(|_| RepositoryError)?;
            sqlx::query("INSERT INTO audit_logs(actor_id,action,target_type,target_id,before,after) VALUES($1,'USER_RENAMED','users',$2,$3,$4)")
            .bind(owner).bind(owner.to_string()).bind(serde_json::json!({"display_name":previous})).bind(serde_json::json!({"display_name":name})).execute(&mut *tx).await.map_err(|_| RepositoryError)?;
            tx.commit().await.map_err(|_| RepositoryError)?;
            Ok(true)
        })
    }
    fn revoke_all(&self, owner: Uuid) -> RepoFuture<'_, ()> {
        Box::pin(async move {
            let mut tx = self.pool.begin().await.map_err(|_| RepositoryError)?;
            sqlx::query(
                "UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL",
            )
            .bind(owner)
            .execute(&mut *tx)
            .await
            .map_err(|_| RepositoryError)?;
            sqlx::query("INSERT INTO audit_logs(actor_id,action,target_type,target_id) VALUES($1,'SESSIONS_REVOKED','users',$2)").bind(owner).bind(owner.to_string()).execute(&mut *tx).await.map_err(|_| RepositoryError)?;
            tx.commit().await.map_err(|_| RepositoryError)?;
            Ok(())
        })
    }
    fn devices(
        &self,
        owner: Uuid,
        current: Uuid,
        now: DateTime<Utc>,
    ) -> RepoFuture<'_, Vec<DeviceSession>> {
        Box::pin(async move {
            let rows = sqlx::query("SELECT id,created_at,last_seen_at,user_agent,host(ip) AS ip FROM sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>$2 AND created_at>$2-interval '720 hours' AND last_seen_at>$2-interval '168 hours' ORDER BY last_seen_at DESC LIMIT 100")
            .bind(owner).bind(now).fetch_all(&self.pool).await.map_err(|_| RepositoryError)?;
            Ok(rows
                .into_iter()
                .map(|row| DeviceSession {
                    id: row.get("id"),
                    created_at: row.get("created_at"),
                    last_seen_at: row.get("last_seen_at"),
                    user_agent: row.get("user_agent"),
                    ip: row.get("ip"),
                    current: row.get::<Uuid, _>("id") == current,
                })
                .collect())
        })
    }
    fn revoke_device(&self, owner: Uuid, device: Uuid) -> RepoFuture<'_, bool> {
        Box::pin(async move {
            let mut tx = self.pool.begin().await.map_err(|_| RepositoryError)?;
            let result = sqlx::query("UPDATE sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1 AND user_id=$2").bind(device).bind(owner).execute(&mut *tx).await.map_err(|_| RepositoryError)?;
            if result.rows_affected() == 0 {
                return Ok(false);
            }
            sqlx::query("INSERT INTO audit_logs(actor_id,action,target_type,target_id) VALUES($1,'SESSION_REVOKED','sessions',$2)").bind(owner).bind(device.to_string()).execute(&mut *tx).await.map_err(|_| RepositoryError)?;
            tx.commit().await.map_err(|_| RepositoryError)?;
            Ok(true)
        })
    }
}
