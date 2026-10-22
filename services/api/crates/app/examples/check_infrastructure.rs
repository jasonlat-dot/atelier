//! Explicit operator command: connect to existing services; optionally apply migrations.
use atelier_auth::transient::{RateRule, RedisTransient, TransientStore};
use sqlx::postgres::PgPoolOptions;
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let db = PgPoolOptions::new()
        .max_connections(2)
        .connect(&std::env::var("DATABASE_URL")?)
        .await
        .map_err(|_| "PostgreSQL connection failed (details redacted)")?;
    if std::env::args().any(|a| a == "--migrate") {
        sqlx::migrate!("../../migrations").run(&db).await?;
        // The runtime role may append/read the ledger, never mutate it.
        atelier_wallet::WalletService::new(db.clone())
            .restrict_ledger()
            .await?;
        let can_mutate: bool = sqlx::query_scalar(
            "SELECT has_table_privilege(current_user,'credit_ledger','UPDATE,DELETE,TRUNCATE')",
        )
        .fetch_one(&db)
        .await?;
        if can_mutate {
            return Err("Runtime ledger mutation privileges must be revoked".into());
        }
    }
    let redis = std::env::var("REDIS_URL")?;
    let store = RedisTransient::connect(&redis)
        .await
        .map_err(|_| "Redis connection failed")?;
    store
        .rate_limit(
            format!("atelier:infra-check:{}", uuid::Uuid::new_v4()),
            RateRule {
                limit: 1,
                window_seconds: 1,
            },
        )
        .await
        .map_err(|_| "Redis script check failed")?;
    let mismatches = atelier_wallet::WalletService::new(db.clone())
        .reconcile()
        .await?;
    if !mismatches.is_empty() {
        return Err("Wallet reconciliation failed".into());
    }
    println!("PostgreSQL connected; migrations checked; Redis atomic script passed; wallet reconciliation passed.");
    db.close().await;
    Ok(())
}
