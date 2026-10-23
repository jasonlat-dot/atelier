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
async fn json_call(
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

struct TextFixture;
impl atelier_agent_core::LlmClient for TextFixture {
    fn stream(
        &self,
        _: atelier_agent_core::ChatRequest,
    ) -> atelier_agent_core::CoreFuture<'_, atelier_agent_core::TokenStream> {
        Box::pin(async {
            Ok(Box::pin(futures_util::stream::iter(vec![Ok(
                "A real HTTP streaming reply".into(),
            )])) as atelier_agent_core::TokenStream)
        })
    }
}
#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL and TEST_REDIS_URL"]
async fn chat_stream_requires_csrf_owns_conversations_and_replays_one_charge(db: PgPool) {
    use base64::Engine;
    let (owner, user) = session(&db, false).await;
    let (_, other) = session(&db, false).await;
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
    let upstream = atelier_upstream::UpstreamService::new(
        db.clone(),
        atelier_upstream::crypto::SecretCipher::from_base64(
            &base64::engine::general_purpose::STANDARD.encode([7; 32]),
        )
        .unwrap(),
        atelier_upstream::egress::SafeHttp::new(Default::default()),
    );
    state.chat = Some(
        atelier_chat::ChatService::new(db.clone(), upstream).with_client(Arc::new(TextFixture)),
    );
    sqlx::query("INSERT INTO models(id,kind,display_name,upstream_model,enabled,capabilities) VALUES('chat','chat','Public Chat','private-id',true,'{\"qualities\":[\"message\"],\"ratios\":[],\"resolutions\":[\"text\"],\"max_n\":1}')").execute(&db).await.unwrap();
    let key = Uuid::new_v4().to_string();
    assert_eq!(
        json_call(
            &state,
            &user,
            "POST",
            "/api/v1/chat/conversations",
            false,
            Some(&key),
            r#"{"title":"Private"}"#
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (status, created) = json_call(
        &state,
        &user,
        "POST",
        "/api/v1/chat/conversations",
        true,
        Some(&key),
        r#"{"title":"Private"}"#,
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let id = created["id"].as_str().unwrap();
    let path = format!("/api/v1/chat/conversations/{id}");
    assert_eq!(
        json_call(&state, &other, "GET", &path, false, None, "")
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    let input = r#"{"model_id":"chat","content":"生成一张海报"}"#;
    let message_path = format!("{path}/messages");
    assert_eq!(
        json_call(
            &state,
            &user,
            "POST",
            &message_path,
            false,
            Some(&Uuid::new_v4().to_string()),
            input
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let request_key = Uuid::new_v4().to_string();
    for _ in 0..2 {
        let request = Request::builder()
            .method("POST")
            .uri(&message_path)
            .header("Host", "atelier.test")
            .header("Origin", "https://atelier.test")
            .header("Cookie", user.cookie())
            .header("X-CSRF-Token", user.csrf_token())
            .header("Content-Type", "application/json")
            .header("Idempotency-Key", &request_key)
            .body(Body::from(input))
            .unwrap();
        let response = router(state.clone()).oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["x-accel-buffering"], "no");
        let data = String::from_utf8(
            to_bytes(response.into_body(), 100000)
                .await
                .unwrap()
                .to_vec(),
        )
        .unwrap();
        assert!(
            data.contains("event: delta")
                && data.contains("event: done")
                && data.contains("event: action")
        );
        assert!(!data.contains("private-id"));
    }
    assert_eq!(
        atelier_wallet::WalletService::new(db)
            .summary(owner)
            .await
            .unwrap()
            .balance,
        19
    );
}
