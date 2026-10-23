//! Opt-in CI fixture only: production main never references this provider or signing key.
use atelier_app::{router, AppState};
use atelier_auth::{
    identity::{AuthFailure, AuthFuture, PostgresIdentity},
    login::LoginService,
    mfa::{MfaCipher, MfaService},
    oidc_attempt::AttemptFlow,
    oidc_provider::{verify_id_token, IdentityProvider, VerifiedIdentity},
    postgres::PostgresSessions,
    service::{PublicOrigin, SessionService},
    transient::RedisTransient,
};
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD as B64},
    Engine,
};
use ring::{
    rand::{SecureRandom, SystemRandom},
    signature::{RsaKeyPair, RSA_PKCS1_SHA256},
};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, sync::Arc};
struct FixtureProvider;
impl IdentityProvider for FixtureProvider {
    fn exchange(
        &self,
        code: String,
        verifier: String,
        nonce: String,
    ) -> AuthFuture<'_, VerifiedIdentity> {
        Box::pin(async move {
            let parts: Vec<_> = code.split('~').collect();
            if parts.len() != 3
                || parts[1] != nonce
                || parts[2] != B64.encode(Sha256::digest(verifier.as_bytes()))
            {
                return Err(AuthFailure::Identity);
            }
            let (sub, email) = match parts[0] {
                "user" => ("browser-user", "browseruser@gmail.com"),
                "admin" => ("browser-admin", "browseradmin@gmail.com"),
                _ => return Err(AuthFailure::Identity),
            };
            let now = chrono::Utc::now().timestamp();
            let claims = serde_json::json!({"iss":"https://accounts.google.com","aud":"browser-test","sub":sub,"email":email,"email_verified":true,"nonce":nonce,"exp":now+300,"iat":now});
            let input = format!(
                "{}.{}",
                B64.encode(r#"{"alg":"RS256","kid":"test-key"}"#),
                B64.encode(claims.to_string())
            );
            let key = RsaKeyPair::from_pkcs8(include_bytes!(
                "../../auth/tests/fixtures/oidc-test-only.pk8"
            ))
            .unwrap();
            let mut signature = vec![0; key.public().modulus_len()];
            key.sign(
                &RSA_PKCS1_SHA256,
                &SystemRandom::new(),
                input.as_bytes(),
                &mut signature,
            )
            .unwrap();
            verify_id_token(
                &format!("{input}.{}", B64.encode(signature)),
                include_str!("../../auth/tests/fixtures/jwks.json"),
                "browser-test",
                &nonce,
                now,
            )
        })
    }
}
#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Opt-in Playwright fixture with isolated PostgreSQL/Redis; never a production login mode"]
async fn browser_harness(db: sqlx::PgPool) {
    assert_eq!(std::env::var("TEST_AUTH_HARNESS").as_deref(), Ok("1"));
    let port: u16 = std::env::var("TEST_AUTH_PORT")
        .unwrap_or_else(|_| "8080".into())
        .parse()
        .unwrap();
    assert_ne!(port, 0);
    let base_url = format!("http://127.0.0.1:{port}");
    sqlx::query("UPDATE system_settings SET value='\"OPEN\"' WHERE key='registration_mode'")
        .execute(&db)
        .await
        .unwrap();
    let limits = Arc::new(
        RedisTransient::connect(
            &std::env::var("TEST_REDIS_URL").expect("isolated test Redis only"),
        )
        .await
        .unwrap(),
    );
    let identity = Arc::new(PostgresIdentity::new(
        db.clone(),
        HashSet::from(["browseradmin@gmail.com".into()]),
    ));
    let flow = AttemptFlow::new(
        limits.clone(),
        "browser-test".into(),
        format!("{base_url}/api/v1/auth/google/callback"),
    )
    .unwrap();
    let mut key = [0u8; 32];
    SystemRandom::new().fill(&mut key).unwrap();
    let cipher = MfaCipher::from_base64(&STANDARD.encode(key)).unwrap();
    let mut state = AppState::test();
    state.db = db.clone();
    // A real HTTP upstream, bound to a dynamic loopback port only in this test binary.
    let upstream_listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .unwrap();
    let upstream_origin = format!(
        "http://localhost:{}",
        upstream_listener.local_addr().unwrap().port()
    );
    // Pass the fixture address via a test-only file, never a production API or browser response.
    let upstream_file = std::env::var("TEST_UPSTREAM_ORIGIN_FILE").ok();
    if let Some(path) = upstream_file.as_ref() {
        std::fs::create_dir_all(std::path::Path::new(path).parent().unwrap()).unwrap();
        std::fs::write(path, &upstream_origin).unwrap();
    }
    let upstream_server = tokio::spawn(async move {
        axum::serve(
            upstream_listener,
            axum::Router::new().route(
                "/v1/models",
                axum::routing::get(|| async {
                    axum::Json(serde_json::json!({"data":[{"id":"fixture-private-model"}]}))
                }),
            )
            .route("/v1/chat/completions",axum::routing::post(|headers:axum::http::HeaderMap,axum::Json(body):axum::Json<serde_json::Value>|async move {
                use axum::response::IntoResponse;
                assert_eq!(headers[axum::http::header::AUTHORIZATION],"Bearer synthetic-browser-secret");assert_eq!(body["model"],"fixture-private-model");assert_eq!(body["stream"],true);
                let messages=body["messages"].as_array().unwrap();let text=messages.last().unwrap()["content"].as_str().unwrap();
                if text.contains("fixture fail"){return (axum::http::StatusCode::BAD_GATEWAY,axum::Json(serde_json::json!({"error":{"message":"private fixture failure"}}))).into_response();}
                let reply=if messages[0]["content"].as_str().unwrap().starts_with("Summarize creative") {serde_json::json!({"summary":"Continue the creative ocean project, retaining all earlier decisions.","facts":[]}).to_string()}else{"## 海岸创作建议\n\n先确定主体、光线与构图，再到画布确认生成。\n\n```text\nocean, soft light, quiet coast\n```".into()};
                let first=serde_json::json!({"choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}).to_string();
                let content=serde_json::json!({"choices":[{"index":0,"delta":{"content":reply},"finish_reason":null}]}).to_string();
                let finish=serde_json::json!({"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}).to_string();
                let slow=text.contains("fixture slow");
                let mut chunks=vec![format!("data: {first}\n\n"),format!("data: {content}\n\n"),format!("data: {finish}\n\ndata: [DONE]\n\n")];
                if text.contains("fixture truncated") {chunks.pop();}
                let stream=futures_util::stream::unfold((chunks,0),move|(chunks,index)|async move{if index>=chunks.len(){return None;}
                    if slow && index==2 {tokio::time::sleep(std::time::Duration::from_secs(10)).await;}else{tokio::time::sleep(std::time::Duration::from_millis(30)).await;}Some((Ok::<_,std::convert::Infallible>(chunks[index].clone()),(chunks,index+1)))});
                ([(axum::http::header::CONTENT_TYPE,"text/event-stream")],axum::body::Body::from_stream(stream)).into_response()
            }))
            .route("/v1/images/generations", axum::routing::post(|headers: axum::http::HeaderMap, axum::Json(body): axum::Json<serde_json::Value>| async move {
                assert_eq!(headers[axum::http::header::AUTHORIZATION], "Bearer synthetic-browser-secret");
                assert_eq!(body["model"], "fixture-private-model");
                axum::Json(serde_json::json!({"data":(0..body["n"].as_u64().unwrap()).map(|_|serde_json::json!({"b64_json":STANDARD.encode(include_bytes!("fixtures/reference.png"))})).collect::<Vec<_>>()}))
            }))
            .route("/v1/images/edits", axum::routing::post(|mut form: axum::extract::Multipart| async move {
                let mut found=false;
                while let Some(field)=form.next_field().await.unwrap(){if field.name()==Some("image[]"){assert!(!field.bytes().await.unwrap().is_empty());found=true;}}
                assert!(found);
                axum::Json(serde_json::json!({"data":[{"b64_json":STANDARD.encode(include_bytes!("fixtures/reference.png"))}]}))
            }))
            .route("/v1/videos", axum::routing::post(|axum::Json(body): axum::Json<serde_json::Value>| async move {
                assert_eq!(body["model"], "fixture-private-model");
                axum::Json(serde_json::json!({"id":"browser_video_1","status":"queued"}))
            }))
            .route("/v1/videos/{id}", axum::routing::get(|| async {axum::Json(serde_json::json!({"id":"browser_video_1","status":"completed"}))}))
            .route("/v1/videos/{id}/content", axum::routing::get(|| async {([(axum::http::header::CONTENT_TYPE,"video/mp4")],include_bytes!("fixtures/reference.mp4").as_slice())})),
        )
        .await
        .unwrap();
    });
    state.upstream = Some(
        atelier_upstream::UpstreamService::new(
            db.clone(),
            atelier_upstream::crypto::SecretCipher::from_base64(&STANDARD.encode(key)).unwrap(),
            atelier_upstream::egress::SafeHttp::new(
                atelier_upstream::egress::EgressPolicy::default(),
            ),
        )
        .with_slots(
            atelier_upstream::slots::SlotStore::connect(
                &std::env::var("TEST_REDIS_URL").unwrap(),
                &format!("browser-upstream:{}", uuid::Uuid::new_v4()),
            )
            .await
            .unwrap(),
        ),
    );
    let video = atelier_assets::video::VideoProcessor::from_lookup(|key| std::env::var(key).ok())
        .unwrap()
        .expect("Browser fixture requires FFmpeg");
    assert!(
        video.available().await,
        "Browser fixture requires FFmpeg/ffprobe"
    );
    let assets = atelier_assets::AssetService::new(
        db.clone(),
        atelier_assets::storage::Storage::memory(),
        atelier_assets::signing::MediaSigner::from_base64(&STANDARD.encode(key)).unwrap(),
    )
    .with_video(video);
    let processing = tokio::spawn(assets.clone().processing_loop());
    let generation = atelier_generation::GenerationService::new(db.clone(), assets.clone())
        .with_events(
            &std::env::var("TEST_REDIS_URL").unwrap(),
            &format!("browser-generation:{}", uuid::Uuid::new_v4()),
        )
        .await
        .unwrap();
    let worker = tokio::spawn(
        atelier_generation::GenerationWorker::new(
            generation.clone(),
            state.upstream.clone().unwrap(),
        )
        .run(),
    );
    let events = tokio::spawn(generation.clone().event_loop());
    state.generation = Some(generation);
    state.chat = Some(atelier_chat::ChatService::new(
        db.clone(),
        state.upstream.clone().unwrap(),
    ));
    let chat_recovery = tokio::spawn(state.chat.clone().unwrap().recovery_loop());
    state.canvas = Some(atelier_canvas::CanvasService::new(
        db.clone(),
        assets.clone(),
    ));
    state.assets = Some(assets);
    state.auth = SessionService::new(
        Arc::new(PostgresSessions::new(db)),
        PublicOrigin::parse(&base_url).unwrap(),
    );
    state.login = Some(LoginService::new(
        flow,
        Arc::new(FixtureProvider),
        identity.clone(),
    ));
    state.mfa = Some(MfaService::new(identity, limits.clone(), cipher));
    state.limits = Some(limits);
    state.web_dir =
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../apps/web/dist");
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
        .await
        .unwrap();
    axum::serve(
        listener,
        router(state).into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .await
    .unwrap();
    worker.abort();
    chat_recovery.abort();
    events.abort();
    processing.abort();
    upstream_server.abort();
}
