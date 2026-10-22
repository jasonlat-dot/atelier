use atelier_app::{config::Config, router, AppState};
use atelier_auth::{postgres::PostgresSessions, service::SessionService};
use sqlx::postgres::PgPoolOptions;
use std::{sync::Arc, time::Duration};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "atelier_app=info,tower_http=info".into()),
        )
        .init();
    let config = Config::from_env()?;
    let db = PgPoolOptions::new()
        .max_connections(12)
        .acquire_timeout(Duration::from_secs(10))
        .connect(&config.database_url)
        .await?;
    sqlx::migrate!("../../migrations").run(&db).await?;
    let state = AppState {
        db: db.clone(),
        auth: SessionService::new(
            Arc::new(PostgresSessions::new(db.clone())),
            config.public_origin,
        ),
        web_dir: config.web_dir,
        expose_openapi: config.expose_openapi,
    };
    let listener = tokio::net::TcpListener::bind(config.bind_address).await?;
    tracing::info!(address = %config.bind_address, "Atelier API listening");
    axum::serve(listener, router(state))
        .with_graceful_shutdown(shutdown())
        .await?;
    db.close().await;
    Ok(())
}

async fn shutdown() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("install Ctrl-C handler");
    };
    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("install SIGTERM handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! { () = ctrl_c => {}, () = terminate => {} }
}
