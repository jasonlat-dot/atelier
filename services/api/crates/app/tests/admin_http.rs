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
async fn session(db: &PgPool, role: &str) -> (Uuid, SessionSecrets) {
    let id = Uuid::new_v4();
    let secret = SessionSecrets::generate().unwrap();
    sqlx::query("INSERT INTO users(id,google_sub,email,canonical_email,display_name,role,mfa_enabled,mfa_secret_enc) VALUES($1,$2,$2,$2,'Admin HTTP',$3,$4,$5)").bind(id).bind(format!("{id}@gmail.com")).bind(role).bind(role!="USER").bind(if role!="USER"{Some(vec![1u8;32])}else{None}).execute(db).await.unwrap();
    let mut tx = db.begin().await.unwrap();
    atelier_wallet::WalletService::signup_in_transaction(&mut tx, id)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    sqlx::query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,mfa_verified_at) VALUES($1,$2,$3,now()+interval '1 day',now())").bind(secret.token_hash().as_slice()).bind(id).bind(secret.csrf_token()).execute(db).await.unwrap();
    (id, secret)
}
async fn call(
    s: &AppState,
    c: &SessionSecrets,
    method: &str,
    path: &str,
    csrf: bool,
    body: serde_json::Value,
) -> (StatusCode, serde_json::Value) {
    let mut r = Request::builder()
        .method(method)
        .uri(path)
        .header("Host", "atelier.test")
        .header("Origin", "https://atelier.test")
        .header("Cookie", c.cookie())
        .header("Content-Type", "application/json")
        .header("Idempotency-Key", Uuid::new_v4().to_string());
    if csrf {
        r = r.header("X-CSRF-Token", c.csrf_token());
    }
    let result = router(s.clone())
        .oneshot(r.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    assert_eq!(result.headers()["cache-control"], "no-store");
    let status = result.status();
    let bytes = to_bytes(result.into_body(), 1024 * 1024).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null),
    )
}
#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL and TEST_REDIS_URL"]
async fn every_admin_surface_rejects_users_and_super_settings_remain_protected(db: PgPool) {
    let (owner, user) = session(&db, "USER").await;
    let (_, admin) = session(&db, "ADMIN").await;
    let (root_id, root) = session(&db, "SUPER_ADMIN").await;
    let mut s = AppState::test();
    s.db = db.clone();
    s.auth = SessionService::new(
        Arc::new(PostgresSessions::new(db.clone())),
        PublicOrigin::parse("https://atelier.test").unwrap(),
    );
    s.limits = Some(Arc::new(
        RedisTransient::connect(&std::env::var("TEST_REDIS_URL").unwrap())
            .await
            .unwrap(),
    ));
    let mut routes = vec![
        ("GET", "/admin/dashboard".to_string()),
        ("GET", "/admin/users".into()),
        ("GET", format!("/admin/users/{owner}")),
        ("GET", format!("/admin/users/{owner}/ledger")),
        ("GET", "/admin/jobs".into()),
        ("GET", "/admin/settings".into()),
        ("PUT", "/admin/settings".into()),
        ("GET", "/admin/audit".into()),
        ("GET", "/admin/moderation-rules".into()),
        ("POST", "/admin/moderation-rules".into()),
        ("PATCH", "/admin/moderation-rules/1".into()),
        ("DELETE", "/admin/moderation-rules/1".into()),
        ("GET", "/admin/invite-codes".into()),
        ("POST", "/admin/invite-codes".into()),
        ("PATCH", format!("/admin/invite-codes/{owner}")),
        ("DELETE", format!("/admin/invite-codes/{owner}")),
        ("GET", "/admin/upstream-accounts".into()),
        ("GET", "/admin/models".into()),
        ("GET", "/admin/plans".into()),
        ("GET", "/admin/orders".into()),
        ("GET", "/admin/redeem-codes".into()),
    ];
    for a in [
        "disable",
        "enable",
        "role",
        "revoke-sessions",
        "review",
        "credits",
    ] {
        routes.push(("POST", format!("/admin/users/{owner}/{a}")));
    }
    for a in ["cancel", "refund"] {
        routes.push(("POST", format!("/admin/jobs/{owner}/{a}")));
    }
    for (method, path) in routes {
        let result = call(
            &s,
            &user,
            method,
            &format!("/api/v1{path}"),
            true,
            serde_json::json!({}),
        )
        .await;
        assert_eq!(
            result.0,
            StatusCode::FORBIDDEN,
            "{method} {path}: {}",
            result.1
        );
    }
    let usage = call(
        &s,
        &user,
        "GET",
        "/api/v1/me/usage?days=1",
        false,
        serde_json::json!({}),
    )
    .await;
    assert_eq!(usage.0, StatusCode::OK);
    assert_eq!(usage.1["days"], 1);
    assert_eq!(usage.1["daily"].as_array().unwrap().len(), 1);
    assert_eq!(usage.1["previous"]["jobs"], 0);
    assert_eq!(usage.1["previous"]["consumed"], 0);
    assert_eq!(usage.1["released_credits"], 0);
    assert!(usage.1["kinds"].as_array().unwrap().is_empty());
    assert!(usage.1["recent"].as_array().unwrap().is_empty());
    assert_eq!(
        call(
            &s,
            &admin,
            "GET",
            "/api/v1/admin/settings",
            false,
            serde_json::json!({})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(
            &s,
            &admin,
            "GET",
            "/api/v1/admin/audit",
            false,
            serde_json::json!({})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(
            &s,
            &root,
            "GET",
            "/api/v1/admin/settings",
            false,
            serde_json::json!({})
        )
        .await
        .0,
        StatusCode::OK
    );
    let action = serde_json::json!({"revision":1,"reason":"核对后禁用","role":null});
    let path = format!("/api/v1/admin/users/{owner}/disable");
    assert_eq!(
        call(&s, &admin, "POST", &path, false, action.clone())
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let result = call(&s, &admin, "POST", &path, true, action).await;
    assert_eq!(result.0, StatusCode::OK);
    assert_eq!(result.1["status"], "DISABLED");
    assert!(
        !call(&s, &user, "GET", "/api/v1/me", false, serde_json::json!({}))
            .await
            .0
            .is_success()
    );
    let audit = call(
        &s,
        &root,
        "GET",
        "/api/v1/admin/audit?q=ADMIN_USER_DISABLE",
        false,
        serde_json::json!({}),
    )
    .await;
    assert_eq!(audit.0, StatusCode::OK);
    assert_eq!(audit.1["items"].as_array().unwrap().len(), 1);
    assert_eq!(audit.1["items"][0]["before"]["status"], "ACTIVE");
    let text = audit.1.to_string();
    for secret in [
        "token_hash",
        "csrf_token",
        "mfa_secret_enc",
        "base_url",
        "upstream_model",
    ] {
        assert!(!text.contains(secret));
    }
    let roles = call(
        &s,
        &admin,
        "POST",
        &format!("/api/v1/admin/users/{root_id}/role"),
        true,
        serde_json::json!({"revision":1,"role":"USER","reason":"越权测试"}),
    )
    .await;
    assert_eq!(roles.0, StatusCode::FORBIDDEN);
    sqlx::query(
        "UPDATE sessions SET mfa_verified_at=now()-interval '13 hours' WHERE token_hash=$1",
    )
    .bind(root.token_hash().as_slice())
    .execute(&db)
    .await
    .unwrap();
    assert_eq!(
        call(
            &s,
            &root,
            "GET",
            "/api/v1/admin/dashboard",
            false,
            serde_json::json!({})
        )
        .await
        .1["error"]["code"],
        "MFA_REQUIRED"
    );
}
