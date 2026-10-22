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
                .unwrap_or_else(|_| "atelier_app=info,atelier_wallet=info,tower_http=info".into()),
        )
        .init();
    let config = Config::from_env()?;
    let db = PgPoolOptions::new()
        .max_connections(12)
        .acquire_timeout(Duration::from_secs(10))
        .connect(&config.database_url)
        .await?;
    sqlx::migrate!("../../migrations").run(&db).await?;
    atelier_wallet::WalletService::new(db.clone())
        .restrict_ledger()
        .await?;
    let limits = Arc::new(
        atelier_auth::transient::RedisTransient::connect(&config.redis_url)
            .await
            .map_err(|_| "Redis unavailable")?,
    );
    let identity = Arc::new(atelier_auth::identity::PostgresIdentity::new(
        db.clone(),
        config.bootstrap,
    ));
    let callback = format!(
        "{}/api/v1/auth/google/callback",
        config.public_origin.as_str()
    );
    let flow = atelier_auth::oidc_attempt::AttemptFlow::new(
        limits.clone(),
        config.google_client_id.clone(),
        callback.clone(),
    )?;
    let provider = Arc::new(
        atelier_auth::oidc_provider::GoogleProvider::new(
            config.google_client_id,
            config.google_client_secret,
            callback,
        )
        .map_err(|_| "OIDC configuration invalid")?,
    );
    let state = AppState {
        login: Some(atelier_auth::login::LoginService::new(
            flow,
            provider,
            identity.clone(),
        )),
        mfa: Some(atelier_auth::mfa::MfaService::new(
            identity,
            limits.clone(),
            config.master_cipher,
        )),
        limits: Some(limits),
        trusted_proxy_ips: Arc::new(config.trusted_proxy_ips),
        db: db.clone(),
        auth: SessionService::new(
            Arc::new(PostgresSessions::new(db.clone())),
            config.public_origin,
        ),
        web_dir: config.web_dir,
        expose_openapi: config.expose_openapi,
    };
    let listener = tokio::net::TcpListener::bind(config.bind_address).await?;
    let reconciliation =
        tokio::spawn(atelier_wallet::WalletService::new(db.clone()).reconciliation_loop());
    tracing::info!(address = %config.bind_address, "Atelier API listening");
    axum::serve(
        listener,
        router(state).into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown())
    .await?;
    reconciliation.abort();
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
