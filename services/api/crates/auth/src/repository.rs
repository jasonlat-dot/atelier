//! Persistence boundary. Repositories receive only server-established user IDs.
use crate::{
    policy::{Role, SessionWindow, UserStatus},
    views::{DeviceSession, SessionUser},
};
use chrono::{DateTime, Utc};
use std::{future::Future, pin::Pin};
use uuid::Uuid;

/// Intentionally contains no raw SQL error, connection string, or credentials.
#[derive(Debug, Clone, Copy)]
pub struct RepositoryError;
pub type RepoFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, RepositoryError>> + Send + 'a>>;

#[derive(Clone)]
pub struct SessionRecord {
    pub id: Uuid,
    pub token_hash: [u8; 32],
    pub user: SessionUser,
    pub status: UserStatus,
    pub csrf_token: String,
    pub mfa_verified_at: Option<DateTime<Utc>>,
    pub window: SessionWindow,
}

pub trait SessionRepository: Send + Sync {
    fn lookup(&self, hash: [u8; 32]) -> RepoFuture<'_, Option<SessionRecord>>;
    /// Conditional touch also rejects a revocation or role change after lookup.
    fn touch(&self, hash: [u8; 32], role: Role, now: DateTime<Utc>) -> RepoFuture<'_, bool>;
    fn rename(&self, owner: Uuid, name: String) -> RepoFuture<'_, bool>;
    fn revoke_all(&self, owner: Uuid) -> RepoFuture<'_, ()>;
    fn devices(
        &self,
        owner: Uuid,
        current: Uuid,
        now: DateTime<Utc>,
    ) -> RepoFuture<'_, Vec<DeviceSession>>;
    fn revoke_device(&self, owner: Uuid, device: Uuid) -> RepoFuture<'_, bool>;
}
