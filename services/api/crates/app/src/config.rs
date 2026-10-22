use atelier_auth::service::PublicOrigin;
use std::{net::SocketAddr, path::PathBuf};
use thiserror::Error;

#[derive(Clone)]
pub struct Config {
    pub database_url: String,
    pub bind_address: SocketAddr,
    pub web_dir: PathBuf,
    pub expose_openapi: bool,
    pub public_origin: PublicOrigin,
}

#[derive(Debug, Error)]
#[error("Invalid or missing configuration: {0}")]
pub struct ConfigError(&'static str);

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        Self::from_lookup(|key| std::env::var(key).ok())
    }

    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Result<Self, ConfigError> {
        let database_url = lookup("DATABASE_URL")
            .filter(|v| !v.trim().is_empty())
            .ok_or(ConfigError("DATABASE_URL"))?;
        if !(database_url.starts_with("postgres://") || database_url.starts_with("postgresql://")) {
            return Err(ConfigError("DATABASE_URL"));
        }
        let public_origin =
            PublicOrigin::parse(&lookup("PUBLIC_BASE_URL").ok_or(ConfigError("PUBLIC_BASE_URL"))?)
                .map_err(|_| ConfigError("PUBLIC_BASE_URL"))?;
        let bind_address: SocketAddr = lookup("BIND_ADDRESS")
            .unwrap_or_else(|| "127.0.0.1:8080".into())
            .parse()
            .map_err(|_| ConfigError("BIND_ADDRESS"))?;
        let expose_openapi = match lookup("EXPOSE_OPENAPI").as_deref() {
            None | Some("false") => false,
            Some("true") if bind_address.ip().is_loopback() => true,
            _ => return Err(ConfigError("EXPOSE_OPENAPI requires loopback binding")),
        };
        Ok(Self {
            database_url,
            bind_address,
            expose_openapi,
            public_origin,
            web_dir: lookup("WEB_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| "../../apps/web/dist".into()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn load(values: &[(&str, &str)]) -> Result<Config, ConfigError> {
        Config::from_lookup(|key| {
            values
                .iter()
                .find(|(k, _)| *k == key)
                .map(|(_, v)| v.to_string())
                .or_else(|| (key == "PUBLIC_BASE_URL").then(|| "https://atelier.test".into()))
        })
    }
    #[test]
    fn missing_database_fails_without_revealing_secrets() {
        assert!(load(&[]).is_err());
        let error = load(&[("DATABASE_URL", "https://user:secret@host")])
            .err()
            .unwrap();
        assert!(!error.to_string().contains("secret"));
    }
    #[test]
    fn openapi_requires_explicit_loopback_development_config() {
        let base = ("DATABASE_URL", "postgres://localhost/atelier");
        assert!(!load(&[base]).unwrap().expose_openapi);
        assert!(
            load(&[base, ("EXPOSE_OPENAPI", "true")])
                .unwrap()
                .expose_openapi
        );
        assert!(load(&[
            base,
            ("EXPOSE_OPENAPI", "true"),
            ("BIND_ADDRESS", "0.0.0.0:8080")
        ])
        .is_err());
        assert!(load(&[base, ("EXPOSE_OPENAPI", "yes")]).is_err());
    }
    #[test]
    fn public_origin_is_required_and_invalid_values_are_redacted() {
        assert!(Config::from_lookup(
            |key| (key == "DATABASE_URL").then(|| "postgres://localhost/atelier".into())
        )
        .is_err());
        let error = load(&[
            ("DATABASE_URL", "postgres://localhost/atelier"),
            ("PUBLIC_BASE_URL", "https://user:secret@atelier.test"),
        ])
        .err()
        .unwrap();
        assert_eq!(
            error.to_string(),
            "Invalid or missing configuration: PUBLIC_BASE_URL"
        );
        assert!(load(&[
            ("DATABASE_URL", "postgres://localhost/atelier"),
            ("PUBLIC_BASE_URL", "http://external.test")
        ])
        .is_err());
    }
}
