use atelier_assets::{signing::MediaSigner, storage::Storage, AssetService};
use atelier_generation::{GenerationError, GenerationService, JobInput, QuoteInput};
use atelier_wallet::WalletService;
use base64::{engine::general_purpose::STANDARD, Engine};
use sqlx::PgPool;
use uuid::Uuid;
fn service(db: &PgPool) -> GenerationService {
    GenerationService::new(
        db.clone(),
        AssetService::new(
            db.clone(),
            Storage::memory(),
            MediaSigner::from_base64(&STANDARD.encode([53; 32])).unwrap(),
        ),
    )
}
async fn owner(db: &PgPool) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO users(id,google_sub,email,canonical_email,display_name) VALUES($1,$2,$2,$2,'Generation test')").bind(id).bind(format!("{id}@gmail.com")).execute(db).await.unwrap();
    sqlx::query("INSERT INTO wallets(user_id) VALUES($1)")
        .bind(id)
        .execute(db)
        .await
        .unwrap();
    WalletService::new(db.clone())
        .grant(id, 100, &format!("fixture:{id}"))
        .await
        .unwrap();
    id
}
async fn model(db: &PgPool) {
    sqlx::query("INSERT INTO models(id,kind,display_name,upstream_model,enabled,capabilities) VALUES('image','image','Public Image','never-expose-native-id',true,'{\"qualities\":[\"low\",\"high\"],\"ratios\":[\"1:1\",\"16:9\"],\"resolutions\":[\"1K\",\"2K\",\"4K\"],\"max_n\":4,\"max_refs\":4,\"supports_edit\":true}')").execute(db).await.unwrap();
    sqlx::query("INSERT INTO pricing_rules(model_id,quality,base_credits,edit_surcharge) VALUES('image','low',4,3),('image','high',40,3)").execute(db).await.unwrap();
}
fn input() -> JobInput {
    serde_json::from_value(serde_json::json!({"model_id":"image","prompt":"A quiet coast","quality":"low","ratio":"16:9","resolution":"2K","n":2})).unwrap()
}
#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL"]
async fn canvas_generation_link_is_checked_before_hold_and_persisted(db: PgPool) {
    model(&db).await;
    let user = owner(&db).await;
    let other = owner(&db).await;
    let assets = AssetService::new(
        db.clone(),
        Storage::memory(),
        MediaSigner::from_base64(&STANDARD.encode([53; 32])).unwrap(),
    );
    let canvas = atelier_canvas::CanvasService::new(db.clone(), assets);
    let graph:atelier_canvas::CanvasGraph=serde_json::from_value(serde_json::json!({"version":1,"nodes":[{"id":"generator","type":"generate","position":{"x":0,"y":0},"size":{"width":260,"height":200},"data":{"modelId":"image","quality":"low","ratio":"16:9","resolution":"2K","n":2}}],"edges":[],"viewport":{"x":0,"y":0,"zoom":1},"background":"dots"})).unwrap();
    let project = canvas
        .create(
            user,
            Uuid::new_v4(),
            atelier_canvas::CreateProject {
                name: "Creation".into(),
                graph,
            },
        )
        .await
        .unwrap();
    let s = service(&db);
    let mut draft = input();
    draft.project_id = Some(project.project.id);
    draft.node_id = Some("generator".into());
    assert!(matches!(
        s.create(other, Uuid::new_v4(), draft.clone()).await,
        Err(GenerationError::NotFound)
    ));
    assert_eq!(
        WalletService::new(db.clone())
            .summary(other)
            .await
            .unwrap()
            .held,
        0
    );
    draft.node_id = Some("missing".into());
    assert!(matches!(
        s.create(user, Uuid::new_v4(), draft.clone()).await,
        Err(GenerationError::Validation)
    ));
    assert_eq!(
        WalletService::new(db.clone())
            .summary(user)
            .await
            .unwrap()
            .held,
        0
    );
    draft.node_id = Some("generator".into());
    let key = Uuid::new_v4();
    let job = s.create(user, key, draft.clone()).await.unwrap().job;
    assert_eq!(job.project_id, Some(project.project.id));
    assert_eq!(job.node_id.as_deref(), Some("generator"));
    assert_eq!(
        s.list_project(user, None, None, 25, Some(project.project.id))
            .await
            .unwrap()
            .items
            .len(),
        1
    );
    assert!(s
        .list_project(other, None, None, 25, Some(project.project.id))
        .await
        .unwrap()
        .items
        .is_empty());
    canvas.delete(user, project.project.id, 0).await.unwrap();
    assert_eq!(s.create(user, key, draft).await.unwrap().job.id, job.id);
    assert!(
        sqlx::query("UPDATE generation_jobs SET node_id='other' WHERE id=$1")
            .bind(job.id)
            .execute(&db)
            .await
            .is_err()
    );
    s.cancel(user, job.id).await.unwrap();
    assert_eq!(WalletService::new(db).summary(user).await.unwrap().held, 0);
}
#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL"]
async fn authoritative_price_holds_idempotency_and_concurrent_cancellation_are_atomic(db: PgPool) {
    model(&db).await;
    let user = owner(&db).await;
    let other = owner(&db).await;
    let s = service(&db);
    let wallet = WalletService::new(db.clone());
    let mut q: QuoteInput = input().quote();
    q.ref_count = 1;
    assert_eq!(s.quote(user, &q).await.unwrap().cost, 22);
    q.ref_count = 0;
    assert_eq!(s.quote(user, &q).await.unwrap().cost, 16);
    q.resolution = "4K".into();
    assert!(matches!(
        s.quote(user, &q).await,
        Err(GenerationError::Tier)
    ));
    sqlx::query("UPDATE pricing_rules SET base_credits=7 WHERE quality='low'")
        .execute(&db)
        .await
        .unwrap();
    let key = Uuid::new_v4();
    let mut calls = tokio::task::JoinSet::new();
    for _ in 0..100 {
        let s = s.clone();
        calls.spawn(async move { s.create(user, key, input()).await.unwrap().job });
    }
    let mut id = None;
    while let Some(result) = calls.join_next().await {
        let j = result.unwrap();
        assert_eq!(j.cost, 28);
        if let Some(id) = id {
            assert_eq!(j.id, id);
        } else {
            id = Some(j.id);
        }
    }
    let id = id.unwrap();
    assert_eq!(wallet.summary(user).await.unwrap().held, 28);
    let rows: i64 =
        sqlx::query_scalar("SELECT count(*) FROM credit_ledger WHERE user_id=$1 AND type='HOLD'")
            .bind(user)
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(rows, 1);
    let mut changed = input();
    changed.n = 1;
    assert!(matches!(
        s.create(user, key, changed).await,
        Err(GenerationError::Conflict)
    ));
    assert!(matches!(
        s.create(user, Uuid::new_v4(), input()).await,
        Err(GenerationError::ActiveLimit)
    ));
    assert!(matches!(
        s.get(other, id).await,
        Err(GenerationError::NotFound)
    ));
    assert!(matches!(
        s.cancel(other, id).await,
        Err(GenerationError::NotFound)
    ));
    let mut calls = tokio::task::JoinSet::new();
    for _ in 0..100 {
        let s = s.clone();
        calls.spawn(async move { s.cancel(user, id).await.unwrap().job.status });
    }
    while let Some(result) = calls.join_next().await {
        assert_eq!(result.unwrap(), "CANCELLED");
    }
    assert_eq!(wallet.summary(user).await.unwrap().held, 0);
    assert_eq!(wallet.summary(user).await.unwrap().balance, 100);
    assert_eq!(s.events(user, 0, 100).await.unwrap().len(), 2);
    assert!(s.events(other, 0, 100).await.unwrap().is_empty());
    assert!(
        sqlx::query("UPDATE generation_jobs SET status='QUEUED',finished_at=NULL WHERE id=$1")
            .bind(id)
            .execute(&db)
            .await
            .is_err()
    );
    assert!(sqlx::query("DELETE FROM job_events WHERE job_id=$1")
        .bind(id)
        .execute(&db)
        .await
        .is_err());
    let mut expensive = input();
    expensive.quality = "high".into();
    assert!(matches!(
        s.create(user, Uuid::new_v4(), expensive).await,
        Err(GenerationError::Wallet(_))
    ));
    assert_eq!(s.list(user, None, None, 10).await.unwrap().items.len(), 1);
    assert!(!serde_json::to_string(&s.get(user, id).await.unwrap())
        .unwrap()
        .contains("never-expose"));
}
#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL"]
async fn moderation_reference_ownership_and_event_failure_never_leave_a_hold(db: PgPool) {
    model(&db).await;
    let user = owner(&db).await;
    let s = service(&db);
    sqlx::query("INSERT INTO moderation_rules(pattern,is_regex) VALUES('quiet',false),('forbidden[0-9]+',true)").execute(&db).await.unwrap();
    assert!(matches!(
        s.create(user, Uuid::new_v4(), input()).await,
        Err(GenerationError::ContentPolicy)
    ));
    let mut i = input();
    i.prompt = "forbidden123".into();
    assert!(matches!(
        s.create(user, Uuid::new_v4(), i).await,
        Err(GenerationError::ContentPolicy)
    ));
    sqlx::query("UPDATE moderation_rules SET enabled=false")
        .execute(&db)
        .await
        .unwrap();
    let mut i = input();
    i.references.push(atelier_generation::Reference {
        asset_id: Uuid::new_v4(),
        role: "reference".into(),
    });
    assert!(matches!(
        s.create(user, Uuid::new_v4(), i).await,
        Err(GenerationError::NotFound)
    ));
    sqlx::query("CREATE FUNCTION reject_generation_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic event failure'; END $$").execute(&db).await.unwrap();
    sqlx::query("CREATE TRIGGER reject_generation_event BEFORE INSERT ON job_events FOR EACH ROW EXECUTE FUNCTION reject_generation_event()").execute(&db).await.unwrap();
    assert!(s.create(user, Uuid::new_v4(), input()).await.is_err());
    let w = WalletService::new(db.clone()).summary(user).await.unwrap();
    assert_eq!(w.held, 0);
    assert_eq!(w.balance, 100);
    assert!(s.list(user, None, None, 10).await.unwrap().items.is_empty());
    let rows: i64 =
        sqlx::query_scalar("SELECT count(*) FROM credit_ledger WHERE user_id=$1 AND type='HOLD'")
            .bind(user)
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(rows, 0);
}
