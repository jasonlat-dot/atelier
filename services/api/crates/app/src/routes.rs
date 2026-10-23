use crate::{
    auth_http::{require_session, AuthUser, RequireRole},
    AppState,
};
use atelier_auth::views::{DeviceList, DeviceSession, MeResponse, RenameRequest, SessionUser};
use atelier_common::{ApiError, ErrorDetail, ErrorResponse};
use axum::{
    extract::{
        rejection::{JsonRejection, PathRejection},
        Path, State,
    },
    http::{header, StatusCode},
    middleware,
    response::{IntoResponse, Response},
    routing::{any, delete, get, post},
    Json, Router,
};
use serde::Serialize;
use tower_http::{
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};
use utoipa::{OpenApi, ToSchema};
use uuid::Uuid;

#[derive(Serialize, ToSchema)]
pub struct Health {
    pub status: String,
    pub milestone: String,
}
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
async fn protected_missing(_actor: AuthUser) -> ApiError {
    ApiError::not_found()
}
async fn admin_missing(_actor: RequireRole<false>) -> ApiError {
    ApiError::not_found()
}
async fn super_admin_missing(_actor: RequireRole<true>) -> ApiError {
    ApiError::not_found()
}

#[utoipa::path(get, path = "/api/v1/me", security(("session" = [])), responses((status = 200, body = MeResponse), (status = 401, body = ErrorResponse), (status = 403, body = ErrorResponse), (status = 503, body = ErrorResponse)))]
async fn me(AuthUser(actor): AuthUser) -> Json<MeResponse> {
    Json(actor.me())
}
#[utoipa::path(patch, path = "/api/v1/me", request_body = RenameRequest, security(("session" = [], "csrf" = [])), responses((status = 200, body = MeResponse), (status = 401, body = ErrorResponse), (status = 403, body = ErrorResponse), (status = 422, body = ErrorResponse), (status = 503, body = ErrorResponse)))]
async fn rename(
    State(state): State<AppState>,
    AuthUser(actor): AuthUser,
    body: Result<Json<RenameRequest>, JsonRejection>,
) -> Result<Json<MeResponse>, ApiError> {
    let Json(body) = body.map_err(|_| {
        ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "VALIDATION",
            "Expected display_name only",
        )
    })?;
    Ok(Json(
        state
            .auth
            .rename(&actor, &body.display_name)
            .await
            .map_err(ApiError::from)?,
    ))
}
fn clear_cookie() -> &'static str {
    "__Host-sid=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0"
}
#[utoipa::path(post, path = "/api/v1/auth/logout", security(("session" = [], "csrf" = [])), responses((status = 204), (status = 401, body = ErrorResponse), (status = 403, body = ErrorResponse), (status = 503, body = ErrorResponse)))]
async fn logout(
    State(state): State<AppState>,
    AuthUser(actor): AuthUser,
) -> Result<Response, ApiError> {
    state.auth.logout(&actor).await.map_err(ApiError::from)?;
    Ok((
        StatusCode::NO_CONTENT,
        [(header::SET_COOKIE, clear_cookie())],
    )
        .into_response())
}
#[utoipa::path(get, path = "/api/v1/me/sessions", security(("session" = [])), responses((status = 200, body = DeviceList), (status = 401, body = ErrorResponse), (status = 403, body = ErrorResponse), (status = 503, body = ErrorResponse)))]
async fn devices(
    State(state): State<AppState>,
    AuthUser(actor): AuthUser,
) -> Result<Json<DeviceList>, ApiError> {
    Ok(Json(
        state.auth.devices(&actor).await.map_err(ApiError::from)?,
    ))
}
#[utoipa::path(delete, path = "/api/v1/me/sessions/{id}", params(("id" = Uuid, Path)), security(("session" = [], "csrf" = [])), responses((status = 204), (status = 401, body = ErrorResponse), (status = 403, body = ErrorResponse), (status = 404, body = ErrorResponse), (status = 503, body = ErrorResponse), (status = 422, body = ErrorResponse)))]
async fn revoke_device(
    State(state): State<AppState>,
    AuthUser(actor): AuthUser,
    id: Result<Path<Uuid>, PathRejection>,
) -> Result<Response, ApiError> {
    let Path(id) = id.map_err(|_| {
        ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "VALIDATION",
            "Invalid session identifier",
        )
    })?;
    state
        .auth
        .revoke_device(&actor, id)
        .await
        .map_err(ApiError::from)?;
    Ok(if id == actor.session_id() {
        (
            StatusCode::NO_CONTENT,
            [(header::SET_COOKIE, clear_cookie())],
        )
            .into_response()
    } else {
        StatusCode::NO_CONTENT.into_response()
    })
}

