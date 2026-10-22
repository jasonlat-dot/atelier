//! OIDC request preparation only. A consumed attempt is NOT an authenticated user.
use crate::{
    service::PublicOrigin,
    transient::{RateDecision, TransientStore, LOGIN_RATE},
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::Utc;
use oauth2::{
    basic::BasicClient, AuthUrl, ClientId, CsrfToken, PkceCodeChallenge, RedirectUrl, Scope,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fmt, net::IpAddr, sync::Arc};
use url::Url;

#[derive(Clone, Serialize, Deserialize)]
pub struct AttemptRecord {
    nonce: String,
    pkce_verifier: String,
    browser_hash: String,
    created_at: i64,
}
impl fmt::Debug for AttemptRecord {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("AttemptRecord([REDACTED])")
    }
}
impl AttemptRecord {
    pub fn nonce(&self) -> &str {
        &self.nonce
    }
    pub fn pkce_verifier(&self) -> &str {
        &self.pkce_verifier
    }
    pub fn browser_hash(&self) -> &str {
        &self.browser_hash
    }
}

pub struct BeginAttempt {
    pub authorization_url: String,
    pub browser_cookie: String,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BeginError {
    Unavailable,
    InvalidState,
    Limited { retry_after_seconds: u64 },
}
#[derive(Clone)]
pub struct AttemptFlow {
    store: Arc<dyn TransientStore>,
    client_id: String,
    callback: String,
}
fn random_token() -> Result<String, BeginError> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| BeginError::Unavailable)?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}
fn digest(value: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(value.as_bytes()))
}
fn token_valid(token: &str) -> bool {
    token.len() == 43 && URL_SAFE_NO_PAD.decode(token).is_ok_and(|v| v.len() == 32)
}
fn state_key(state: &str) -> String {
    format!("auth:oidc:{}", digest(state))
}
impl AttemptFlow {
    pub fn new(
        store: Arc<dyn TransientStore>,
        client_id: String,
        callback: String,
    ) -> Result<Self, &'static str> {
        if client_id.is_empty()
            || client_id.len() > 512
            || client_id.chars().any(char::is_whitespace)
        {
            return Err("GOOGLE_CLIENT_ID");
        }
        let url = Url::parse(&callback).map_err(|_| "OIDC_CALLBACK")?;
        if url.path() != "/api/v1/auth/google/callback"
            || url.query().is_some()
            || url.fragment().is_some()
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err("OIDC_CALLBACK");
        }
        PublicOrigin::parse(&url.origin().ascii_serialization()).map_err(|_| "OIDC_CALLBACK")?;
        Ok(Self {
            store,
            client_id,
            callback,
        })
    }
    pub async fn begin(&self, ip: IpAddr) -> Result<BeginAttempt, BeginError> {
        let canonical_ip = match ip {
            IpAddr::V6(ip) => ip
                .to_ipv4_mapped()
                .map(IpAddr::V4)
                .unwrap_or(IpAddr::V6(ip)),
            other => other,
        };
        match self
            .store
            .rate_limit(
                format!("auth:login:{}", digest(&canonical_ip.to_string())),
                LOGIN_RATE,
            )
            .await
            .map_err(|_| BeginError::Unavailable)?
        {
            RateDecision::Allowed => {}
            RateDecision::Limited {
                retry_after_seconds,
            } => {
                return Err(BeginError::Limited {
                    retry_after_seconds,
                })
            }
        }
        let client = BasicClient::new(ClientId::new(self.client_id.clone()))
            .set_auth_uri(
                AuthUrl::new("https://accounts.google.com/o/oauth2/v2/auth".into())
                    .expect("fixed provider"),
            )
            .set_redirect_uri(
                RedirectUrl::new(self.callback.clone()).map_err(|_| BeginError::Unavailable)?,
            );
        for _ in 0..3 {
            let (challenge, verifier) = PkceCodeChallenge::new_random_sha256();
            let nonce = random_token()?;
            let (authorization_url, state) = client
                .authorize_url(|| CsrfToken::new_random_len(32))
                .add_scope(Scope::new("openid".into()))
                .add_extra_param("nonce", nonce.clone())
                .add_scope(Scope::new("email".into()))
                .add_scope(Scope::new("profile".into()))
                .set_pkce_challenge(challenge)
                .url();
            let browser = random_token()?;
            let record = AttemptRecord {
                nonce,
                pkce_verifier: verifier.secret().clone(),
                browser_hash: digest(&browser),
                created_at: Utc::now().timestamp(),
            };
            let payload = serde_json::to_string(&record).map_err(|_| BeginError::Unavailable)?;
            if self
                .store
                .save_attempt(state_key(state.secret()), payload, 600)
                .await
                .map_err(|_| BeginError::Unavailable)?
            {
                return Ok(BeginAttempt { authorization_url:authorization_url.into(), browser_cookie:format!("__Host-oidc={browser}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600") });
            }
        }
        Err(BeginError::Unavailable)
    }
    pub async fn consume(&self, state: &str, browser: &str) -> Result<AttemptRecord, BeginError> {
        if !token_valid(state) || !token_valid(browser) {
            return Err(BeginError::InvalidState);
        }
        let payload = self
            .store
            .consume_attempt(state_key(state), digest(browser))
            .await
            .map_err(|_| BeginError::Unavailable)?
            .ok_or(BeginError::InvalidState)?;
        let record: AttemptRecord =
            serde_json::from_str(&payload).map_err(|_| BeginError::Unavailable)?;
        let now = Utc::now().timestamp();
        if record.created_at > now
            || now - record.created_at >= 600
            || record.nonce.is_empty()
            || record.pkce_verifier.len() < 43
            || record.pkce_verifier.len() > 128
        {
            return Err(BeginError::InvalidState);
        }
        Ok(record)
    }
}
