use atelier_app::{router, AppState};
use atelier_auth::{
    postgres::PostgresSessions,
    service::{PublicOrigin, SessionService},
    session::SessionSecrets,
};
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use sqlx::PgPool;
use std::sync::Arc;
use tower::ServiceExt;
use uuid::Uuid;
async fn session(db: &PgPool) -> SessionSecrets {
    let id = Uuid::new_v4();
    let secrets = SessionSecrets::generate().unwrap();
    sqlx::query("INSERT INTO users(id,google_sub,email,canonical_email,display_name) VALUES($1,$2,$2,$2,'Canvas HTTP')").bind(id).bind(format!("{id}@gmail.com")).execute(db).await.unwrap();
    sqlx::query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,$3,now()+interval '1 day')").bind(secrets.token_hash().as_slice()).bind(id).bind(secrets.csrf_token()).execute(db).await.unwrap();
    secrets
}
async fn call(
    state: &AppState,
    secrets: &SessionSecrets,
    method: &str,
    path: &str,
    csrf: bool,
    revision: Option<&str>,
    body: serde_json::Value,
) -> (StatusCode, serde_json::Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("Host", "atelier.test")
        .header("Origin", "https://atelier.test")
        .header("Cookie", secrets.cookie())
        .header("Content-Type", "application/json")
        .header("Idempotency-Key", Uuid::new_v4().to_string());
    if csrf {
        request = request.header("X-CSRF-Token", secrets.csrf_token());
    }
    if let Some(revision) = revision {
        request = request.header("If-Match", revision);
    }
    let result = router(state.clone())
        .oneshot(request.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    assert_eq!(result.headers()["cache-control"], "no-store");
    let status = result.status();
    let bytes = to_bytes(result.into_body(), 3 * 1024 * 1024).await.unwrap();
    (
        status,
        if bytes.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap()
        },
    )
}
#[test]
fn canvas_contract_documents_revision_and_whitelisted_graph_schema() {
    let doc = serde_json::to_value(atelier_app::openapi()).unwrap();
    assert!(
        doc["paths"]["/api/v1/projects/{id}/graph"]["put"]["parameters"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["name"] == "If-Match")
    );
    assert!(doc["components"]["schemas"]["ImageData"]["properties"]
        .get("media_url")
        .is_none());
    assert!(doc["components"]["schemas"]["CanvasNode"]
        .get("allOf")
        .is_some());
}
#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL"]
async fn canvas_http_checks_csrf_owner_revision_and_history(db: PgPool) {
    let owner = session(&db).await;
    let other = session(&db).await;
    let assets = atelier_assets::AssetService::new(
        db.clone(),
        atelier_assets::storage::Storage::memory(),
        atelier_assets::signing::MediaSigner::from_base64(
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        )
        .unwrap(),
    );
    let mut state = AppState::test();
    state.db = db.clone();
    state.auth = SessionService::new(
        Arc::new(PostgresSessions::new(db.clone())),
        PublicOrigin::parse("https://atelier.test").unwrap(),
    );
    state.canvas = Some(atelier_canvas::CanvasService::new(db, assets));
    let input = serde_json::json!({"name":"Canvas"});
    assert_eq!(
        call(
            &state,
            &owner,
            "POST",
            "/api/v1/projects",
            false,
            None,
            input.clone()
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (status, created) = call(
        &state,
        &owner,
        "POST",
        "/api/v1/projects",
        true,
        None,
        input,
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    let path = format!(
        "/api/v1/projects/{}",
        created["project"]["id"].as_str().unwrap()
    );
    assert_eq!(
        call(
            &state,
            &other,
            "GET",
            &path,
            false,
            None,
            serde_json::Value::Null
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(
            &state,
            &other,
            "PUT",
            &format!("{path}/graph"),
            true,
            Some("0"),
            created["graph"].clone()
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(
            &state,
            &owner,
            "PUT",
            &format!("{path}/graph"),
            true,
            None,
            created["graph"].clone()
        )
        .await
        .0,
        StatusCode::PRECONDITION_REQUIRED
    );
    let (status, saved) = call(
        &state,
        &owner,
        "PUT",
        &format!("{path}/graph"),
        true,
        Some("\"0\""),
        created["graph"].clone(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["project"]["revision"], 1);
    assert_eq!(
        call(
            &state,
            &owner,
            "PUT",
            &format!("{path}/graph"),
            true,
            Some("0"),
            created["graph"].clone()
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let (status, history) = call(
        &state,
        &owner,
        "GET",
        &format!("{path}/snapshots"),
        false,
        None,
        serde_json::Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(history.as_array().unwrap().len(), 2);
    assert_eq!(
        call(
            &state,
            &owner,
            "POST",
            &format!(
                "{path}/snapshots/{}/restore",
                history[1]["id"].as_str().unwrap()
            ),
            true,
            Some("1"),
            serde_json::Value::Null
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &state,
            &owner,
            "DELETE",
            &path,
            true,
            Some("2"),
            serde_json::Value::Null
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        call(
            &state,
            &owner,
            "GET",
            &path,
            false,
            None,
            serde_json::Value::Null
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
}
