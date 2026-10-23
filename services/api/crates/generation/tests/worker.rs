use atelier_assets::{signing::MediaSigner, storage::Storage, AssetService};
use atelier_generation::{GenerationService, GenerationWorker, JobInput};
use atelier_upstream::{
    crypto::SecretCipher,
    egress::{EgressPolicy, SafeHttp},
    slots::SlotStore,
    AccountInput, BindingInput, Capabilities, ModelInput, PriceRule, UpstreamService,
};
use atelier_wallet::WalletService;
use axum::{
    extract::{Multipart, Path, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use sqlx::PgPool;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use uuid::Uuid;
const PNG: &[u8] = include_bytes!("../../app/tests/fixtures/reference.png");
const VIDEO: &[u8] = include_bytes!("../../app/tests/fixtures/reference.mp4");
#[derive(Clone, Default)]
struct Fake {
    calls: Arc<Mutex<Vec<String>>>,
}
impl Fake {
    fn count(&self, path: &str) -> usize {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|p| p.as_str() == path)
            .count()
    }
    fn hit(&self, path: String) {
        self.calls.lock().unwrap().push(path);
    }
}
struct Fixture {
    origin: String,
    fake: Fake,
    server: tokio::task::JoinHandle<()>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}
async fn generate(
    State(fake): State<Fake>,
    Path(mode): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    assert_eq!(
        headers[header::AUTHORIZATION],
        "Bearer synthetic-upstream-key"
    );
    assert_eq!(body["model"], "private-provider-model");
    assert_eq!(body["moderation"], "auto");
    fake.hit(format!("{mode}:image"));
    match mode.as_str(){
        "renew"=>{tokio::time::sleep(Duration::from_secs(25)).await;Json(json!({"data":[{"b64_json":STANDARD.encode(PNG)}]})).into_response()},
        "full"=>Json(json!({"data":(0..body["n"].as_u64().unwrap()).map(|_|json!({"b64_json":STANDARD.encode(PNG)})).collect::<Vec<_>>()})).into_response(),
        "hang"=>{tokio::time::sleep(Duration::from_secs(10)).await;Json(json!({"data":[{"b64_json":STANDARD.encode(PNG)}]})).into_response()},
        "invalid-media"=>Json(json!({"data":[{"b64_json":STANDARD.encode(b"\x89PNG\r\n\x1a\ncorrupt-image")}]})).into_response(),

        "invalid"=>(StatusCode::UNAUTHORIZED,"private provider endpoint and secret must never be logged").into_response(),
        "rate"=>(StatusCode::TOO_MANY_REQUESTS,[(header::RETRY_AFTER,"1")],Json(json!({"error":{"code":"rate_limit_exceeded"}}))).into_response(),
        "quota"=>(StatusCode::TOO_MANY_REQUESTS,Json(json!({"error":{"code":"insufficient_quota"}}))).into_response(),
        "url"=>Json(json!({"data":[{"url":format!("http://{}/download.png",headers[header::HOST].to_str().unwrap())}]})).into_response(),
        "broken"=>(StatusCode::BAD_GATEWAY,Json(json!({"error":{"message":"private server error"}}))).into_response(),
        "policy"=>(StatusCode::BAD_REQUEST,Json(json!({"error":{"code":"content_policy_violation","message":"private moderation detail"}}))).into_response(),
        "bad"=>(StatusCode::UNPROCESSABLE_ENTITY,Json(json!({"error":{"code":"invalid_size"}}))).into_response(),
        "slow"=>{tokio::time::sleep(Duration::from_millis(300)).await;Json(json!({"data":[{"b64_json":STANDARD.encode(PNG)}]})).into_response()},
        "ssrf"=>Json(json!({"data":[{"url":"http://169.254.169.254/latest/meta-data/"}]})).into_response(),
        "partial"=>Json(json!({"data":[{"b64_json":STANDARD.encode(PNG)},{"b64_json":"broken"}]})).into_response(),
        _=>Json(json!({"data":[{"b64_json":STANDARD.encode(PNG)}]})).into_response(),
    }
}
async fn edit(
    State(fake): State<Fake>,
    Path(mode): Path<String>,
    mut form: Multipart,
) -> Json<Value> {
    let mut references = 0;
    while let Some(field) = form.next_field().await.unwrap() {
        if field.name() == Some("image[]") {
            assert_eq!(&field.bytes().await.unwrap()[..], PNG);
            references += 1;
        }
    }
    assert_eq!(references, 1);
    fake.hit(format!("{mode}:edit"));
    Json(json!({"data":[{"b64_json":STANDARD.encode(PNG)}]}))
}
async fn video_submit(
    State(fake): State<Fake>,
    Path(mode): Path<String>,
    Json(body): Json<Value>,
) -> Json<Value> {
    assert_eq!(body["model"], "private-provider-model");
    assert_eq!(body["seconds"], "4");
    assert_eq!(body["size"], "1280x720");
    fake.hit(format!("{mode}:video-submit"));
    Json(json!({"id":"video_test_1","status":"queued"}))
}
async fn fixture() -> Fixture {
    let fake = Fake::default();
    let app=Router::new()
        .route("/download.png",get(|headers:HeaderMap|async move{assert!(!headers.contains_key(header::AUTHORIZATION));([(header::CONTENT_TYPE,"image/png")],PNG)}))
        .route("/{mode}/v1/models",get(|State(fake):State<Fake>,Path(mode):Path<String>|async move{fake.hit(format!("{mode}:probe"));Json(json!({"data":[{"id":"private-provider-model"}]}))}))
        .route("/{mode}/v1/images/generations",post(generate))
        .route("/{mode}/v1/images/edits",post(edit))
        .route("/{mode}/v1/videos",post(video_submit))
        .route("/{mode}/v1/videos/{id}",get(|State(fake):State<Fake>,Path((mode,id)):Path<(String,String)>|async move{
            fake.hit(format!("{mode}:video-poll"));let count=fake.count(&format!("{mode}:video-poll"));Json(json!({"id":id,"status":if count==1{"in_progress"}else{"completed"},"progress":50}))
        }))
        .route("/{mode}/v1/videos/{id}/content",get(|State(fake):State<Fake>,Path((mode,_)):Path<(String,String)>|async move{fake.hit(format!("{mode}:video-content"));([(header::CONTENT_TYPE,"video/mp4")],VIDEO)}))
        .with_state(fake.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Fixture {
        origin,
        fake,
        server,
    }
}
async fn service(
    db: &PgPool,
    fixture: &Fixture,
    timeout: Duration,
) -> (Uuid, UpstreamService, SlotStore) {
    let actor = Uuid::new_v4();
    sqlx::query("INSERT INTO users(id,google_sub,email,canonical_email,display_name,role) VALUES($1,$2,$2,$2,'Route test','ADMIN')").bind(actor).bind(format!("{actor}@gmail.com")).execute(db).await.unwrap();
    let slots = SlotStore::connect(
        &std::env::var("TEST_REDIS_URL").unwrap(),
        &format!("upstream-test:{}", Uuid::new_v4()),
    )
    .await
    .unwrap();
    let http =
        SafeHttp::new(EgressPolicy::with_local_origins(vec![fixture.origin.clone()]).unwrap())
            .with_timeout_limit(timeout);
    let service = UpstreamService::new(
        db.clone(),
        SecretCipher::from_base64(&STANDARD.encode([91; 32])).unwrap(),
        http,
    )
    .with_slots(slots.clone());
    (actor, service, slots)
}
async fn account(
    service: &UpstreamService,
    actor: Uuid,
    fixture: &Fixture,
    name: &str,
    mode: &str,
    group: &str,
    capacity: (i32, i64),
) -> Uuid {
    let (priority, quota) = capacity;
    let input:AccountInput=serde_json::from_value(json!({"name":name,"base_url":format!("{}/{mode}/v1",fixture.origin),"secret":"synthetic-upstream-key","group_tag":group,"priority":priority,"weight":1,"concurrency_limit":2,"quota_total":quota,"quota_remaining":quota,"enabled":true})).unwrap();
    service.save_account(actor, None, input).await.unwrap().id
}
async fn model(service: &UpstreamService, actor: Uuid, id: &str, kind: &str, group: &str) {
    let caps:Capabilities=serde_json::from_value(if kind=="image"{json!({"qualities":["low"],"ratios":["1:1"],"resolutions":["1K"],"max_n":4,"max_refs":4,"supports_edit":true})}else{json!({"qualities":["standard"],"ratios":["16:9"],"resolutions":["720p"],"max_n":1,"max_refs":1,"seconds":[4]})}).unwrap();
    let first = service
        .save_model(
            actor,
            false,
            ModelInput {
                id: id.into(),
                kind: kind.into(),
                display_name: format!("Catalogue {id}"),
                upstream_model: Some("private-provider-model".into()),
                enabled: false,
                capabilities: caps.clone(),
                sort_order: 0,
                revision: None,
            },
        )
        .await
        .unwrap();
    let bound = service
        .bind_accounts(
            actor,
            id,
            BindingInput {
                revision: first.revision,
                account_ids: vec![],
                group_tags: vec![group.into()],
            },
        )
        .await
        .unwrap();
    let mut pricing = service.pricing().await.unwrap();
    pricing.rules.push(PriceRule {
        model_id: id.into(),
        quality: if kind == "image" { "low" } else { "standard" }.into(),
        base_credits: 10,
        edit_surcharge: 0,
    });
    service.save_pricing(actor, pricing).await.unwrap();
    service
        .save_model(
            actor,
            true,
            ModelInput {
                id: id.into(),
                kind: kind.into(),
                display_name: first.display_name,
                upstream_model: None,
                enabled: true,
                capabilities: caps,
                sort_order: 0,
                revision: Some(bound.revision),
            },
        )
        .await
        .unwrap();
}

async fn user(db: &PgPool) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO users(id,google_sub,email,canonical_email,display_name) VALUES($1,$2,$2,$2,'Worker user')").bind(id).bind(format!("{id}@gmail.com")).execute(db).await.unwrap();
    sqlx::query("INSERT INTO wallets(user_id) VALUES($1)")
        .bind(id)
        .execute(db)
        .await
        .unwrap();
    WalletService::new(db.clone())
        .grant(id, 1000, &format!("worker:{id}"))
        .await
        .unwrap();
    id
}
fn input(model: &str, n: u8) -> JobInput {
    serde_json::from_value(json!({"model_id":model,"prompt":"A quiet landscape","quality":"low","ratio":"1:1","resolution":"1K","n":n})).unwrap()
}
fn generation(db: &PgPool) -> (GenerationService, AssetService) {
    let assets = AssetService::new(
        db.clone(),
        Storage::memory(),
        MediaSigner::from_base64(&STANDARD.encode([67; 32])).unwrap(),
    );
    (GenerationService::new(db.clone(), assets.clone()), assets)
}
async fn expire(db: &PgPool, id: Uuid) {
    sqlx::query("UPDATE generation_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1 AND finished_at IS NULL").bind(id).execute(db).await.unwrap();
}
async fn wait_running(db: &PgPool, id: Uuid) {
    for _ in 0..100 {
        let s: String = sqlx::query_scalar("SELECT status FROM generation_jobs WHERE id=$1")
            .bind(id)
            .fetch_one(db)
            .await
            .unwrap();
        if s == "RUNNING" {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("worker did not dispatch");
}
#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL and TEST_REDIS_URL"]
async fn successful_partial_and_duplicate_delivery_settle_only_published_outputs(db: PgPool) {
    let fixture = fixture().await;
    let (actor, upstream, _) = service(&db, &fixture, Duration::from_secs(3)).await;
    account(&upstream, actor, &fixture, "Full", "full", "full", (0, 100)).await;
    model(&upstream, actor, "full", "image", "full").await;
    let (s, assets) = generation(&db);
    let worker = GenerationWorker::new(s.clone(), upstream.clone());
    let owner = user(&db).await;
    let id = s
        .create(owner, Uuid::new_v4(), input("full", 3))
        .await
        .unwrap()
        .job
        .id;
    let mut workers = tokio::task::JoinSet::new();
    for _ in 0..20 {
        let w = worker.clone();
        workers.spawn(async move { w.run_once().await.unwrap() });
    }
    while let Some(r) = workers.join_next().await {
        r.unwrap();
    }
    let j = s.get(owner, id).await.unwrap();
    assert_eq!(j.status, "SUCCEEDED");
    assert_eq!(j.outputs.len(), 3);
    assert_eq!(j.settled, 30);
    assert_eq!(j.released, 0);
    assert_eq!(fixture.fake.count("full:image"), 1);
    let w = WalletService::new(db.clone()).summary(owner).await.unwrap();
    assert_eq!(w.balance, 970);
    assert_eq!(w.held, 0);
    assert!(!worker.run_once().await.unwrap());
    assert_eq!(
        assets
            .list(owner, None, Some("generated".into()), "".into(), None, 25)
            .await
            .unwrap()
            .total,
        3
    );
    account(
        &upstream,
        actor,
        &fixture,
        "Partial",
        "partial",
        "partial",
        (0, 100),
    )
    .await;
    model(&upstream, actor, "partial", "image", "partial").await;
    let owner = user(&db).await;
    let id = s
        .create(owner, Uuid::new_v4(), input("partial", 3))
        .await
        .unwrap()
        .job
        .id;
    worker.run_once().await.unwrap();
    let j = s.get(owner, id).await.unwrap();
    assert_eq!(j.status, "PARTIAL");
    assert_eq!(j.outputs.len(), 1);
    assert_eq!(j.settled, 10);
    assert_eq!(j.released, 20);
    assert_eq!(
        WalletService::new(db.clone())
            .summary(owner)
            .await
            .unwrap()
            .balance,
        990
    );
    let events = s.events(owner, 0, 100).await.unwrap();
    assert_eq!(events.last().unwrap().payload["status"], "PARTIAL");
    assert!(!serde_json::to_string(&j)
        .unwrap()
        .contains("private-provider"));
}
#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL and TEST_REDIS_URL"]
async fn cancel_races_finish_without_double_settle_or_release(db: PgPool) {
    let fixture = fixture().await;
    let (actor, upstream, _) = service(&db, &fixture, Duration::from_secs(3)).await;
    account(&upstream, actor, &fixture, "Race", "full", "pool", (0, 100)).await;
    model(&upstream, actor, "image", "image", "pool").await;
    let (s, _) = generation(&db);
    let worker = GenerationWorker::new(s.clone(), upstream);
    for _ in 0..15 {
        let owner = user(&db).await;
        let id = s
            .create(owner, Uuid::new_v4(), input("image", 1))
            .await
            .unwrap()
            .job
            .id;
        let w = worker.clone();
        let task = tokio::spawn(async move { w.run_once().await.unwrap() });
        let cancel = s.cancel(owner, id).await.unwrap().job;
        task.await.unwrap();
        let job = s.get(owner, id).await.unwrap();
        let wallet = WalletService::new(db.clone()).summary(owner).await.unwrap();
        assert_eq!(wallet.held, 0);
        match job.status.as_str() {
            "CANCELLED" => {
                assert_eq!(wallet.balance, 1000);
                assert!(job.outputs.is_empty());
                assert_eq!(job.released, 10);
            }
            "SUCCEEDED" => {
                assert_eq!(wallet.balance, 990);
                assert_eq!(job.settled, 10);
                assert_eq!(cancel.status, "SUCCEEDED");
            }
            s => panic!("unexpected terminal state: {s}"),
        }
        assert_eq!(job.settled + job.released, job.cost);
    }
}
#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL and TEST_REDIS_URL"]
async fn expired_worker_is_fenced_and_staged_results_survive_publication_rollback(db: PgPool) {
    let fixture = fixture().await;
    let (actor, upstream, _) = service(&db, &fixture, Duration::from_secs(20)).await;
    account(
        &upstream,
        actor,
        &fixture,
        "Slow",
        "hang",
        "crash",
        (0, 100),
    )
    .await;
    account(
        &upstream,
        actor,
        &fixture,
        "Backup",
        "full",
        "crash",
        (10, 100),
    )
    .await;
    model(&upstream, actor, "crash", "image", "crash").await;
    let (s, assets) = generation(&db);
    let worker = GenerationWorker::new(s.clone(), upstream.clone());
    let owner = user(&db).await;
    let id = s
        .create(owner, Uuid::new_v4(), input("crash", 1))
        .await
        .unwrap()
        .job
        .id;
    let w = worker.clone();
    let old = tokio::spawn(async move { w.run_once().await.unwrap() });
    wait_running(&db, id).await;
    expire(&db, id).await;
    assert_eq!(worker.recover_expired().await.unwrap(), 1);
    worker.run_once().await.unwrap();
    old.await.unwrap();
    let j = s.get(owner, id).await.unwrap();
    assert_eq!(j.status, "SUCCEEDED");
    assert_eq!(j.attempts, 2);
    assert_eq!(j.settled, 10);
    let owner = user(&db).await;
    account(
        &upstream,
        actor,
        &fixture,
        "Storing",
        "full",
        "storing",
        (0, 100),
    )
    .await;
    model(&upstream, actor, "storing", "image", "storing").await;
    sqlx::query("CREATE FUNCTION reject_generated_publish() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='asset.generated' THEN RAISE EXCEPTION 'synthetic publication failure'; END IF; RETURN NEW; END $$").execute(&db).await.unwrap();
    sqlx::query("CREATE TRIGGER reject_generated_publish BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_generated_publish()").execute(&db).await.unwrap();
    let id = s
        .create(owner, Uuid::new_v4(), input("storing", 1))
        .await
        .unwrap()
        .job
        .id;
    assert!(worker.run_once().await.is_err());
    assert_eq!(s.get(owner, id).await.unwrap().status, "STORING");
    assert_eq!(
        WalletService::new(db.clone())
            .summary(owner)
            .await
            .unwrap()
            .held,
        10
    );
    let staged: Uuid =
        sqlx::query_scalar("SELECT asset_id FROM generation_outputs WHERE job_id=$1")
            .bind(id)
            .fetch_one(&db)
            .await
            .unwrap();
    assert!(assets.get(owner, staged).await.is_err());
    assert_eq!(
        assets
            .list(owner, None, None, "".into(), None, 25)
            .await
            .unwrap()
            .total,
        0
    );
    sqlx::query("DROP TRIGGER reject_generated_publish ON audit_logs")
        .execute(&db)
        .await
        .unwrap();
    expire(&db, id).await;
    worker.recover_expired().await.unwrap();
    worker.run_once().await.unwrap();
    assert_eq!(s.get(owner, id).await.unwrap().status, "SUCCEEDED");
    assert_eq!(fixture.fake.count("full:image"), 2);
    assert_eq!(
        WalletService::new(db.clone())
            .summary(owner)
            .await
            .unwrap()
            .held,
        0
    );
    assert_eq!(
        WalletService::new(db.clone())
            .summary(owner)
            .await
            .unwrap()
            .balance,
        990
    );
    assert!(assets.get(owner, staged).await.is_ok());
}
#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL and TEST_REDIS_URL"]
async fn failure_routing_capacity_deadline_and_invalid_media_release_credits(db: PgPool) {
    let fixture = fixture().await;
    let (actor, upstream, _) = service(&db, &fixture, Duration::from_secs(3)).await;
    account(
        &upstream,
        actor,
        &fixture,
        "Bad",
        "invalid",
        "retry",
        (0, 100),
    )
    .await;
    account(
        &upstream,
        actor,
        &fixture,
        "Good",
        "full",
        "retry",
        (1, 100),
    )
    .await;
    model(&upstream, actor, "retry", "image", "retry").await;
    let (s, _) = generation(&db);
    let worker = GenerationWorker::new(s.clone(), upstream.clone());
    let owner = user(&db).await;
    let id = s
        .create(owner, Uuid::new_v4(), input("retry", 1))
        .await
        .unwrap()
        .job
        .id;
    worker.run_once().await.unwrap();
    assert_eq!(s.get(owner, id).await.unwrap().status, "ROUTING");
    sqlx::query("UPDATE generation_jobs SET next_attempt_at=clock_timestamp() WHERE id=$1")
        .bind(id)
        .execute(&db)
        .await
        .unwrap();
    worker.run_once().await.unwrap();
    assert_eq!(s.get(owner, id).await.unwrap().attempts, 2);
    assert_eq!(s.get(owner, id).await.unwrap().status, "SUCCEEDED");
    for (name, mode, code) in [
        ("policy", "policy", "CONTENT_POLICY"),
        ("media", "invalid-media", "STORAGE_FAILED"),
    ] {
        account(&upstream, actor, &fixture, name, mode, name, (0, 100)).await;
        model(&upstream, actor, name, "image", name).await;
        let owner = user(&db).await;
        let id = s
            .create(owner, Uuid::new_v4(), input(name, 1))
            .await
            .unwrap()
            .job
            .id;
        worker.run_once().await.unwrap();
        let j = s.get(owner, id).await.unwrap();
        assert_eq!(j.status, "FAILED");
        assert_eq!(j.error_code.as_deref(), Some(code));
        assert_eq!(
            WalletService::new(db.clone())
                .summary(owner)
                .await
                .unwrap()
                .held,
            0
        );
    }
    let account = account(
        &upstream,
        actor,
        &fixture,
        "Disabled",
        "full",
        "none",
        (0, 100),
    )
    .await;
    model(&upstream, actor, "none", "image", "none").await;
    sqlx::query("UPDATE upstream_accounts SET status='DISABLED' WHERE id=$1")
        .bind(account)
        .execute(&db)
        .await
        .unwrap();
    let owner = user(&db).await;
    let id = s
        .create(owner, Uuid::new_v4(), input("none", 1))
        .await
        .unwrap()
        .job
        .id;
    worker.run_once().await.unwrap();
    assert_eq!(s.get(owner, id).await.unwrap().attempts, 0);
    sqlx::query("UPDATE generation_jobs SET created_at=clock_timestamp()-interval '6 minutes',next_attempt_at=clock_timestamp() WHERE id=$1").bind(id).execute(&db).await.unwrap();
    worker.run_once().await.unwrap();
    assert_eq!(
        s.get(owner, id).await.unwrap().error_code.as_deref(),
        Some("NO_CAPACITY")
    );
    let owner = user(&db).await;
    let id = s
        .create(owner, Uuid::new_v4(), input("retry", 1))
        .await
        .unwrap()
        .job
        .id;
    sqlx::query(
        "UPDATE generation_jobs SET run_deadline=clock_timestamp()-interval '1 second' WHERE id=$1",
    )
    .bind(id)
    .execute(&db)
    .await
    .unwrap();
    worker.run_once().await.unwrap();
    assert_eq!(
        s.get(owner, id).await.unwrap().error_code.as_deref(),
        Some("TIMEOUT")
    );
}

#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL, TEST_REDIS_URL and FFmpeg"]
async fn accepted_video_resumes_same_id_and_deduplicates_upstream_quota_after_crash(db: PgPool) {
    let fixture = fixture().await;
    let (actor, upstream, _) = service(&db, &fixture, Duration::from_secs(10)).await;
    let account = account(
        &upstream,
        actor,
        &fixture,
        "Video",
        "good",
        "video",
        (0, 100),
    )
    .await;
    model(&upstream, actor, "video", "video", "video").await;
    let assets = AssetService::new(
        db.clone(),
        Storage::memory(),
        MediaSigner::from_base64(&STANDARD.encode([68; 32])).unwrap(),
    )
    .with_video(
        atelier_assets::video::VideoProcessor::from_lookup(|k| std::env::var(k).ok())
            .unwrap()
            .unwrap(),
    );
    let s = GenerationService::new(db.clone(), assets);
    let worker = GenerationWorker::new(s.clone(), upstream.clone());
    let owner = user(&db).await;
    let input:JobInput=serde_json::from_value(json!({"model_id":"video","prompt":"A quiet film","quality":"standard","ratio":"16:9","resolution":"720p","seconds":4,"n":1})).unwrap();
    let id = s.create(owner, Uuid::new_v4(), input).await.unwrap().job.id;
    let mut blocker = db.acquire().await.unwrap();
    sqlx::query("SELECT pg_advisory_lock(7481101)")
        .execute(&mut *blocker)
        .await
        .unwrap();
    sqlx::query("CREATE FUNCTION block_generated_media() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.source='generated' THEN PERFORM pg_advisory_xact_lock(7481101); END IF; RETURN NEW; END $$").execute(&db).await.unwrap();
    sqlx::query("CREATE TRIGGER block_generated_media BEFORE INSERT ON assets FOR EACH ROW EXECUTE FUNCTION block_generated_media()").execute(&db).await.unwrap();
    let w = worker.clone();
    let running = tokio::spawn(async move { w.run_once().await });
    let mut consumed = false;
    for _ in 0..200 {
        if upstream.account(account).await.unwrap().quota_remaining == 96 {
            consumed = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(consumed);
    running.abort();
    let _ = running.await;
    sqlx::query("SELECT pg_advisory_unlock(7481101)")
        .execute(&mut *blocker)
        .await
        .unwrap();
    drop(blocker);
    assert_eq!(fixture.fake.count("good:video-submit"), 1);
    expire(&db, id).await;
    worker.recover_expired().await.unwrap();
    worker.run_once().await.unwrap();
    let j = s.get(owner, id).await.unwrap();
    assert_eq!(j.status, "SUCCEEDED");
    assert_eq!(j.attempts, 2);
    assert_eq!(j.settled, 40);
    assert_eq!(j.outputs[0].asset.kind, "video");
    assert_eq!(fixture.fake.count("good:video-submit"), 1);
    assert_eq!(fixture.fake.count("good:video-content"), 2);
    assert_eq!(upstream.account(account).await.unwrap().quota_remaining, 96);
    let wallet = WalletService::new(db.clone()).summary(owner).await.unwrap();
    assert_eq!(wallet.held, 0);
    assert_eq!(wallet.balance, 960);
}
#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL and TEST_REDIS_URL"]
async fn running_worker_renews_then_cancels_and_releases_all_capacity(db: PgPool) {
    let fixture = fixture().await;
    let (actor, upstream, slots) = service(&db, &fixture, Duration::from_secs(30)).await;
    let account = account(
        &upstream,
        actor,
        &fixture,
        "Long",
        "renew",
        "pool",
        (0, 100),
    )
    .await;
    model(&upstream, actor, "image", "image", "pool").await;
    let (s, _) = generation(&db);
    let worker = GenerationWorker::new(s.clone(), upstream.clone());
    let owner = user(&db).await;
    let id = s
        .create(owner, Uuid::new_v4(), input("image", 1))
        .await
        .unwrap()
        .job
        .id;
    let w = worker.clone();
    let running = tokio::spawn(async move { w.run_once().await.unwrap() });
    wait_running(&db, id).await;
    tokio::time::sleep(Duration::from_secs(21)).await;
    let renewed:bool=sqlx::query_scalar("SELECT lease_until>clock_timestamp()+interval '35 seconds' FROM generation_jobs WHERE id=$1").bind(id).fetch_one(&db).await.unwrap();
    assert!(renewed);
    assert_eq!(s.cancel(owner, id).await.unwrap().job.status, "RUNNING");
    running.await.unwrap();
    assert_eq!(s.get(owner, id).await.unwrap().status, "CANCELLED");
    let wallet = WalletService::new(db.clone()).summary(owner).await.unwrap();
    assert_eq!(wallet.held, 0);
    assert_eq!(wallet.balance, 1000);
    for _ in 0..50 {
        if slots.counts(&[account]).await.unwrap() == vec![0] {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("cancel did not release account slot");
}