#[derive(OpenApi)]
#[openapi(
    paths(crate::generation_http::quote,crate::generation_http::create,crate::generation_http::list,crate::generation_http::get_one,crate::generation_http::cancel,crate::upstream_http::accounts,crate::upstream_http::account,crate::upstream_http::create_account,crate::upstream_http::update_account,crate::upstream_http::delete_account,crate::upstream_http::import_accounts,crate::upstream_http::probe,crate::upstream_http::refresh_quota,crate::upstream_http::stats,crate::upstream_http::models,crate::upstream_http::create_model,crate::upstream_http::update_model,crate::upstream_http::bindings,crate::upstream_http::pricing,crate::upstream_http::save_pricing,crate::upstream_http::catalog,crate::assets_http::list,crate::assets_http::get_one,crate::assets_http::limits,crate::assets_http::upload,crate::assets_http::delete_one,crate::assets_http::delete_many,crate::assets_http::media,crate::wallet_http::summary,crate::wallet_http::ledger,crate::wallet_http::checkin,crate::wallet_http::redeem,crate::wallet_http::adjust,crate::wallet_http::create_codes,crate::wallet_http::codes,health, me, rename, logout, devices, revoke_device,crate::login_http::google_start,crate::login_http::google_callback,crate::login_http::public_config,crate::login_http::mfa_setup,crate::login_http::mfa_verify),
    modifiers(&CookieSecurity),
    components(schemas(
        atelier_generation::JobInput,atelier_generation::QuoteInput,atelier_generation::Quote,atelier_generation::JobView,atelier_generation::JobParams,atelier_generation::Reference,atelier_generation::JobOutput,atelier_generation::JobReceipt,atelier_generation::JobPage,atelier_generation::JobEvent,
        atelier_upstream::AccountInput,atelier_upstream::AccountPage,atelier_upstream::AccountView,atelier_upstream::ModelInput,atelier_upstream::ModelView,atelier_upstream::BindingInput,atelier_upstream::QuotaInput,atelier_upstream::Pricing,atelier_upstream::Capabilities,atelier_upstream::PriceRule,atelier_upstream::SizeMultiplier,atelier_upstream::ProbeResult,atelier_upstream::FailureCode,atelier_upstream::AccountStats,atelier_upstream::ErrorCount,atelier_upstream::Catalog,atelier_upstream::CatalogModel,
        atelier_wallet::WalletSummary, atelier_wallet::LedgerPage, atelier_wallet::LedgerEntry, atelier_wallet::CheckinReceipt, atelier_wallet::CreditReceipt, atelier_wallet::RedeemRequest, atelier_wallet::AdjustRequest, atelier_wallet::CreateCodesRequest, atelier_wallet::CreatedCodes, atelier_wallet::CreatedCode, atelier_wallet::CodeInfo,
        atelier_assets::AssetView,atelier_assets::AssetPage,atelier_assets::DeleteAssets,atelier_assets::AssetLimits,crate::assets_http::UploadFile,
        Health,
        ErrorResponse,
        ErrorDetail,
        MeResponse,
        RenameRequest,
        DeviceList,
        DeviceSession,
        SessionUser,
        atelier_auth::identity::PublicConfig,
        atelier_auth::mfa::MfaSetup,
        atelier_auth::mfa::MfaCode,
        atelier_auth::policy::Role
    ))
)]
struct Contract;
pub fn openapi() -> utoipa::openapi::OpenApi {
    Contract::openapi()
}

