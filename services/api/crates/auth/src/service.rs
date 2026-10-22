use crate::{
    policy::{self, PolicyError, Role},
    repository::{RepositoryError, SessionRecord, SessionRepository},
    session::{token_hash, validate_csrf_headers},
    views::{DeviceList, MeResponse},
};
use atelier_common::ApiError;
use axum::http::{header, HeaderMap, StatusCode};
use chrono::Utc;
use std::sync::Arc;
use url::{Host, Url};
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublicOrigin(String);
impl PublicOrigin {
    pub fn parse(value: &str) -> Result<Self, &'static str> {
        let url = Url::parse(value).map_err(|_| "PUBLIC_BASE_URL")?;
        let local = match url.host() {
            Some(Host::Domain("localhost")) => true,
            Some(Host::Ipv4(ip)) => ip.is_loopback(),
            Some(Host::Ipv6(ip)) => ip.is_loopback(),
            _ => false,
        };
        if !(url.scheme() == "https" || (url.scheme() == "http" && local))
            || url.host().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/"
        {
            return Err("PUBLIC_BASE_URL");
        }
        Ok(Self(url.origin().ascii_serialization()))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
    fn validate_host(&self, headers: &HeaderMap) -> Result<(), AuthError> {
        let mut values = headers.get_all(header::HOST).iter();
        let host = values
            .next()
            .and_then(|v| v.to_str().ok())
            .ok_or(AuthError::Policy(PolicyError::CsrfRejected))?;
        if values.next().is_some() {
            return Err(AuthError::Policy(PolicyError::CsrfRejected));
        }
        host.parse::<axum::http::uri::Authority>()
            .map_err(|_| AuthError::Policy(PolicyError::CsrfRejected))?;
        let scheme = self.0.split_once("://").expect("validated URL").0;
        if PublicOrigin::parse(&format!("{scheme}://{host}"))
            .ok()
            .as_ref()
            != Some(self)
        {
            return Err(AuthError::Policy(PolicyError::CsrfRejected));
        }
        Ok(())
    }
}

#[derive(Clone)]
pub struct AuthenticatedSession {
    record: SessionRecord,
}
impl AuthenticatedSession {
    pub fn user(&self) -> &crate::views::SessionUser {
        &self.record.user
    }
    pub fn session_id(&self) -> Uuid {
        self.record.id
    }
    pub fn me(&self) -> MeResponse {
        MeResponse {
            user: self.record.user.clone(),
            csrf_token: self.record.csrf_token.clone(),
            mfa_required: self.user().role != Role::User
                && self.require_admin(Role::Admin).is_err(),
        }
    }
    pub fn require_admin(&self, role: Role) -> Result<(), AuthError> {
        policy::require_admin(
            self.user().role,
            role,
            self.user().mfa_enabled,
            self.record.mfa_verified_at,
            Utc::now(),
        )
        .map_err(AuthError::Policy)
    }
}

#[derive(Debug)]
pub enum AuthError {
    Policy(PolicyError),
    Store,
    NotFound,
    InvalidName,
}
impl From<RepositoryError> for AuthError {
    fn from(_: RepositoryError) -> Self {
        Self::Store
    }
}
impl From<AuthError> for ApiError {
    fn from(value: AuthError) -> Self {
        match value {
            AuthError::Policy(PolicyError::Unauthenticated) => Self::unauthenticated(),
            AuthError::Policy(PolicyError::AccountDisabled) => Self::new(
                StatusCode::FORBIDDEN,
                "ACCOUNT_DISABLED",
                "Account is disabled",
            ),
            AuthError::Policy(PolicyError::MfaRequired) => Self::new(
                StatusCode::FORBIDDEN,
                "MFA_REQUIRED",
                "Administrator MFA verification required",
            ),
            AuthError::Policy(PolicyError::CsrfRejected) => Self::new(
                StatusCode::FORBIDDEN,
                "FORBIDDEN",
                "Request origin or CSRF token rejected",
            ),
            AuthError::Policy(_) => {
                Self::new(StatusCode::FORBIDDEN, "FORBIDDEN", "Permission denied")
            }
            AuthError::Store => Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "SERVICE_UNAVAILABLE",
                "Service temporarily unavailable",
            ),
            AuthError::NotFound => Self::not_found(),
            AuthError::InvalidName => Self::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "VALIDATION",
                "Display name must contain 1 to 100 characters without control characters",
            ),
        }
    }
}

#[derive(Clone)]
pub struct SessionService {
    repository: Arc<dyn SessionRepository>,
    origin: PublicOrigin,
}
impl SessionService {
    pub fn new(repository: Arc<dyn SessionRepository>, origin: PublicOrigin) -> Self {
        Self { repository, origin }
    }
    pub async fn authenticate(
        &self,
        method: &str,
        headers: &HeaderMap,
    ) -> Result<AuthenticatedSession, AuthError> {
        let hash = token_hash(headers).map_err(AuthError::Policy)?;
        let record = self
            .repository
            .lookup(hash)
            .await?
            .ok_or(AuthError::Policy(PolicyError::Unauthenticated))?;
        let now = Utc::now();
        policy::session_allowed(&record.window, record.status, now).map_err(AuthError::Policy)?;
        if method != "GET" {
            self.origin.validate_host(headers)?;
            validate_csrf_headers(method, headers, self.origin.as_str(), &record.csrf_token)
                .map_err(AuthError::Policy)?;
        }
        if !self.repository.touch(hash, record.user.role, now).await? {
            return Err(AuthError::Policy(PolicyError::Unauthenticated));
        }
        Ok(AuthenticatedSession { record })
    }
    pub async fn rename(
        &self,
        actor: &AuthenticatedSession,
        name: &str,
    ) -> Result<MeResponse, AuthError> {
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 100 || name.chars().any(char::is_control) {
            return Err(AuthError::InvalidName);
        }
        if !self.repository.rename(actor.user().id, name.into()).await? {
            return Err(AuthError::Policy(PolicyError::Unauthenticated));
        }
        let mut me = actor.me();
        me.user.display_name = name.into();
        Ok(me)
    }
    pub async fn logout(&self, actor: &AuthenticatedSession) -> Result<(), AuthError> {
        self.repository
            .revoke_all(actor.user().id)
            .await
            .map_err(Into::into)
    }
    pub async fn devices(&self, actor: &AuthenticatedSession) -> Result<DeviceList, AuthError> {
        Ok(DeviceList {
            sessions: self
                .repository
                .devices(actor.user().id, actor.session_id(), Utc::now())
                .await?,
        })
    }
    pub async fn revoke_device(
        &self,
        actor: &AuthenticatedSession,
        device: Uuid,
    ) -> Result<(), AuthError> {
        if !self
            .repository
            .revoke_device(actor.user().id, device)
            .await?
        {
            return Err(AuthError::NotFound);
        }
        Ok(())
    }
}
