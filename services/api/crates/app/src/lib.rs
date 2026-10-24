pub mod admin_http;
pub mod assets_http;
pub mod auth_http;
pub mod billing_http;
pub mod canvas_http;
pub mod chat_http;
pub mod config;
pub mod generation_http;
pub mod login_http;
pub mod routes;
pub mod upstream_http;
pub mod wallet_http;
use atelier_auth::{
    postgres::PostgresSessions,
    service::{PublicOrigin, SessionService},
};
pub use routes::{openapi, router};
use sqlx::PgPool;
use std::{path::PathBuf, sync::Arc};

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub web_dir: PathBuf,
    pub expose_openapi: bool,
    pub auth: SessionService,
    pub login: Option<atelier_auth::login::LoginService>,
    pub mfa: Option<atelier_auth::mfa::MfaService>,
    pub limits: Option<Arc<dyn atelier_auth::transient::TransientStore>>,
    pub assets: Option<atelier_assets::AssetService>,
    pub upstream: Option<atelier_upstream::UpstreamService>,
    pub generation: Option<atelier_generation::GenerationService>,
    pub canvas: Option<atelier_canvas::CanvasService>,
    pub chat: Option<atelier_chat::ChatService>,
    pub code_cipher: Option<atelier_wallet::RedeemCodeCipher>,
    pub trusted_proxy_ips: Arc<std::collections::HashSet<std::net::IpAddr>>,
}

impl AppState {
    /// Lazy pool: router contract tests require neither PostgreSQL nor Redis.
    pub fn test() -> Self {
        let db = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://localhost/atelier_test")
            .expect("valid test URL");
        Self {
            auth: SessionService::new(
                Arc::new(PostgresSessions::new(db.clone())),
                PublicOrigin::parse("https://atelier.test").expect("test origin"),
            ),
            login: None,
            mfa: None,
            limits: None,
            assets: None,
            upstream: None,
            generation: None,
            canvas: None,
            chat: None,
            code_cipher: None,
            trusted_proxy_ips: Arc::new(std::collections::HashSet::new()),
            db,
            web_dir: "__no_static_assets__".into(),
            expose_openapi: false,
        }
    }
}
