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
#[ignore = "Requires isolated PostgreSQL and TEST_REDIS_URL"]
async fn real_wallet_http_authorization_csrf_rate_limit_and_receipts(pool: PgPool) {
    atelier_wallet::WalletService::new(pool.clone())
        .restrict_ledger()
        .await
        .unwrap();
    let (owner, user) = session(&pool, false).await;
    let (_, admin) = session(&pool, true).await;
    let mut state = AppState::test();
    state.db = pool.clone();
    state.auth = SessionService::new(
        Arc::new(PostgresSessions::new(pool)),
        PublicOrigin::parse("https://atelier.test").unwrap(),
    );
    state.limits = Some(Arc::new(
        RedisTransient::connect(&std::env::var("TEST_REDIS_URL").unwrap())
            .await
            .unwrap(),
    ));
    let (status, summary) = call(&state, &user, "GET", "/api/v1/wallet", false, None, "").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(summary["balance"], 20);
    assert_eq!(
        call(
            &state,
            &user,
            "POST",
            "/api/v1/wallet/checkin",
            false,
            None,
            ""
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let target = format!("/api/v1/admin/users/{owner}/credits");
    let key = Uuid::new_v4().to_string();
    let body = r#"{"amount":7,"reason":"HTTP adjustment"}"#;
    assert_eq!(
        call(&state, &user, "POST", &target, true, Some(&key), body)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(&state, &admin, "POST", &target, true, None, body)
            .await
            .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let first = call(&state, &admin, "POST", &target, true, Some(&key), body).await;
    assert_eq!(first.0, StatusCode::OK);
    assert_eq!(
        call(&state, &admin, "POST", &target, true, Some(&key), body)
            .await
            .1,
        first.1
    );
    assert_eq!(
        call(
            &state,
            &admin,
            "POST",
            &target,
            true,
            Some(&key),
            r#"{"amount":8,"reason":"HTTP adjustment"}"#
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    for _ in 0..10 {
        assert_eq!(
            call(
                &state,
                &user,
                "POST",
                "/api/v1/wallet/checkin",
                true,
                None,
                ""
            )
            .await
            .0,
            StatusCode::OK
        );
    }
    assert_eq!(
        call(
            &state,
            &user,
            "POST",
            "/api/v1/wallet/checkin",
            true,
            None,
            ""
        )
        .await
        .0,
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(
        call(&state, &user, "GET", "/api/v1/wallet", false, None, "")
            .await
            .1["balance"],
        37
    );
    assert_eq!(
        call(
            &state,
            &user,
            "GET",
            "/api/v1/wallet/ledger?limit=0",
            false,
            None,
            ""
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        call(
            &state,
            &user,
            "GET",
            "/api/v1/wallet?user_id=other",
            false,
            None,
            ""
        )
        .await
        .1["balance"],
        37
    );
    state.limits = None;
    assert_eq!(
        call(
            &state,
            &user,
            "POST",
            "/api/v1/wallet/checkin",
            true,
            None,
            ""
        )
        .await
        .0,
        StatusCode::SERVICE_UNAVAILABLE
    );
}

#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL and TEST_REDIS_URL"]
async fn code_copy_is_admin_csrf_protected_audited_and_excludes_plaintext_from_lists(pool: PgPool) {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let (_, user) = session(&pool, false).await;
    let (_, admin) = session(&pool, true).await;
    let mut state = AppState::test();
    state.db = pool.clone();
    state.auth = SessionService::new(
        Arc::new(PostgresSessions::new(pool.clone())),
        PublicOrigin::parse("https://atelier.test").unwrap(),
    );
    state.code_cipher =
        Some(atelier_wallet::RedeemCodeCipher::from_base64(&STANDARD.encode([71; 32])).unwrap());
    state.limits = Some(Arc::new(
        RedisTransient::connect(&std::env::var("TEST_REDIS_URL").unwrap())
            .await
            .unwrap(),
    ));
    let base = "/api/v1/admin/redeem-codes";
    let body = r#"{"count":1,"credits":7,"max_uses":2,"expires_at":null}"#;
    assert_eq!(
        call(&state, &user, "POST", base, true, None, body).await.0,
        StatusCode::FORBIDDEN
    );
    let (status, created) = call(&state, &admin, "POST", base, true, None, body).await;
    assert_eq!(status, StatusCode::OK);
    let id = created["codes"][0]["id"].as_str().unwrap();
    let code = created["codes"][0]["code"].as_str().unwrap();
    let copy_path = format!("{base}/{id}/copy");
    assert_eq!(
        call(&state, &user, "POST", &copy_path, true, None, "")
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(&state, &admin, "POST", &copy_path, false, None, "")
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let (status, copied) = call(&state, &admin, "POST", &copy_path, true, None, "").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(copied["code"], code);
    let (status, list) = call(&state, &admin, "GET", base, false, None, "").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(list[0]["copyable"], true);
    assert!(!list.to_string().contains(code));
    let audit: serde_json::Value = sqlx::query_scalar(
        "SELECT after FROM audit_logs WHERE action='REDEEM_CODE_REVEALED' AND target_id=$1",
    )
    .bind(id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(!audit.to_string().contains(code));
    sqlx::query("UPDATE redeem_codes SET code_enc=NULL WHERE id=$1")
        .bind(Uuid::parse_str(id).unwrap())
        .execute(&pool)
        .await
        .unwrap();
    let (status, response) = call(&state, &admin, "POST", &copy_path, true, None, "").await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(response["error"]["code"], "CODE_NOT_RECOVERABLE");
    assert_eq!(
        call(
            &state,
            &user,
            "GET",
            "/api/v1/admin/credits/adjustments",
            false,
            None,
            ""
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(
            &state,
            &admin,
            "GET",
            "/api/v1/admin/credits/adjustments",
            false,
            None,
            ""
        )
        .await
        .0,
        StatusCode::OK
    );
}

#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL and TEST_REDIS_URL"]
async fn code_lifecycle_http_requires_admin_mfa_csrf_and_current_revision(pool: PgPool) {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let (_, user) = session(&pool, false).await;
    let (actor, admin) = session(&pool, true).await;
    let mut state = AppState::test();
    state.db = pool.clone();
    state.auth = SessionService::new(
        Arc::new(PostgresSessions::new(pool.clone())),
        PublicOrigin::parse("https://atelier.test").unwrap(),
    );
    state.code_cipher =
        Some(atelier_wallet::RedeemCodeCipher::from_base64(&STANDARD.encode([71; 32])).unwrap());
    state.limits = Some(Arc::new(
        RedisTransient::connect(&std::env::var("TEST_REDIS_URL").unwrap())
            .await
            .unwrap(),
    ));
    let base = "/api/v1/admin/redeem-codes";
    let (_, created) = call(
        &state,
        &admin,
        "POST",
        base,
        true,
        None,
        r#"{"count":1,"credits":7,"max_uses":2,"expires_at":null}"#,
    )
    .await;
    let id = created["codes"][0]["id"].as_str().unwrap();
    let path = format!("{base}/{id}");
    let stop = r#"{"revision":1,"disabled":true}"#;
    let delete = r#"{"revision":1}"#;
    for (method, body) in [("PATCH", stop), ("DELETE", delete)] {
        assert_eq!(
            call(&state, &user, method, &path, true, None, body).await.0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            call(&state, &admin, method, &path, false, None, body)
                .await
                .0,
            StatusCode::FORBIDDEN
        );
    }
    sqlx::query("UPDATE sessions SET mfa_verified_at=NULL WHERE user_id=$1")
        .bind(actor)
        .execute(&pool)
        .await
        .unwrap();
    for (method, body) in [("PATCH", stop), ("DELETE", delete)] {
        let (status, error) = call(&state, &admin, method, &path, true, None, body).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(error["error"]["code"], "MFA_REQUIRED");
    }
    sqlx::query("UPDATE sessions SET mfa_verified_at=now() WHERE user_id=$1")
        .bind(actor)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        call(
            &state,
            &admin,
            "PATCH",
            &path,
            true,
            None,
            r#"{"revision":0,"disabled":true}"#
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let (status, stopped) = call(&state, &admin, "PATCH", &path, true, None, stop).await;
    assert_eq!(status, StatusCode::OK);
    assert!(stopped["disabled_at"].is_string());
    assert_eq!(stopped["revision"], 2);
    let redeem = serde_json::json!({"code":created["codes"][0]["code"]}).to_string();
    let request = Uuid::new_v4().to_string();
    assert_eq!(
        call(
            &state,
            &user,
            "POST",
            "/api/v1/wallet/redeem",
            true,
            Some(&request),
            &redeem
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let (status, changed) = call(&state, &admin, "DELETE", &path, true, None, delete).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(changed["error"]["code"], "REDEEM_CODE_CHANGED");
    assert_eq!(
        call(
            &state,
            &admin,
            "PATCH",
            &path,
            true,
            None,
            r#"{"revision":2,"disabled":false}"#
        )
        .await
        .0,
        StatusCode::OK
    );
    let (status, removed) = call(
        &state,
        &admin,
        "DELETE",
        &path,
        true,
        None,
        r#"{"revision":3}"#,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(removed["deleted_at"].is_string());
    assert_eq!(
        call(&state, &admin, "GET", base, false, None, "").await.1,
        serde_json::json!([])
    );
    assert_eq!(
        call(
            &state,
            &admin,
            "POST",
            &format!("{path}/copy"),
            true,
            None,
            ""
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(
            &state,
            &admin,
            "PATCH",
            &path,
            true,
            None,
            r#"{"revision":4,"disabled":false}"#
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
}
