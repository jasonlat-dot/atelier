use atelier_upstream::egress::{EgressPolicy, Payload, SafeHttp};
use axum::{
    http::{header, HeaderMap, StatusCode},
    response::IntoResponse,
    routing::get,
    Router,
};
use reqwest::Method;
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
#[tokio::test]
async fn guarded_client_never_follows_redirects_and_bounds_bodies_time_and_origins() {
    let hits = Arc::new(AtomicUsize::new(0));
    let target = hits.clone();
    let app = Router::new()
        .route(
            "/ok",
            get(|headers: HeaderMap| async move {
                assert_eq!(headers[header::AUTHORIZATION], "Bearer synthetic-key");
                "ok"
            }),
        )
        .route(
            "/redirect",
            get(|| async { (StatusCode::FOUND, [(header::LOCATION, "/target")]).into_response() }),
        )
        .route(
            "/target",
            get(move || {
                let target = target.clone();
                async move {
                    target.fetch_add(1, Ordering::SeqCst);
                    "forbidden"
                }
            }),
        )
        .route("/large", get(|| async { "x".repeat(1024) }))
        .route(
            "/slow",
            get(|| async {
                tokio::time::sleep(Duration::from_secs(5)).await;
                "late"
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let client = SafeHttp::new(EgressPolicy::with_local_origins(vec![origin.clone()]).unwrap());
    let result = client
        .send(
            Method::GET,
            &format!("{origin}/ok"),
            Some("synthetic-key"),
            Payload::Empty,
            Duration::from_secs(2),
            16,
        )
        .await
        .unwrap();
    assert_eq!(&result.body[..], b"ok");
    assert!(client
        .send(
            Method::GET,
            &format!("{origin}/redirect"),
            Some("synthetic-key"),
            Payload::Empty,
            Duration::from_secs(2),
            16
        )
        .await
        .is_err());
    assert_eq!(hits.load(Ordering::SeqCst), 0);
    assert!(client
        .send(
            Method::GET,
            &format!("{origin}/large"),
            None,
            Payload::Empty,
            Duration::from_secs(2),
            16
        )
        .await
        .is_err());
    assert!(client
        .with_timeout_limit(Duration::from_millis(50))
        .send(
            Method::GET,
            &format!("{origin}/slow"),
            None,
            Payload::Empty,
            Duration::from_secs(2),
            16
        )
        .await
        .is_err());
    assert!(SafeHttp::new(EgressPolicy::default())
        .send(
            Method::GET,
            &format!("{origin}/target"),
            None,
            Payload::Empty,
            Duration::from_secs(2),
            16
        )
        .await
        .is_err());
    assert_eq!(hits.load(Ordering::SeqCst), 0);
    server.abort();
}
