//! Opaque session material. Database lookup is by SHA-256 of the encoded token.
//! This utility does not create a database session or authenticate a request.
use crate::policy::PolicyError;
use axum::http::{header, HeaderMap};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use sha2::{Digest, Sha256};
use std::fmt;

pub struct SessionSecrets {
    token: String,
    csrf_token: String,
}
impl fmt::Debug for SessionSecrets {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SessionSecrets([REDACTED])")
    }
}
impl SessionSecrets {
    pub fn generate() -> Result<Self, getrandom::Error> {
        let mut token = [0_u8; 32];
        let mut csrf = [0_u8; 32];
        getrandom::fill(&mut token)?;
        getrandom::fill(&mut csrf)?;
        Ok(Self {
            token: URL_SAFE_NO_PAD.encode(token),
            csrf_token: URL_SAFE_NO_PAD.encode(csrf),
        })
    }
    pub fn token_hash(&self) -> [u8; 32] {
        Sha256::digest(self.token.as_bytes()).into()
    }
    pub fn csrf_token(&self) -> &str {
        &self.csrf_token
    }
    pub fn cookie(&self) -> String {
        format!(
            "__Host-sid={}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000",
            self.token
        )
    }
}

pub fn token_hash(headers: &HeaderMap) -> Result<[u8; 32], PolicyError> {
    let mut token = None;
    for value in headers.get_all(header::COOKIE) {
        let value = value.to_str().map_err(|_| PolicyError::Unauthenticated)?;
        for pair in value.split(';') {
            let Some((name, value)) = pair.trim().split_once('=') else {
                continue;
            };
            if name == "__Host-sid" && token.replace(value).is_some() {
                return Err(PolicyError::Unauthenticated);
            }
        }
    }
    let token = token.ok_or(PolicyError::Unauthenticated)?;
    if token.len() != 43
        || URL_SAFE_NO_PAD
            .decode(token)
            .map_err(|_| PolicyError::Unauthenticated)?
            .len()
            != 32
    {
        return Err(PolicyError::Unauthenticated);
    }
    Ok(Sha256::digest(token.as_bytes()).into())
}

/// Reject repeated security headers before passing values to the pure policy.
pub fn validate_csrf_headers(
    method: &str,
    headers: &HeaderMap,
    expected_origin: &str,
    expected_token: &str,
) -> Result<(), PolicyError> {
    if method == "GET" {
        return Ok(());
    }
    fn single<'a>(headers: &'a HeaderMap, name: &str) -> Result<&'a str, PolicyError> {
        let mut values = headers.get_all(name).iter();
        let value = values.next().ok_or(PolicyError::CsrfRejected)?;
        if values.next().is_some() {
            return Err(PolicyError::CsrfRejected);
        }
        value.to_str().map_err(|_| PolicyError::CsrfRejected)
    }
    crate::policy::csrf_allowed(
        method,
        expected_origin,
        Some(single(headers, "origin")?),
        Some(single(headers, "x-csrf-token")?),
        expected_token,
    )
}
