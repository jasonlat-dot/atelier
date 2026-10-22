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
    pub redis_url: String,
    pub google_client_id: String,
    pub google_client_secret: String,
    pub master_cipher: atelier_auth::mfa::MfaCipher,
    pub bootstrap: std::collections::HashSet<String>,
    pub trusted_proxy_ips: std::collections::HashSet<std::net::IpAddr>,
    pub media: atelier_assets::storage::StorageConfig,
    pub media_signer: atelier_assets::signing::MediaSigner,
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
        // Authentication credentials and encryption key have NO defaults.
        let required = |key| {
            lookup(key)
                .filter(|v| !v.trim().is_empty())
                .ok_or(ConfigError(key))
        };
        let redis_url = required("REDIS_URL")?;
        if !(redis_url.starts_with("redis://") || redis_url.starts_with("rediss://")) {
            return Err(ConfigError("REDIS_URL"));
        }
        let google_client_id = required("GOOGLE_CLIENT_ID")?;
        let google_client_secret = required("GOOGLE_CLIENT_SECRET")?;
        let master_cipher = atelier_auth::mfa::MfaCipher::from_base64(&required("MASTER_KEY")?)
            .map_err(|_| ConfigError("MASTER_KEY"))?;
        let mut bootstrap = std::collections::HashSet::new();
        let media =
            atelier_assets::storage::StorageConfig::from_lookup(&lookup).map_err(ConfigError)?;
        let media_signer =
            atelier_assets::signing::MediaSigner::from_base64(&required("MASTER_KEY")?)
                .map_err(|_| ConfigError("MASTER_KEY"))?;
        for email in required("BOOTSTRAP_ADMIN_EMAILS")?.split(',') {
            bootstrap.insert(
                atelier_auth::policy::canonical_email(email.trim())
                    .map_err(|_| ConfigError("BOOTSTRAP_ADMIN_EMAILS"))?,
            );
        }
        let mut trusted_proxy_ips = std::collections::HashSet::new();
        if let Some(ips) = lookup("TRUSTED_PROXY_IPS") {
            for ip in ips.split(',').filter(|v| !v.trim().is_empty()) {
                trusted_proxy_ips.insert(
                    ip.trim()
                        .parse()
                        .map_err(|_| ConfigError("TRUSTED_PROXY_IPS"))?,
                );
            }
        }
        Ok(Self {
            media,
            media_signer,
            redis_url,
            google_client_id,
            google_client_secret,
            master_cipher,
            bootstrap,
            trusted_proxy_ips,
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
