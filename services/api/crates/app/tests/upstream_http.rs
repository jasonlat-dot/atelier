use atelier_app::{router, AppState};
use atelier_auth::{
    postgres::PostgresSessions,
    service::{PublicOrigin, SessionService},
    session::SessionSecrets,
    transient::RedisTransient,
};
use atelier_upstream::{
    crypto::SecretCipher,
    egress::{EgressPolicy, SafeHttp},
    slots::SlotStore,
    UpstreamService,
};
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    routing::get,
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use sqlx::PgPool;
use std::sync::Arc;
use tower::ServiceExt;
use uuid::Uuid;
async fn session(db: &PgPool, role: &str) -> SessionSecrets {
    let id = Uuid::new_v4();
    let secret = SessionSecrets::generate().unwrap();
    let admin = role != "USER";
    sqlx::query("INSERT INTO users(id,google_sub,email,canonical_email,display_name,role,mfa_enabled,mfa_secret_enc) VALUES($1,$2,$2,$2,'Upstream HTTP',$3,$4,$5)").bind(id).bind(format!("{id}@gmail.com")).bind(role).bind(admin).bind(if admin{Some(vec![7u8;32])}else{None}).execute(db).await.unwrap();
    sqlx::query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,mfa_verified_at) VALUES($1,$2,$3,now()+interval '1 day',now())").bind(secret.token_hash().as_slice()).bind(id).bind(secret.csrf_token()).execute(db).await.unwrap();
    secret
}
async fn call(
    state: &AppState,
    session: Option<&SessionSecrets>,
    method: &str,
    path: &str,
    csrf: bool,
    body: Value,
) -> (StatusCode, Value) {
    let mut req = Request::builder()
        .method(method)
        .uri(path)
        .header("Host", "atelier.test")
        .header("Origin", "https://atelier.test")
        .header("Content-Type", "application/json");
    if let Some(session) = session {
        req = req.header("Cookie", session.cookie());
        if csrf {
            req = req.header("X-CSRF-Token", session.csrf_token());
        }
    }
    let response = router(state.clone())
        .oneshot(
            req.body(if body.is_null() {
                Body::empty()
            } else {
                Body::from(body.to_string())
            })
            .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.headers()["cache-control"], "no-store");
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 2 * 1024 * 1024)
        .await
        .unwrap();
    (
        status,
        if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap()
        },
    )
}
#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL and TEST_REDIS_URL"]
async fn admin_pool_and_catalog_enforce_mfa_csrf_versioning_and_never_return_secrets(db: PgPool) {
    let admin = session(&db, "ADMIN").await;
    let user = session(&db, "USER").await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://localhost:{}", listener.local_addr().unwrap().port());
    let fake = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new().route(
                "/v1/models",
                get(|| async { Json(json!({"data":[{"id":"private-upstream-model"}]})) }),
            ),
        )
        .await
        .unwrap()
    });
    let redis = std::env::var("TEST_REDIS_URL").unwrap();
    let mut state = AppState::test();
    state.db = db.clone();
    state.auth = SessionService::new(
        Arc::new(PostgresSessions::new(db.clone())),
        PublicOrigin::parse("https://atelier.test").unwrap(),
    );
    state.limits = Some(Arc::new(RedisTransient::connect(&redis).await.unwrap()));
    state.upstream = Some(
        UpstreamService::new(
            db.clone(),
            SecretCipher::from_base64(&STANDARD.encode([39; 32])).unwrap(),
            SafeHttp::new(EgressPolicy::default()),
        )
        .with_slots(
            SlotStore::connect(&redis, &format!("http-upstream:{}", Uuid::new_v4()))
                .await
                .unwrap(),
        ),
    );
    for path in [
        "/api/v1/admin/upstream-accounts",
        "/api/v1/admin/models",
        "/api/v1/admin/pricing",
    ] {
        assert_eq!(
            call(&state, None, "GET", path, false, Value::Null).await.0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            call(&state, Some(&user), "GET", path, false, Value::Null)
                .await
                .0,
            StatusCode::FORBIDDEN
        );
    }
    let body = json!({"name":"Fixture account","base_url":format!("{origin}/v1"),"secret":"server-only-secret-key","group_tag":"test","priority":10,"weight":1,"concurrency_limit":2,"quota_total":100,"quota_remaining":100,"enabled":true});
    assert_eq!(
        call(
            &state,
            Some(&admin),
            "POST",
            "/api/v1/admin/upstream-accounts",
            false,
            body.clone()
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (status, account) = call(
        &state,
        Some(&admin),
        "POST",
        "/api/v1/admin/upstream-accounts",
        true,
        body.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let id = account["id"].as_str().unwrap();
    let list = call(
        &state,
        Some(&admin),
        "GET",
        "/api/v1/admin/upstream-accounts",
        false,
        Value::Null,
    )
    .await
    .1;
    let text = list.to_string();
    assert!(!text.contains(&origin));
    assert!(!text.contains("server-only-secret-key"));
    assert!(!text.contains("secret_enc"));
    let probe = call(
        &state,
        Some(&admin),
        "POST",
        &format!("/api/v1/admin/upstream-accounts/{id}/test"),
        true,
        Value::Null,
    )
    .await;
    assert_eq!(probe.0, StatusCode::OK);
    assert_eq!(probe.1["ok"], true);
    let stats = call(
        &state,
        Some(&admin),
        "GET",
        &format!("/api/v1/admin/upstream-accounts/{id}/stats"),
        false,
        Value::Null,
    )
    .await;
    assert_eq!(stats.1["successes"], 1);
    let mut unsafe_body = body.clone();
    unsafe_body["name"] = json!("Unsafe");
    unsafe_body["base_url"] = json!("file:///etc/passwd");
    assert_eq!(
        call(
            &state,
            Some(&admin),
            "POST",
            "/api/v1/admin/upstream-accounts",
            true,
            unsafe_body
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let mut unknown = body.clone();
    unknown["role"] = json!("SUPER_ADMIN");
    assert_eq!(
        call(
            &state,
            Some(&admin),
            "POST",
            "/api/v1/admin/upstream-accounts",
            true,
            unknown
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let mut model = json!({"id":"public-image","kind":"image","display_name":"Creative image","upstream_model":"private-upstream-model","enabled":false,"capabilities":{"qualities":["low"],"ratios":["1:1"],"resolutions":["1K"]},"sort_order":0});
    let created = call(
        &state,
        Some(&admin),
        "POST",
        "/api/v1/admin/models",
        true,
        model.clone(),
    )
    .await;
    assert_eq!(created.0, StatusCode::CREATED);
    assert_eq!(
        call(
            &state,
            Some(&user),
            "GET",
            "/api/v1/models",
            false,
            Value::Null
        )
        .await
        .1["models"],
        json!([])
    );
    let bound = call(
        &state,
        Some(&admin),
        "PUT",
        "/api/v1/admin/models/public-image/accounts",
        true,
        json!({"revision":created.1["revision"],"account_ids":[id],"group_tags":[]}),
    )
    .await;
    assert_eq!(bound.0, StatusCode::OK);
    let mut pricing = call(
        &state,
        Some(&admin),
        "GET",
        "/api/v1/admin/pricing",
        false,
        Value::Null,
    )
    .await
    .1;
    pricing["rules"] =
        json!([{"model_id":"public-image","quality":"low","base_credits":10,"edit_surcharge":0}]);
    assert_eq!(
        call(
            &state,
            Some(&admin),
            "PUT",
            "/api/v1/admin/pricing",
            true,
            pricing
        )
        .await
        .0,
        StatusCode::OK
    );
    model["enabled"] = json!(true);
    model["revision"] = bound.1["revision"].clone();
    model["upstream_model"] = Value::Null;
    assert_eq!(
        call(
            &state,
            Some(&admin),
            "PATCH",
            "/api/v1/admin/models",
            true,
            model.clone()
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &state,
            Some(&admin),
            "PATCH",
            "/api/v1/admin/models",
            true,
            model
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let catalog = call(
        &state,
        Some(&user),
        "GET",
        "/api/v1/models",
        false,
        Value::Null,
    )
    .await;
    assert_eq!(catalog.1["models"][0]["id"], "public-image");
    let catalog = catalog.1.to_string();
    for forbidden in [
        "private-upstream-model",
        "upstream_model",
        "account_ids",
        "group_tags",
        "server-only-secret-key",
        &origin,
    ] {
        assert!(!catalog.contains(forbidden));
    }
    let quota = call(
        &state,
        Some(&admin),
        "POST",
        &format!("/api/v1/admin/upstream-accounts/{id}/refresh-quota"),
        true,
        json!({"revision":account["revision"],"quota_total":200,"quota_remaining":150}),
    )
    .await;
    assert_eq!(quota.0, StatusCode::OK);
    assert_eq!(
        call(
            &state,
            Some(&admin),
            "DELETE",
            &format!("/api/v1/admin/upstream-accounts/{id}?revision=1"),
            true,
            Value::Null
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let revision = quota.1["revision"].as_i64().unwrap();
    assert_eq!(
        call(
            &state,
            Some(&admin),
            "DELETE",
            &format!("/api/v1/admin/upstream-accounts/{id}?revision={revision}"),
            true,
            Value::Null
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    sqlx::query(
        "UPDATE sessions SET mfa_verified_at=now()-interval '13 hours' WHERE token_hash=$1",
    )
    .bind(admin.token_hash().as_slice())
    .execute(&db)
    .await
    .unwrap();
    assert_eq!(
        call(
            &state,
            Some(&admin),
            "GET",
            "/api/v1/admin/models",
            false,
            Value::Null
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let logs: Vec<Value> =
        sqlx::query_scalar("SELECT to_jsonb(a) FROM audit_logs a WHERE action LIKE 'upstream.%'")
            .fetch_all(&db)
            .await
            .unwrap();
    let text = serde_json::to_string(&logs).unwrap();
    assert!(!text.contains("server-only-secret-key"));
    assert!(!text.contains("private-upstream-model"));
    assert!(!text.contains(&origin));
    fake.abort();
}
#[test]
fn upstream_contract_marks_private_inputs_write_only_and_admin_writes_require_csrf() {
    let value = serde_json::to_value(atelier_app::openapi()).unwrap();
    for (schema, key) in [
        ("AccountInput", "secret"),
        ("AccountInput", "base_url"),
        ("ModelInput", "upstream_model"),
    ] {
        assert_eq!(
            value["components"]["schemas"][schema]["properties"][key]["writeOnly"],
            true
        );
    }
    for (path, methods) in [
        ("/api/v1/admin/upstream-accounts", vec!["get", "post"]),
        (
            "/api/v1/admin/upstream-accounts/{id}",
            vec!["get", "patch", "delete"],
        ),
        ("/api/v1/admin/upstream-accounts/import", vec!["post"]),
        ("/api/v1/admin/models", vec!["get", "post", "patch"]),
        ("/api/v1/admin/pricing", vec!["get", "put"]),
    ] {
        for method in methods {
            let security = &value["paths"][path][method]["security"][0];
            assert!(security.get("session").is_some());
            assert_eq!(security.get("csrf").is_some(), method != "get");
        }
    }
}
