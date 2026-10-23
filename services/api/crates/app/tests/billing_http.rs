use atelier_app::{router, AppState};
use atelier_auth::{
    postgres::PostgresSessions,
    service::{PublicOrigin, SessionService},
    session::SessionSecrets,
    transient::RedisTransient,
};
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use sqlx::PgPool;
use std::sync::Arc;
use tower::ServiceExt;
use uuid::Uuid;

async fn session(pool: &PgPool, admin: bool) -> (Uuid, SessionSecrets) {
    let owner = Uuid::new_v4();
    let secrets = SessionSecrets::generate().unwrap();
    sqlx::query("INSERT INTO users(id,google_sub,email,canonical_email,display_name,role,mfa_enabled,mfa_secret_enc) VALUES($1,$2,$2,$2,'Wallet HTTP',$3,$4,$5)")
        .bind(owner).bind(format!("{owner}@gmail.com")).bind(if admin {"ADMIN"} else {"USER"}).bind(admin).bind(if admin {Some(vec![1u8;32])} else {None}).execute(pool).await.unwrap();
    let mut tx = pool.begin().await.unwrap();
    atelier_wallet::WalletService::signup_in_transaction(&mut tx, owner)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    sqlx::query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,mfa_verified_at) VALUES($1,$2,$3,now()+interval '1 day',now())")
        .bind(secrets.token_hash().as_slice()).bind(owner).bind(secrets.csrf_token()).execute(pool).await.unwrap();
    (owner, secrets)
}
async fn call(
    state: &AppState,
    secrets: &SessionSecrets,
    method: &str,
    path: &str,
    csrf: bool,
    key: Option<&str>,
    body: &str,
) -> (StatusCode, serde_json::Value) {
    let mut req = Request::builder()
        .method(method)
        .uri(path)
        .header("Host", "atelier.test")
        .header("Origin", "https://atelier.test")
        .header("Cookie", secrets.cookie())
        .header("Content-Type", "application/json");
    if csrf {
        req = req.header("X-CSRF-Token", secrets.csrf_token());
    }
    if let Some(key) = key {
        req = req.header("Idempotency-Key", key);
    }
    let result = router(state.clone())
        .oneshot(req.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    assert_eq!(result.headers()["cache-control"], "no-store");
    let status = result.status();
    let bytes = to_bytes(result.into_body(), 1024 * 1024).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}
#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL"]
async fn billing_http_protects_orders_and_manual_payment_replays(pool: PgPool) {
    let (_, user) = session(&pool, false).await;
    let (_, other) = session(&pool, false).await;
    let (_, admin) = session(&pool, true).await;
    let mut state = AppState::test();
    state.db = pool.clone();
    state.auth = SessionService::new(
        Arc::new(PostgresSessions::new(pool.clone())),
        PublicOrigin::parse("https://atelier.test").unwrap(),
    );
    state.limits = Some(Arc::new(
        RedisTransient::connect(&std::env::var("TEST_REDIS_URL").unwrap())
            .await
            .unwrap(),
    ));
    let body = r#"{"name":"Monthly","kind":"MONTHLY","description":"Manual only","price_cents":1000,"currency":"CNY","credits":100,"period_days":30,"rollover":true,"concurrency_limit":3,"max_resolution":"4K","retention_days":180,"active":true}"#;
    assert_eq!(
        call(
            &state,
            &user,
            "POST",
            "/api/v1/admin/plans",
            true,
            None,
            body
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(
            &state,
            &admin,
            "POST",
            "/api/v1/admin/plans",
            false,
            None,
            body
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (status, plan) = call(
        &state,
        &admin,
        "POST",
        "/api/v1/admin/plans",
        true,
        None,
        body,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let body = serde_json::json!({"plan_id":plan["id"],"plan_revision":1}).to_string();
    let k = Uuid::new_v4().to_string();
    let first = call(
        &state,
        &user,
        "POST",
        "/api/v1/orders",
        true,
        Some(&k),
        &body,
    )
    .await;
    assert_eq!(first.0, StatusCode::OK);
    assert_eq!(
        first.1,
        call(
            &state,
            &user,
            "POST",
            "/api/v1/orders",
            true,
            Some(&k),
            &body
        )
        .await
        .1
    );
    let id = first.1["order"]["id"].as_str().unwrap();
    let path = format!("/api/v1/orders/{id}");
    assert_eq!(
        call(&state, &other, "GET", &path, false, None, "").await.0,
        StatusCode::NOT_FOUND
    );
    assert!(
        call(&state, &other, "GET", "/api/v1/orders", false, None, "")
            .await
            .1["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let paid = format!("/api/v1/admin/orders/{id}/mark-paid");
    let b = r#"{"amount_cents":1000,"currency":"CNY","trade_no":"receipt-http","reason":"Verified receipt"}"#;
    assert_eq!(
        call(&state, &user, "POST", &paid, true, Some(&k), b)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(&state, &admin, "POST", &paid, false, Some(&k), b)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    for _ in 0..2 {
        assert_eq!(
            call(&state, &admin, "POST", &paid, true, Some(&k), b)
                .await
                .0,
            StatusCode::OK
        );
    }
    assert_eq!(
        call(&state, &user, "GET", "/api/v1/wallet", false, None, "")
            .await
            .1["balance"],
        120
    );
    let tier = call(
        &state,
        &user,
        "GET",
        "/api/v1/subscription",
        false,
        None,
        "",
    )
    .await
    .1;
    assert_eq!(tier["tier"], "SUBSCRIBER");
    assert_eq!(tier["max_resolution"], "4K");
    assert_eq!(
        call(
            &state,
            &other,
            "GET",
            &format!("/api/v1/admin/orders/{id}/refund-quote"),
            false,
            None,
            ""
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    sqlx::query("UPDATE sessions SET mfa_verified_at=now()-interval '13 hours' WHERE user_id=(SELECT user_id FROM sessions WHERE token_hash=$1)").bind(admin.token_hash().as_slice()).execute(&pool).await.unwrap();
    assert_eq!(
        call(
            &state,
            &admin,
            "GET",
            "/api/v1/admin/orders",
            false,
            None,
            ""
        )
        .await
        .1["error"]["code"],
        "MFA_REQUIRED"
    );
}