pub fn router(state: AppState) -> Router {
    let protected = Router::new()
        .route(
            "/api/v1/generation/quote",
            post(crate::generation_http::quote)
                .layer(axum::extract::DefaultBodyLimit::max(32768))
                .fallback(protected_missing),
        )
        .route(
            "/api/v1/generation/jobs",
            get(crate::generation_http::list)
                .post(crate::generation_http::create)
                .layer(axum::extract::DefaultBodyLimit::max(32768))
                .fallback(protected_missing),
        )
        .route(
            "/api/v1/generation/jobs/{id}",
            get(crate::generation_http::get_one).fallback(protected_missing),
        )
        .route(
            "/api/v1/generation/jobs/{id}/cancel",
            post(crate::generation_http::cancel).fallback(protected_missing),
        )
        .route(
            "/api/v1/models",
            get(crate::upstream_http::catalog).fallback(protected_missing),
        )
        .route(
            "/api/v1/admin/upstream-accounts",
            get(crate::upstream_http::accounts)
                .post(crate::upstream_http::create_account)
                .fallback(admin_missing),
        )
        .route(
            "/api/v1/admin/upstream-accounts/import",
            post(crate::upstream_http::import_accounts)
                .fallback(admin_missing)
                .layer(axum::extract::DefaultBodyLimit::max(1024 * 1024)),
        )
        .route(
            "/api/v1/admin/upstream-accounts/{id}",
            get(crate::upstream_http::account)
                .patch(crate::upstream_http::update_account)
                .delete(crate::upstream_http::delete_account)
                .fallback(admin_missing),
        )
        .route(
            "/api/v1/admin/upstream-accounts/{id}/test",
            post(crate::upstream_http::probe).fallback(admin_missing),
        )
        .route(
            "/api/v1/admin/upstream-accounts/{id}/refresh-quota",
            post(crate::upstream_http::refresh_quota).fallback(admin_missing),
        )
        .route(
            "/api/v1/admin/upstream-accounts/{id}/stats",
            get(crate::upstream_http::stats).fallback(admin_missing),
        )
        .route(
            "/api/v1/admin/models",
            get(crate::upstream_http::models)
                .post(crate::upstream_http::create_model)
                .patch(crate::upstream_http::update_model)
                .fallback(admin_missing),
        )
        .route(
            "/api/v1/admin/models/{id}/accounts",
            axum::routing::put(crate::upstream_http::bindings).fallback(admin_missing),
        )
        .route(
            "/api/v1/admin/pricing",
            get(crate::upstream_http::pricing)
                .put(crate::upstream_http::save_pricing)
                .fallback(admin_missing),
        )
        .route(
            "/api/v1/assets",
            get(crate::assets_http::list)
                .delete(crate::assets_http::delete_many)
                .fallback(protected_missing),
        )
        .route(
            "/api/v1/assets/limits",
            get(crate::assets_http::limits).fallback(protected_missing),
        )
        .route(
            "/api/v1/assets/uploads",
            post(crate::assets_http::upload)
                .fallback(protected_missing)
                .layer(axum::extract::DefaultBodyLimit::max(
                    atelier_assets::MAX_VIDEO_BYTES + 1024 * 1024,
                )),
        )
        .route(
            "/api/v1/assets/{id}",
            get(crate::assets_http::get_one)
                .delete(crate::assets_http::delete_one)
                .fallback(protected_missing),
        )
        .route(
            "/api/v1/wallet",
            get(crate::wallet_http::summary).fallback(protected_missing),
        )
        .route(
            "/api/v1/wallet/ledger",
            get(crate::wallet_http::ledger).fallback(protected_missing),
        )
        .route(
            "/api/v1/wallet/checkin",
            post(crate::wallet_http::checkin).fallback(protected_missing),
        )
        .route(
            "/api/v1/wallet/redeem",
            post(crate::wallet_http::redeem).fallback(protected_missing),
        )
        .route(
            "/api/v1/admin/users/{id}/credits",
            post(crate::wallet_http::adjust).fallback(admin_missing),
        )
        .route(
            "/api/v1/admin/redeem-codes",
            get(crate::wallet_http::codes)
                .post(crate::wallet_http::create_codes)
                .fallback(admin_missing),
        )
        .route(
            "/api/v1/me",
            get(me).patch(rename).fallback(protected_missing),
        )
        .route(
            "/api/v1/me/sessions",
            get(devices).fallback(protected_missing),
        )
        .route(
            "/api/v1/me/sessions/{id}",
            delete(revoke_device).fallback(protected_missing),
        )
        .route(
            "/api/v1/auth/logout",
            post(logout).fallback(protected_missing),
        )
        .route(
            "/api/v1/admin/mfa/setup",
            post(crate::login_http::mfa_setup).fallback(admin_missing),
        )
        .route(
            "/api/v1/admin/mfa/verify",
            post(crate::login_http::mfa_verify).fallback(admin_missing),
        )
        .route("/api/v1/admin/settings", any(super_admin_missing))
        .route("/api/v1/admin/audit", any(super_admin_missing))
        .route("/api/v1/admin", any(admin_missing))
        .route("/api/v1/admin/{*path}", any(admin_missing))
        .route("/api/admin", any(admin_missing))
        .route("/api/admin/{*path}", any(admin_missing))
        .route("/api/v1/{*path}", any(protected_missing))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            require_session,
        ));
    let media = Router::new()
        .route(
            "/{id}/{variant}",
            get(crate::assets_http::media).fallback(protected_missing),
        )
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            require_session,
        ))
        .fallback(not_found);
    let mut app = Router::new()
        .nest("/media", media)
        .merge(protected)
        .route("/api/v1/health", get(health))
        .route(
            "/api/v1/auth/google/start",
            get(crate::login_http::google_start),
        )
        .route(
            "/api/v1/auth/google/callback",
            get(crate::login_http::google_callback),
        )
        .route(
            "/api/v1/public/config",
            get(crate::login_http::public_config),
        )
        .route("/api/v1/dev/login", any(not_found))
        .route("/api", any(not_found))
        .route("/api/{*path}", any(not_found));
    if state.expose_openapi {
        app = app.route("/api/openapi.json", get(|| async { Json(openapi()) }));
    }
    let static_files = ServeDir::new(&state.web_dir)
        .not_found_service(ServeFile::new(state.web_dir.join("index.html")));
    app.fallback_service(static_files).layer(middleware::from_fn(crate::login_http::private_response)).layer(TraceLayer::new_for_http().make_span_with(|request: &axum::http::Request<_>| tracing::info_span!("http_request", method=%request.method(), path=request.uri().path()))).with_state(state)
}

struct CookieSecurity;
impl utoipa::Modify for CookieSecurity {
    fn modify(&self, openapi: &mut utoipa::openapi::OpenApi) {
        use utoipa::openapi::security::{ApiKey, ApiKeyValue, SecurityScheme};
        if let Some(components) = openapi.components.as_mut() {
            components.add_security_scheme(
                "session",
                SecurityScheme::ApiKey(ApiKey::Cookie(ApiKeyValue::new("__Host-sid"))),
            );
            components.add_security_scheme(
                "csrf",
                SecurityScheme::ApiKey(ApiKey::Header(ApiKeyValue::new("X-CSRF-Token"))),
            );
        }
    }
}
