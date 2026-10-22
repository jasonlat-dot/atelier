pub mod config;
pub mod routes;
pub use routes::{openapi, router};
use sqlx::PgPool;
use std::path::PathBuf;

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub web_dir: PathBuf,
    pub expose_openapi: bool,
}

impl AppState {
    /// Lazy pool: router contract tests require neither PostgreSQL nor Redis.
    pub fn test() -> Self {
        Self {
            db: sqlx::postgres::PgPoolOptions::new()
                .connect_lazy("postgres://localhost/atelier_test")
                .expect("valid test URL"),
            web_dir: "__no_static_assets__".into(),
            expose_openapi: false,
        }
    }
}
