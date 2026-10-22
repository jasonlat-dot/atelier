use atelier_app::{router, AppState};
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use tower::ServiceExt;

#[tokio::test]
async fn health_is_public_and_describes_only_liveness() {
    let response = router(AppState::test())
        .oneshot(Request::get("/api/v1/health").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), 4096).await.unwrap();
    let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(body["status"], "ok");
    assert_eq!(body["milestone"], "M0");
}

#[tokio::test]
async fn no_cookie_or_forged_identity_can_access_business_or_money() {
    for path in [
        "/api/v1/me",
        "/api/v1/projects",
        "/api/v1/wallet",
        "/api/v1/wallet/checkin",
        "/api/v1/generation/jobs",
        "/api/v1/admin/users",
        "/api/admin/users",
    ] {
        for method in ["GET", "POST", "PUT", "PATCH", "DELETE"] {
            for cookie in ["", "atelier_sid=fake", "__Host-sid=fake; role=SUPER_ADMIN"] {
                let request = Request::builder()
                    .uri(path)
                    .method(method)
                    .header("Cookie", cookie)
                    .header("Content-Type", "application/json")
                    .body(Body::from(
                        r#"{"role":"SUPER_ADMIN","credits":999999,"userId":"owner-demo"}"#,
                    ))
                    .unwrap();
                let response = router(AppState::test()).oneshot(request).await.unwrap();
                assert_eq!(
                    response.status(),
                    StatusCode::UNAUTHORIZED,
                    "{method} {path} {cookie}"
                );
                let body = to_bytes(response.into_body(), 4096).await.unwrap();
                let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
                assert_eq!(body["error"]["code"], "UNAUTHENTICATED");
                assert!(body["error"]["request_id"].as_str().is_some());
            }
        }
    }
}

#[tokio::test]
async fn removed_login_and_media_cannot_fall_through_to_spa() {
    for path in ["/api/v1/dev/login", "/media/unknown"] {
        let response = router(AppState::test())
            .oneshot(Request::post(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
}

#[tokio::test]
async fn openapi_is_not_public_by_default() {
    let response = router(AppState::test())
        .oneshot(
            Request::get("/api/openapi.json")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}
