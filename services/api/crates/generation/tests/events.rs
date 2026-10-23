use atelier_assets::{signing::MediaSigner, storage::Storage, AssetService};
use atelier_generation::GenerationService;
use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::StreamExt;
use redis::AsyncCommands;
use uuid::Uuid;
#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL and TEST_REDIS_URL"]
async fn committed_pg_notifications_broadcast_through_redis_to_another_instance(db: sqlx::PgPool) {
    let url = std::env::var("TEST_REDIS_URL").unwrap();
    let prefix = format!("broadcast-test:{}", Uuid::new_v4());
    let assets = AssetService::new(
        db.clone(),
        Storage::memory(),
        MediaSigner::from_base64(&STANDARD.encode([61; 32])).unwrap(),
    );
    let first = GenerationService::new(db.clone(), assets.clone())
        .with_events(&url, &prefix)
        .await
        .unwrap();
    let second = GenerationService::new(db.clone(), assets)
        .with_events(&url, &prefix)
        .await
        .unwrap();
    let one = tokio::spawn(first.event_loop());
    let peer = second.clone();
    let two = tokio::spawn(peer.event_loop());
    let client = redis::Client::open(url).unwrap();
    let mut subscription = client.get_async_pubsub().await.unwrap();
    subscription
        .subscribe(format!("{prefix}:job-events"))
        .await
        .unwrap();
    let owner = Uuid::new_v4().to_string();
    let mut incoming = subscription.on_message();
    let mut observed = false;
    for _ in 0..50 {
        sqlx::query("SELECT pg_notify('atelier_job_events',$1)")
            .bind(&owner)
            .execute(&db)
            .await
            .unwrap();
        if let Ok(Some(message)) =
            tokio::time::timeout(std::time::Duration::from_millis(100), incoming.next()).await
        {
            assert_eq!(message.get_payload::<String>().unwrap(), owner);
            observed = true;
            break;
        }
    }
    assert!(observed);
    let wait = tokio::spawn(async move {
        second.wait_events().await;
    });
    let mut publisher = client.get_multiplexed_async_connection().await.unwrap();
    for _ in 0..50 {
        let _: i64 = publisher
            .publish(format!("{prefix}:job-events"), &owner)
            .await
            .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        if wait.is_finished() {
            break;
        }
    }
    tokio::time::timeout(std::time::Duration::from_secs(2), wait)
        .await
        .unwrap()
        .unwrap();
    one.abort();
    two.abort();
}
