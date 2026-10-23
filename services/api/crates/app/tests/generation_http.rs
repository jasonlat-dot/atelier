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

#[test]
fn generation_contract_requires_authoritative_input_and_idempotency() {
    let doc = serde_json::to_value(atelier_app::openapi()).unwrap();
    assert!(
        doc["paths"]["/api/v1/generation/jobs"]["post"]["parameters"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["name"] == "Idempotency-Key")
    );
    assert_eq!(
        doc["components"]["schemas"]["JobInput"]["additionalProperties"],
        false
    );
    assert!(doc["components"]["schemas"]["JobView"]["properties"]
        .get("account_id")
        .is_none());
}
#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL and TEST_REDIS_URL"]
async fn generation_http_reprices_is_idempotent_and_enforces_csrf_ownership_and_mfa(db: PgPool) {
    use base64::Engine;
    let (owner, user) = session(&db, false).await;
    let (_, other) = session(&db, false).await;
    let (admin_id, admin) = session(&db, true).await;
    sqlx::query("INSERT INTO models(id,kind,display_name,upstream_model,enabled,capabilities) VALUES('image','image','Public Image','private-model',true,'{\"qualities\":[\"low\"],\"ratios\":[\"1:1\"],\"resolutions\":[\"1K\"],\"max_n\":4}')").execute(&db).await.unwrap();
    sqlx::query("INSERT INTO pricing_rules(model_id,quality,base_credits) VALUES('image','low',4)")
        .execute(&db)
        .await
        .unwrap();
    let mut state = AppState::test();
    state.db = db.clone();
    state.auth = SessionService::new(
        Arc::new(PostgresSessions::new(db.clone())),
        PublicOrigin::parse("https://atelier.test").unwrap(),
    );
    state.limits = Some(Arc::new(
        RedisTransient::connect(&std::env::var("TEST_REDIS_URL").unwrap())
            .await
            .unwrap(),
    ));
    let assets = atelier_assets::AssetService::new(
        db.clone(),
        atelier_assets::storage::Storage::memory(),
        atelier_assets::signing::MediaSigner::from_base64(
            &base64::engine::general_purpose::STANDARD.encode([57; 32]),
        )
        .unwrap(),
    );
    state.generation = Some(atelier_generation::GenerationService::new(
        db.clone(),
        assets,
    ));
    let quote = r#"{"model_id":"image","quality":"low","ratio":"1:1","resolution":"1K","n":2,"ref_count":0}"#;
    let body = r#"{"model_id":"image","prompt":"An ocean","quality":"low","ratio":"1:1","resolution":"1K","n":2}"#;
    assert_eq!(
        call(
            &state,
            &user,
            "POST",
            "/api/v1/generation/quote",
            false,
            None,
            quote
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(
            &state,
            &user,
            "POST",
            "/api/v1/generation/quote",
            true,
            None,
            quote
        )
        .await
        .1["cost"],
        8
    );
    sqlx::query("UPDATE pricing_rules SET base_credits=5")
        .execute(&db)
        .await
        .unwrap();
    let key = Uuid::new_v4().to_string();
    assert_eq!(
        call(
            &state,
            &user,
            "POST",
            "/api/v1/generation/jobs",
            true,
            None,
            body
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let (status, first) = call(
        &state,
        &user,
        "POST",
        "/api/v1/generation/jobs",
        true,
        Some(&key),
        body,
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(first["job"]["cost"], 10);
    assert_eq!(
        call(
            &state,
            &user,
            "POST",
            "/api/v1/generation/jobs",
            true,
            Some(&key),
            body
        )
        .await
        .1,
        first
    );
    assert_eq!(
        call(
            &state,
            &user,
            "POST",
            "/api/v1/generation/jobs",
            true,
            Some(&Uuid::new_v4().to_string()),
            body
        )
        .await
        .0,
        StatusCode::TOO_MANY_REQUESTS
    );
    let id = first["job"]["id"].as_str().unwrap();
    let path = format!("/api/v1/generation/jobs/{id}");
    assert_eq!(
        call(&state, &other, "GET", &path, false, None, "").await.0,
        StatusCode::NOT_FOUND
    );
    let cancel = format!("{path}/cancel");
    assert_eq!(
        call(&state, &other, "POST", &cancel, true, None, "")
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(&state, &user, "POST", &cancel, false, None, "")
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(&state, &user, "POST", &cancel, true, None, "").await.1["job"]["status"],
        "CANCELLED"
    );
    assert_eq!(
        call(&state, &user, "POST", &cancel, true, None, "").await.1["job"]["released"],
        10
    );
    let wallet = atelier_wallet::WalletService::new(db.clone())
        .summary(owner)
        .await
        .unwrap();
    assert_eq!(wallet.held, 0);
    assert_eq!(wallet.balance, 20);
    assert!(!first.to_string().contains("private-model"));
    sqlx::query("UPDATE sessions SET mfa_verified_at=clock_timestamp()-interval '13 hours' WHERE user_id=$1").bind(admin_id).execute(&db).await.unwrap();
    assert_eq!(
        call(
            &state,
            &admin,
            "GET",
            "/api/v1/generation/jobs",
            false,
            None,
            ""
        )
        .await
        .1["error"]["code"],
        "MFA_REQUIRED"
    );
    let forged = body.replacen("{", "{\"cost\":1,", 1);
    assert_eq!(
        call(
            &state,
            &user,
            "POST",
            "/api/v1/generation/jobs",
            true,
            Some(&Uuid::new_v4().to_string()),
            &forged
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
}
