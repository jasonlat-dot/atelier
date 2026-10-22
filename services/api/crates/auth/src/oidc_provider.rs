//! Google token exchange and RS256 verification. Uses ring, never the rsa crate.
use crate::{
    identity::{AuthFailure, AuthFuture},
    policy::{validate_google_identity, GoogleIdentity},
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use ring::signature::{RsaPublicKeyComponents, RSA_PKCS1_2048_8192_SHA256};
use serde::Deserialize;
use std::time::Duration;
use subtle::ConstantTimeEq;
#[derive(Clone)]
pub struct VerifiedIdentity {
    identity: GoogleIdentity,
    display_name: String,
}
impl VerifiedIdentity {
    pub fn identity(&self) -> &GoogleIdentity {
        &self.identity
    }
    pub fn display_name(&self) -> &str {
        &self.display_name
    }
}
#[derive(Deserialize)]
struct Header {
    alg: String,
    kid: String,
    crit: Option<serde_json::Value>,
}
#[derive(Deserialize)]
struct Keys {
    keys: Vec<Key>,
}
#[derive(Deserialize)]
struct Key {
    kid: Option<String>,
    kty: String,
    n: Option<String>,
    e: Option<String>,
    alg: Option<String>,
    #[serde(rename = "use")]
    purpose: Option<String>,
    key_ops: Option<Vec<String>>,
}
#[derive(Deserialize)]
#[serde(untagged)]
enum Audience {
    One(String),
    Many(Vec<String>),
}
#[derive(Deserialize)]
struct Claims {
    iss: String,
    aud: Audience,
    sub: String,
    email: String,
    email_verified: bool,
    nonce: String,
    exp: u64,
    iat: Option<u64>,
    nbf: Option<u64>,
    azp: Option<String>,
    name: Option<String>,
}
pub fn verify_id_token(
    token: &str,
    jwks: &str,
    client_id: &str,
    nonce: &str,
    now: i64,
) -> Result<VerifiedIdentity, AuthFailure> {
    let invalid = || AuthFailure::Identity;
    if token.len() > 16384
        || jwks.len() > 131072
        || client_id.is_empty()
        || nonce.is_empty()
        || now < 0
    {
        return Err(invalid());
    }
    let parts: Vec<_> = token.split('.').collect();
    if parts.len() != 3 || parts[0].len() > 2048 {
        return Err(invalid());
    }
    let header: Header = serde_json::from_slice(&B64.decode(parts[0]).map_err(|_| invalid())?)
        .map_err(|_| invalid())?;
    if header.alg != "RS256" || header.kid.is_empty() || header.crit.is_some() {
        return Err(invalid());
    }
    let keys: Keys = serde_json::from_str(jwks).map_err(|_| invalid())?;
    if keys.keys.len() > 50 {
        return Err(invalid());
    }
    let mut matching = keys
        .keys
        .iter()
        .filter(|k| k.kid.as_deref() == Some(&header.kid));
    let key = matching.next().ok_or_else(invalid)?;
    if matching.next().is_some()
        || key.kty != "RSA"
        || key.alg.as_deref().is_some_and(|a| a != "RS256")
        || key.purpose.as_deref().is_some_and(|u| u != "sig")
        || key.key_ops.as_ref().is_some_and(|ops| ops != &["verify"])
    {
        return Err(invalid());
    }
    let n = B64
        .decode(key.n.as_ref().ok_or_else(invalid)?)
        .map_err(|_| invalid())?;
    let e = B64
        .decode(key.e.as_ref().ok_or_else(invalid)?)
        .map_err(|_| invalid())?;
    let sig = B64.decode(parts[2]).map_err(|_| invalid())?;
    RsaPublicKeyComponents { n: &n, e: &e }
        .verify(
            &RSA_PKCS1_2048_8192_SHA256,
            format!("{}.{}", parts[0], parts[1]).as_bytes(),
            &sig,
        )
        .map_err(|_| invalid())?;
    let payload = B64.decode(parts[1]).map_err(|_| invalid())?;
    let claims: Claims = serde_json::from_slice(&payload).map_err(|_| invalid())?;
    let raw: serde_json::Value = serde_json::from_slice(&payload).map_err(|_| invalid())?;
    let audience = match claims.aud {
        Audience::One(v) => v == client_id,
        Audience::Many(v) => v.len() == 1 && v[0] == client_id,
    };
    if !["https://accounts.google.com", "accounts.google.com"].contains(&claims.iss.as_str())
        || !audience
        || claims.exp <= now as u64
        || claims.iat.is_some_and(|i| i > now as u64 + 60)
        || claims.nbf.is_some_and(|n| n > now as u64)
        || claims.azp.as_deref().is_some_and(|a| a != client_id)
        || !bool::from(claims.nonce.as_bytes().ct_eq(nonce.as_bytes()))
        || raw.get("hd").is_some()
    {
        return Err(invalid());
    }
    let identity =
        validate_google_identity(&claims.sub, &claims.email, claims.email_verified, None)
            .map_err(|_| invalid())?;
    let display_name = claims
        .name
        .filter(|v| {
            !v.trim().is_empty()
                && v.trim().chars().count() <= 100
                && !v.chars().any(char::is_control)
        })
        .map(|v| v.trim().to_owned())
        .unwrap_or_else(|| identity.email.split('@').next().unwrap_or("User").into());
    Ok(VerifiedIdentity {
        identity,
        display_name,
    })
}
pub trait IdentityProvider: Send + Sync {
    fn exchange(
        &self,
        code: String,
        verifier: String,
        nonce: String,
    ) -> AuthFuture<'_, VerifiedIdentity>;
}
pub struct GoogleProvider {
    client: reqwest::Client,
    client_id: String,
    secret: String,
    callback: String,
}
impl GoogleProvider {
    pub fn new(client_id: String, secret: String, callback: String) -> Result<Self, AuthFailure> {
        if client_id.is_empty() || secret.is_empty() {
            return Err(AuthFailure::Store);
        }
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(3))
            .timeout(Duration::from_secs(10))
            .build()
            .map_err(|_| AuthFailure::Store)?;
        Ok(Self {
            client,
            client_id,
            secret,
            callback,
        })
    }
}
async fn bounded(mut response: reqwest::Response) -> Result<Vec<u8>, AuthFailure> {
    if !response.status().is_success() || response.content_length().is_some_and(|n| n > 131072) {
        return Err(AuthFailure::Identity);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| AuthFailure::Store)? {
        if bytes.len() + chunk.len() > 131072 {
            return Err(AuthFailure::Identity);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
impl IdentityProvider for GoogleProvider {
    fn exchange(
        &self,
        code: String,
        verifier: String,
        nonce: String,
    ) -> AuthFuture<'_, VerifiedIdentity> {
        Box::pin(async move {
            if code.is_empty() || code.len() > 4096 || !(43..=128).contains(&verifier.len()) {
                return Err(AuthFailure::Identity);
            }
            #[derive(Deserialize)]
            struct Token {
                id_token: String,
            }
            let response = self
                .client
                .post("https://oauth2.googleapis.com/token")
                .form(&[
                    ("grant_type", "authorization_code"),
                    ("client_id", &self.client_id),
                    ("client_secret", &self.secret),
                    ("redirect_uri", &self.callback),
                    ("code", &code),
                    ("code_verifier", &verifier),
                ])
                .send()
                .await
                .map_err(|_| AuthFailure::Store)?;
            let token: Token = serde_json::from_slice(&bounded(response).await?)
                .map_err(|_| AuthFailure::Identity)?;
            let keys = self
                .client
                .get("https://www.googleapis.com/oauth2/v3/certs")
                .send()
                .await
                .map_err(|_| AuthFailure::Store)?;
            let keys = bounded(keys).await?;
            let keys = std::str::from_utf8(&keys).map_err(|_| AuthFailure::Identity)?;
            verify_id_token(
                &token.id_token,
                keys,
                &self.client_id,
                &nonce,
                chrono::Utc::now().timestamp(),
            )
        })
    }
}
