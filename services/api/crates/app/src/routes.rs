use crate::AppState;
use atelier_common::{ApiError, ErrorDetail, ErrorResponse};
use axum::{
    routing::{any, get},
    Json, Router,
};
use serde::Serialize;
use tower_http::{
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};
use utoipa::{OpenApi, ToSchema};

#[derive(Serialize, ToSchema)]
pub struct Health {
    pub status: String,
    pub milestone: String,
}

/// Liveness only; does not assert that subsequent milestones are available.
#[utoipa::path(get, path = "/api/v1/health", responses((status = 200, body = Health)))]
async fn health() -> Json<Health> {
    Json(Health {
        status: "ok".into(),
        milestone: "M0".into(),
    })
}

async fn not_found() -> ApiError {
    ApiError::not_found()
}

#[derive(OpenApi)]
#[openapi(paths(health), components(schemas(Health, ErrorResponse, ErrorDetail)))]
struct Contract;

pub fn openapi() -> utoipa::openapi::OpenApi {
    Contract::openapi()
}

pub fn router(state: AppState) -> Router {
    let mut app = Router::new()
        .route("/api/v1/health", get(health))
        .route("/api/v1/dev/login", any(not_found))
        .route("/api/v1/{*path}", any(atelier_auth::require_authenticated))
        .route(
            "/api/admin/{*path}",
            any(atelier_auth::require_authenticated),
        )
        .route("/api", any(not_found))
        .route("/api/{*path}", any(not_found))
        .route("/media", any(not_found))
        .route("/media/{*path}", any(not_found));
    if state.expose_openapi {
        app = app.route("/api/openapi.json", get(|| async { Json(openapi()) }));
    }
    let static_files = ServeDir::new(&state.web_dir)
        .not_found_service(ServeFile::new(state.web_dir.join("index.html")));
    app.fallback_service(static_files)
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}
