pub mod auth_http;
pub mod config;
pub mod routes;
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
            db,
            web_dir: "__no_static_assets__".into(),
            expose_openapi: false,
        }
    }
}
