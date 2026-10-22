use atelier_upstream::{
    crypto::SecretCipher,
    egress::{EgressPolicy, SafeHttp},
    provider::{ImageRequest, ReferenceImage, VideoRequest},
    slots::SlotStore,
    AccountInput, BindingInput, Capabilities, Error, FailureCode, ModelInput, PriceRule,
    RouteRequirements, UpstreamService,
};
use axum::{
    extract::{Multipart, Path, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use bytes::Bytes;
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
fn image() -> ImageRequest {
    ImageRequest {
        prompt: "A synthetic scene".into(),
        quality: "low".into(),
        ratio: "1:1".into(),
        resolution: "1K".into(),
        n: 1,
        references: vec![],
    }
}
fn requirements() -> RouteRequirements {
    RouteRequirements {
        quality: "low".into(),
        ratio: "1:1".into(),
        resolution: "1K".into(),
        n: 1,
        reference_count: 0,
        seconds: None,
    }
}
async fn released(service: &UpstreamService, slots: &SlotStore, id: Uuid) {
    for _ in 0..50 {
        if slots.counts(&[id]).await.unwrap() == vec![0]
            && service.account(id).await.unwrap().in_flight == 0
        {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("lease did not release");
}
#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL and TEST_REDIS_URL"]
async fn real_provider_errors_route_or_stop_and_expired_cooldowns_recover(db: PgPool) {
    let fixture = fixture().await;
    let (actor, service, slots) = service(&db, &fixture, Duration::from_millis(100)).await;
    for (mode, code, status, retry) in [
        ("invalid", FailureCode::AccountInvalid, "INVALID", true),
        ("rate", FailureCode::RateLimited, "COOLDOWN", true),
        ("quota", FailureCode::RateLimited, "QUOTA_EXHAUSTED", true),
        ("broken", FailureCode::UpstreamError, "ACTIVE", true),
        ("slow", FailureCode::UpstreamError, "ACTIVE", true),
        ("policy", FailureCode::ContentPolicy, "ACTIVE", false),
        ("bad", FailureCode::BadRequest, "ACTIVE", false),
        ("ssrf", FailureCode::UpstreamError, "ACTIVE", false),
    ] {
        let group = format!("pool-{mode}");
        let id = format!("image-{mode}");
        let broken = account(
            &service,
            actor,
            &fixture,
            &format!("bad-{mode}"),
            mode,
            &group,
            (0, 100),
        )
        .await;
        let backup = account(
            &service,
            actor,
            &fixture,
            &format!("backup-{mode}"),
            &format!("good-{mode}"),
            &group,
            (1, 100),
        )
        .await;
        model(&service, actor, &id, "image", &group).await;
        let result = service.run_image(&id, image()).await;
        if retry {
            assert_eq!(&result.unwrap()[0].bytes[..], PNG);
            assert_eq!(fixture.fake.count(&format!("good-{mode}:image")), 1);
        } else {
            assert!(result.is_err());
            assert_eq!(fixture.fake.count(&format!("good-{mode}:image")), 0);
        }
        assert_eq!(service.account(broken).await.unwrap().status, status);
        assert_eq!(
            service.stats(broken).await.unwrap().errors[0].code,
            code.as_str()
        );
        released(&service, &slots, broken).await;
        released(&service, &slots, backup).await;
        if mode == "rate" {
            sqlx::query("UPDATE upstream_accounts SET cooldown_until=clock_timestamp()-interval '1 second' WHERE id=$1").bind(broken).execute(&db).await.unwrap();
            assert_eq!(service.recover_due().await.unwrap(), 1);
            assert_eq!(service.account(broken).await.unwrap().status, "ACTIVE");
        }
    }
}
#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL and TEST_REDIS_URL"]
async fn capacity_quota_priority_drop_and_stale_tokens_are_fenced(db: PgPool) {
    let fixture = fixture().await;
    let (actor, service, slots) = service(&db, &fixture, Duration::from_secs(2)).await;
    let first = account(
        &service,
        actor,
        &fixture,
        "Primary",
        "good",
        "pool",
        (0, 100),
    )
    .await;
    let second = account(
        &service,
        actor,
        &fixture,
        "Secondary",
        "good",
        "pool",
        (10, 100),
    )
    .await;
    model(&service, actor, "image", "image", "pool").await;
    let one = service.acquire("image", &requirements()).await.unwrap();
    assert_eq!(one.account_id, first);
    let two = service.acquire("image", &requirements()).await.unwrap();
    assert_eq!(two.account_id, first);
    let three = service.acquire("image", &requirements()).await.unwrap();
    assert_eq!(three.account_id, second);
    drop(one);
    drop(two);
    drop(three);
    released(&service, &slots, first).await;
    released(&service, &slots, second).await;
    let lease = service.acquire("image", &requirements()).await.unwrap();
    let old_member:String=sqlx::query_scalar("SELECT id::text||':'||token::text FROM upstream_leases WHERE account_id=$1 AND completed=false").bind(first).fetch_one(&db).await.unwrap();
    sqlx::query("UPDATE upstream_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE account_id=$1 AND completed=false").bind(first).execute(&db).await.unwrap();
    slots.release(first, &old_member).await.unwrap();
    let new = service.acquire("image", &requirements()).await.unwrap();
    assert!(lease.finish_success(1, "image").await.is_err());
    assert!(new.is_valid());
    new.finish_success(1, "image").await.unwrap();
    assert_eq!(service.account(first).await.unwrap().quota_remaining, 99);
    let exhausted = account(
        &service,
        actor,
        &fixture,
        "One unit",
        "good",
        "limited",
        (0, 1),
    )
    .await;
    model(&service, actor, "limited", "image", "limited").await;
    let held = service.acquire("limited", &requirements()).await.unwrap();
    assert!(matches!(
        service.acquire("limited", &requirements()).await,
        Err(Error::NoCapacity)
    ));
    drop(held);
    released(&service, &slots, exhausted).await;
    let (ready, rx) = tokio::sync::oneshot::channel();
    let cloned = service.clone();
    let task = tokio::spawn(async move {
        let _lease = cloned.acquire("limited", &requirements()).await.unwrap();
        ready.send(()).unwrap();
        std::future::pending::<()>().await;
    });
    rx.await.unwrap();
    task.abort();
    let _ = task.await;
    released(&service, &slots, exhausted).await;
}
#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL and TEST_REDIS_URL"]
async fn edits_video_partial_results_and_health_retry_boundaries_work(db: PgPool) {
    let fixture = fixture().await;
    let (actor, service, slots) = service(&db, &fixture, Duration::from_secs(3)).await;
    let id = account(&service, actor, &fixture, "Main", "good", "pool", (0, 100)).await;
    model(&service, actor, "image", "image", "pool").await;
    model(&service, actor, "video", "video", "pool").await;
    for _ in 0..3 {
        let mut invalid = image();
        invalid.references.push(ReferenceImage {
            bytes: Bytes::from_static(b"not-an-image"),
            mime: "image/png".into(),
        });
        assert!(matches!(
            service.run_image("image", invalid).await,
            Err(Error::Validation)
        ));
        released(&service, &slots, id).await;
    }
    let healthy = service.account(id).await.unwrap();
    assert_eq!(healthy.status, "ACTIVE");
    assert_eq!(healthy.consecutive_failures, 0);
    assert_eq!(service.stats(id).await.unwrap().total, 0);
    let mut edited = image();
    edited.references.push(ReferenceImage {
        bytes: Bytes::from_static(PNG),
        mime: "image/png".into(),
    });
    assert_eq!(service.run_image("image", edited).await.unwrap().len(), 1);
    assert_eq!(fixture.fake.count("good:edit"), 1);
    let output = service
        .run_video(
            "video",
            VideoRequest {
                prompt: "A synthetic clip".into(),
                ratio: "16:9".into(),
                resolution: "720p".into(),
                seconds: 4,
                reference: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(&output.bytes[..], VIDEO);
    assert_eq!(fixture.fake.count("good:video-submit"), 1);
    assert_eq!(fixture.fake.count("good:video-content"), 1);
    assert_eq!(service.account(id).await.unwrap().quota_remaining, 95);
    released(&service, &slots, id).await;
    let partial = account(
        &service,
        actor,
        &fixture,
        "Partial",
        "partial",
        "partial",
        (0, 100),
    )
    .await;
    model(&service, actor, "partial", "image", "partial").await;
    let mut request = image();
    request.n = 2;
    assert_eq!(
        service.run_image("partial", request).await.unwrap().len(),
        1
    );
    assert_eq!(service.account(partial).await.unwrap().quota_remaining, 99);
    account(
        &service,
        actor,
        &fixture,
        "URL download",
        "url",
        "url",
        (0, 100),
    )
    .await;
    model(&service, actor, "url", "image", "url").await;
    assert_eq!(
        &service.run_image("url", image()).await.unwrap()[0].bytes[..],
        PNG
    );
    let broken = account(
        &service,
        actor,
        &fixture,
        "Failure streak",
        "broken",
        "broken",
        (0, 100),
    )
    .await;
    model(&service, actor, "broken", "image", "broken").await;
    for _ in 0..3 {
        assert!(service.run_image("broken", image()).await.is_err());
    }
    assert_eq!(service.account(broken).await.unwrap().status, "COOLDOWN");
    sqlx::query("UPDATE upstream_accounts SET cooldown_until=clock_timestamp()-interval '1 second' WHERE id=$1").bind(broken).execute(&db).await.unwrap();
    assert_eq!(service.recover_due().await.unwrap(), 1);
    assert_eq!(
        service.account(broken).await.unwrap().consecutive_failures,
        0
    );
    sqlx::query("UPDATE upstream_accounts SET quota_remaining=0,status='QUOTA_EXHAUSTED',quota_reset_at=clock_timestamp()-interval '1 second' WHERE id=$1").bind(broken).execute(&db).await.unwrap();
    assert_eq!(service.recover_due().await.unwrap(), 1);
    assert_eq!(service.account(broken).await.unwrap().quota_remaining, 100);
}
#[tokio::test]
#[ignore = "Requires TEST_REDIS_URL"]
async fn redis_slots_are_atomic_and_old_tokens_cannot_release_new_claims() {
    let slots = SlotStore::connect(
        &std::env::var("TEST_REDIS_URL").unwrap(),
        &format!("slot-test:{}", Uuid::new_v4()),
    )
    .await
    .unwrap();
    let account = Uuid::new_v4();
    let mut tasks = tokio::task::JoinSet::new();
    for _ in 0..100 {
        let slots = slots.clone();
        tasks.spawn(async move {
            let token = Uuid::new_v4().to_string();
            let claimed = slots.claim(account, &token, 2, 60).await.unwrap();
            (token, claimed)
        });
    }
    let mut winners = Vec::new();
    while let Some(result) = tasks.join_next().await {
        let (token, claimed) = result.unwrap();
        if claimed {
            winners.push(token);
        }
    }
    assert_eq!(winners.len(), 2);
    for token in &winners {
        slots.release(account, token).await.unwrap();
    }
    assert!(slots.claim(account, "expired-token", 2, 1).await.unwrap());
    tokio::time::sleep(Duration::from_millis(1100)).await;
    assert!(!slots.renew(account, "expired-token", 1).await.unwrap());
    assert!(slots
        .claim(account, "new-owner-token", 2, 60)
        .await
        .unwrap());
    slots.release(account, "expired-token").await.unwrap();
    assert_eq!(slots.counts(&[account]).await.unwrap(), vec![1]);
    slots.release(account, "new-owner-token").await.unwrap();
}

#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL and TEST_REDIS_URL"]
async fn long_calls_renew_leases_and_panics_release_capacity(db: PgPool) {
    let fixture = fixture().await;
    let (actor, service, slots) = service(&db, &fixture, Duration::from_secs(2)).await;
    let id = account(
        &service,
        actor,
        &fixture,
        "Long call",
        "good",
        "long",
        (0, 100),
    )
    .await;
    model(&service, actor, "long", "image", "long").await;
    let lease = service.acquire("long", &requirements()).await.unwrap();
    tokio::time::sleep(Duration::from_secs(21)).await;
    let renewed:bool=sqlx::query_scalar("SELECT expires_at>clock_timestamp()+interval '40 seconds' FROM upstream_leases WHERE account_id=$1 AND completed=false").bind(id).fetch_one(&db).await.unwrap();
    assert!(renewed);
    assert!(lease.is_valid());
    drop(lease);
    released(&service, &slots, id).await;
    let cloned = service.clone();
    let panic = tokio::spawn(async move {
        let _lease = cloned.acquire("long", &requirements()).await.unwrap();
        panic!("synthetic cancellation panic");
    });
    assert!(panic.await.is_err());
    released(&service, &slots, id).await;
    for index in 0..4 {
        account(
            &service,
            actor,
            &fixture,
            &format!("Try-{index}"),
            if index < 3 { "invalid" } else { "good-cap" },
            "attempts",
            (index, 100),
        )
        .await;
    }
    model(&service, actor, "attempts", "image", "attempts").await;
    assert!(service.run_image("attempts", image()).await.is_err());
    assert_eq!(fixture.fake.count("invalid:image"), 3);
    assert_eq!(fixture.fake.count("good-cap:image"), 0);
}
