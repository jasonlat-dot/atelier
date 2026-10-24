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
    let media_storage = config
        .media
        .build(&config.web_dir)
        .await
        .map_err(|_| "Media storage configuration unavailable")?;
    let mut assets =
        atelier_assets::AssetService::new(db.clone(), media_storage, config.media_signer);
    if let Some(processor) = config.video {
        if processor.available().await {
            assets = assets.with_video(processor);
        } else {
            tracing::warn!("Video tools unavailable; image uploads remain available");
        }
    }
    let upstream = atelier_upstream::UpstreamService::new(
        db.clone(),
        config.upstream_cipher,
        atelier_upstream::egress::SafeHttp::new(config.upstream_egress),
    )
    .with_slots(
        atelier_upstream::slots::SlotStore::connect(&config.redis_url, "atelier:upstream")
            .await
            .map_err(|_| "Upstream Redis unavailable")?,
    );
    let generation = atelier_generation::GenerationService::new(db.clone(), assets.clone())
        .with_events(&config.redis_url, "atelier:generation")
        .await?;
    let generation_worker =
        atelier_generation::GenerationWorker::new(generation.clone(), upstream.clone());
    let state = AppState {
        code_cipher: Some(config.code_cipher),
        chat: Some(atelier_chat::ChatService::new(db.clone(), upstream.clone())),
        canvas: Some(atelier_canvas::CanvasService::new(
            db.clone(),
            assets.clone(),
        )),
        generation: Some(generation.clone()),
        upstream: Some(upstream.clone()),
        assets: Some(assets.clone()),
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
    let billing_maintenance =
        tokio::spawn(atelier_wallet::BillingService::new(db.clone()).maintenance_loop());
    let reconciliation =
        tokio::spawn(atelier_wallet::WalletService::new(db.clone()).reconciliation_loop());
    let chat_recovery =
        tokio::spawn(atelier_chat::ChatService::new(db.clone(), upstream.clone()).recovery_loop());
    let video_processing = tokio::spawn(assets.clone().processing_loop());
    let generation_processing = tokio::spawn(generation_worker.run());
    let generation_events = tokio::spawn(generation.event_loop());
    let upstream_health = tokio::spawn(upstream.maintenance_loop());
    let media_maintenance = tokio::spawn(assets.maintenance_loop());
    tracing::info!(address = %config.bind_address, "Atelier API listening");
    axum::serve(
        listener,
        router(state).into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown())
    .await?;
    billing_maintenance.abort();
    reconciliation.abort();
    chat_recovery.abort();
    media_maintenance.abort();
    video_processing.abort();
    generation_processing.abort();
    generation_events.abort();
    upstream_health.abort();
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
