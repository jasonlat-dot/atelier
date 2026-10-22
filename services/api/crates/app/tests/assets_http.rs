use atelier_app::{router, AppState};
use atelier_assets::{signing::MediaSigner, storage::Storage, AssetService};
use atelier_auth::{
    postgres::PostgresSessions,
    service::{PublicOrigin, SessionService},
    session::SessionSecrets,
    transient::RedisTransient,
};
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    response::Response,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use sqlx::PgPool;
use std::sync::Arc;
use tower::ServiceExt;
use uuid::Uuid;

async fn session(db: &PgPool) -> SessionSecrets {
    let id = Uuid::new_v4();
    let session = SessionSecrets::generate().unwrap();
    sqlx::query("INSERT INTO users(id,google_sub,email,canonical_email,display_name) VALUES($1,$2,$2,$2,'Assets HTTP')").bind(id).bind(format!("{id}@gmail.com")).execute(db).await.unwrap();
    sqlx::query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,$3,now()+interval '1 day')").bind(session.token_hash().as_slice()).bind(id).bind(session.csrf_token()).execute(db).await.unwrap();
    session
}
async fn call(
    state: &AppState,
    session: Option<&SessionSecrets>,
    method: &str,
    path: &str,
    csrf: bool,
    body: Vec<u8>,
    content_type: &str,
) -> Response {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("Host", "atelier.test")
        .header("Origin", "https://atelier.test")
        .header("Content-Type", content_type);
    if let Some(session) = session {
        request = request.header("Cookie", session.cookie());
        if csrf {
            request = request.header("X-CSRF-Token", session.csrf_token());
        }
    }
    router(state.clone())
        .oneshot(request.body(Body::from(body)).unwrap())
        .await
        .unwrap()
}
fn multipart(payload: &[u8]) -> Vec<u8> {
    let mut body=b"--asset-boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"reference.png\"\r\nContent-Type: image/png\r\n\r\n".to_vec();
    body.extend_from_slice(payload);
    body.extend_from_slice(b"\r\n--asset-boundary--\r\n");
    body
}
async fn json(response: Response) -> serde_json::Value {
    serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap()).unwrap()
}
#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL and TEST_REDIS_URL"]
async fn media_uploads_require_csrf_and_owner_even_with_a_valid_signed_url(db: PgPool) {
    let owner = session(&db).await;
    let other = session(&db).await;
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
    state.assets = Some(AssetService::new(
        db.clone(),
        Storage::memory(),
        MediaSigner::from_base64(&STANDARD.encode([8u8; 32])).unwrap(),
    ));
    let file = include_bytes!("fixtures/reference.png");
    let content_type = "multipart/form-data; boundary=asset-boundary";
    assert_eq!(
        call(
            &state,
            None,
            "POST",
            "/api/v1/assets/uploads",
            false,
            multipart(file),
            content_type
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(
            &state,
            Some(&owner),
            "POST",
            "/api/v1/assets/uploads",
            false,
            multipart(file),
            content_type
        )
        .await
        .status(),
        StatusCode::FORBIDDEN
    );
    let forged = call(
        &state,
        Some(&owner),
        "POST",
        "/api/v1/assets/uploads",
        true,
        multipart(b"Not an image"),
        content_type,
    )
    .await;
    assert_eq!(forged.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(json(forged).await["error"]["code"], "INVALID_MEDIA");
    let uploaded = call(
        &state,
        Some(&owner),
        "POST",
        "/api/v1/assets/uploads",
        true,
        multipart(file),
        content_type,
    )
    .await;
    assert_eq!(uploaded.status(), StatusCode::CREATED);
    assert_eq!(uploaded.headers()["cache-control"], "no-store");
    let asset = json(uploaded).await;
    let id = asset["id"].as_str().unwrap();
    let media = asset["media_url"].as_str().unwrap();
    let wire = asset.to_string();
    for field in ["object_key", "thumb_key", "owner_id", "sha256"] {
        assert!(!wire.contains(field));
    }
    assert_eq!(
        call(
            &state,
            None,
            "GET",
            media,
            false,
            vec![],
            "application/json"
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(
            &state,
            Some(&other),
            "GET",
            media,
            false,
            vec![],
            "application/json"
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(
            &state,
            Some(&other),
            "GET",
            &format!("/api/v1/assets/{id}"),
            false,
            vec![],
            "application/json"
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    let response = call(
        &state,
        Some(&owner),
        "GET",
        media,
        false,
        vec![],
        "application/json",
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["content-type"], "image/png");
    assert_eq!(response.headers()["x-content-type-options"], "nosniff");
    assert_eq!(
        call(
            &state,
            Some(&other),
            "DELETE",
            &format!("/api/v1/assets/{id}"),
            true,
            vec![],
            "application/json"
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(
            &state,
            Some(&owner),
            "DELETE",
            &format!("/api/v1/assets/{id}"),
            false,
            vec![],
            "application/json"
        )
        .await
        .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(
            &state,
            Some(&owner),
            "DELETE",
            &format!("/api/v1/assets/{id}"),
            true,
            vec![],
            "application/json"
        )
        .await
        .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        call(
            &state,
            Some(&owner),
            "GET",
            media,
            false,
            vec![],
            "application/json"
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    let list = json(
        call(
            &state,
            Some(&owner),
            "GET",
            "/api/v1/assets",
            false,
            vec![],
            "application/json",
        )
        .await,
    )
    .await;
    assert_eq!(list["total"], 0);
    // Streaming multipart bounds apply even when the client lies about file extension.
    let oversized = call(
        &state,
        Some(&owner),
        "POST",
        "/api/v1/assets/uploads",
        true,
        multipart(&vec![0u8; atelier_assets::MAX_IMAGE_BYTES + 1]),
        content_type,
    )
    .await;
    assert_eq!(oversized.status(), StatusCode::PAYLOAD_TOO_LARGE);
}
