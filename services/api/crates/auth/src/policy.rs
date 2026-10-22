//! M1 pure policies. No function in this module establishes a trusted identity.
//! Google signature/issuer/audience/nonce/expiry verification must happen first.
use chrono::{DateTime, Duration, Utc};
use subtle::ConstantTimeEq;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PolicyError {
    InvalidIdentity,
    RegistrationClosed,
    InviteRequired,
    RegistrationRateLimited,
    Unauthenticated,
    AccountDisabled,
    Forbidden,
    MfaRequired,
    CsrfRejected,
}

pub fn canonical_email(email: &str) -> Result<String, PolicyError> {
    if email.len() > 254 || email.chars().any(char::is_whitespace) {
        return Err(PolicyError::InvalidIdentity);
    }
    let (local, domain) = email.split_once('@').ok_or(PolicyError::InvalidIdentity)?;
    if local.is_empty()
        || local.len() > 64
        || !(domain.eq_ignore_ascii_case("gmail.com")
            || domain.eq_ignore_ascii_case("googlemail.com"))
        || !local
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b".+_-".contains(&c))
    {
        return Err(PolicyError::InvalidIdentity);
    }
    let base = local
        .split('+')
        .next()
        .ok_or(PolicyError::InvalidIdentity)?;
    if !base.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'.') {
        return Err(PolicyError::InvalidIdentity);
    }
    let canonical = base.replace('.', "").to_ascii_lowercase();
    if canonical.is_empty() {
        return Err(PolicyError::InvalidIdentity);
    }
    Ok(format!("{canonical}@gmail.com"))
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GoogleIdentity {
    pub google_sub: String,
    pub email: String,
    pub canonical_email: String,
}

/// Claim policy only. This is NOT an ID-token or JWT verifier.
/// The caller must pass claims from an already cryptographically verified token.
pub fn validate_google_identity(
    sub: &str,
    email: &str,
    email_verified: bool,
    hd: Option<&str>,
) -> Result<GoogleIdentity, PolicyError> {
    if sub.is_empty()
        || sub.len() > 255
        || sub.chars().any(char::is_control)
        || !email_verified
        || hd.is_some()
        || !email
            .rsplit_once('@')
            .is_some_and(|(_, domain)| domain.eq_ignore_ascii_case("gmail.com"))
    {
        return Err(PolicyError::InvalidIdentity);
    }
    Ok(GoogleIdentity {
        google_sub: sub.into(),
        email: email.to_ascii_lowercase(),
        canonical_email: canonical_email(email)?,
    })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RegistrationMode {
    Open,
    InviteOnly,
    Closed,
}

#[derive(Clone, Copy, Debug)]
pub struct RegistrationContext {
    pub existing_user: bool,
    pub bootstrap_admin: bool,
    pub whitelisted: bool,
    pub valid_invite: bool,
    pub registrations_24h: u32,
    pub max_registrations_24h: u32,
}
impl Default for RegistrationContext {
    fn default() -> Self {
        Self {
            existing_user: false,
            bootstrap_admin: false,
            whitelisted: false,
            valid_invite: false,
            registrations_24h: 0,
            max_registrations_24h: 3,
        }
    }
}

/// Called inside the registration transaction after reading current settings.
/// Counts and invitation consumption must be serialized in the repository.
pub fn registration_allowed(
    mode: RegistrationMode,
    context: RegistrationContext,
) -> Result<(), PolicyError> {
    if context.existing_user {
        return Ok(());
    }
    if context.registrations_24h >= context.max_registrations_24h {
        return Err(PolicyError::RegistrationRateLimited);
    }
    if context.bootstrap_admin {
        return Ok(());
    }
    match mode {
        RegistrationMode::Open => Ok(()),
        RegistrationMode::Closed => Err(PolicyError::RegistrationClosed),
        RegistrationMode::InviteOnly if context.whitelisted || context.valid_invite => Ok(()),
        RegistrationMode::InviteOnly => Err(PolicyError::InviteRequired),
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize, utoipa::ToSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Role {
    User,
    Admin,
    SuperAdmin,
}
impl TryFrom<&str> for Role {
    type Error = PolicyError;
    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "USER" => Ok(Self::User),
            "ADMIN" => Ok(Self::Admin),
            "SUPER_ADMIN" => Ok(Self::SuperAdmin),
            _ => Err(PolicyError::Forbidden),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UserStatus {
    Active,
    Disabled,
}

#[derive(Clone, Copy, Debug)]
pub struct SessionWindow {
    pub created_at: DateTime<Utc>,
    pub last_seen_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub revoked: bool,
}

pub fn session_allowed(
    window: &SessionWindow,
    status: UserStatus,
    now: DateTime<Utc>,
) -> Result<(), PolicyError> {
    if status == UserStatus::Disabled {
        return Err(PolicyError::AccountDisabled);
    }
    if window.revoked
        || window.created_at > now
        || window.last_seen_at > now
        || window.last_seen_at < window.created_at
        || now >= window.expires_at
        || window.expires_at > window.created_at + Duration::days(30)
        || now >= window.created_at + Duration::days(30)
        || now >= window.last_seen_at + Duration::days(7)
    {
        return Err(PolicyError::Unauthenticated);
    }
    Ok(())
}

/// These roles must come from the database for the current request, never JSON.
pub fn require_admin(
    role: Role,
    required: Role,
    mfa_enabled: bool,
    verified_at: Option<DateTime<Utc>>,
    now: DateTime<Utc>,
) -> Result<(), PolicyError> {
    if required == Role::User
        || role == Role::User
        || (required == Role::SuperAdmin && role != Role::SuperAdmin)
    {
        return Err(PolicyError::Forbidden);
    }
    if !mfa_enabled
        || !verified_at
            .is_some_and(|verified| verified <= now && now < verified + Duration::hours(12))
    {
        return Err(PolicyError::MfaRequired);
    }
    Ok(())
}

pub fn require_mfa_enrollment(role: Role) -> Result<(), PolicyError> {
    match role {
        Role::User => Err(PolicyError::Forbidden),
        Role::Admin | Role::SuperAdmin => Ok(()),
    }
}

/// expected_origin is the normalized origin from trusted server configuration.
/// Header extraction must reject repeated Origin and X-CSRF-Token headers.
pub fn csrf_allowed(
    method: &str,
    expected_origin: &str,
    origin: Option<&str>,
    supplied: Option<&str>,
    expected_token: &str,
) -> Result<(), PolicyError> {
    if method == "GET" {
        return Ok(());
    }
    if expected_origin.is_empty() || origin != Some(expected_origin) || expected_token.len() < 43 {
        return Err(PolicyError::CsrfRejected);
    }
    let supplied = supplied.ok_or(PolicyError::CsrfRejected)?;
    if !bool::from(supplied.as_bytes().ct_eq(expected_token.as_bytes())) {
        return Err(PolicyError::CsrfRejected);
    }
    Ok(())
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::User => "USER",
            Self::Admin => "ADMIN",
            Self::SuperAdmin => "SUPER_ADMIN",
        }
    }
}
