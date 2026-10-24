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
    paths(crate::admin_http::dashboard,crate::admin_http::usage,crate::admin_http::users,crate::admin_http::user_detail,crate::admin_http::user_ledger,crate::admin_http::user_action,crate::admin_http::jobs,crate::admin_http::job_action,crate::admin_http::settings,crate::admin_http::save_settings,crate::admin_http::rules,crate::admin_http::create_rule,crate::admin_http::update_rule,crate::admin_http::delete_rule,crate::admin_http::invites,crate::admin_http::create_invite,crate::admin_http::update_invite,crate::admin_http::revoke_invite,crate::admin_http::audit_logs,crate::billing_http::plans,crate::billing_http::subscription,crate::billing_http::create_order,crate::billing_http::orders,crate::billing_http::order,crate::billing_http::cancel,crate::billing_http::admin_plans,crate::billing_http::create_plan,crate::billing_http::update_plan,crate::billing_http::admin_orders,crate::billing_http::paid,crate::billing_http::refund_quote,crate::billing_http::refund,crate::chat_http::config,crate::chat_http::list,crate::chat_http::create,crate::chat_http::get_one,crate::chat_http::rename,crate::chat_http::delete_one,crate::chat_http::cancel,crate::chat_http::send,crate::canvas_http::export,crate::canvas_http::import,crate::canvas_http::list,crate::canvas_http::create,crate::canvas_http::get_one,crate::canvas_http::save,crate::canvas_http::rename,crate::canvas_http::delete_one,crate::canvas_http::duplicate,crate::canvas_http::snapshots,crate::canvas_http::restore,crate::canvas_http::references,crate::generation_http::events,crate::generation_http::limits,crate::generation_http::quote,crate::generation_http::create,crate::generation_http::list,crate::generation_http::get_one,crate::generation_http::delete_history,crate::generation_http::cancel,crate::upstream_http::accounts,crate::upstream_http::account,crate::upstream_http::create_account,crate::upstream_http::update_account,crate::upstream_http::delete_account,crate::upstream_http::import_accounts,crate::upstream_http::probe,crate::upstream_http::refresh_quota,crate::upstream_http::stats,crate::upstream_http::models,crate::upstream_http::create_model,crate::upstream_http::update_model,crate::upstream_http::bindings,crate::upstream_http::pricing,crate::upstream_http::save_pricing,crate::upstream_http::catalog,crate::assets_http::list,crate::assets_http::get_one,crate::assets_http::limits,crate::assets_http::upload,crate::assets_http::delete_one,crate::assets_http::delete_many,crate::assets_http::media,crate::wallet_http::summary,crate::wallet_http::ledger,crate::wallet_http::checkin,crate::wallet_http::redeem,crate::wallet_http::adjust,crate::wallet_http::create_codes,crate::wallet_http::codes,crate::wallet_http::copy_code,crate::wallet_http::adjustments,health, me, rename, logout, devices, revoke_device,crate::login_http::google_start,crate::login_http::google_callback,crate::login_http::public_config,crate::login_http::mfa_setup,crate::login_http::mfa_verify),
    modifiers(&CookieSecurity),
    components(schemas(atelier_admin::AdminUser,atelier_admin::AdminUserPage,atelier_admin::AdminUserDetail,atelier_admin::AdminSession,atelier_admin::AdminUserAction,atelier_admin::AdminJob,atelier_admin::AdminJobPage,atelier_admin::AdminJobAction,atelier_admin::AdminCostRate,atelier_admin::AdminSettingsValues,atelier_admin::AdminCostModel,atelier_admin::AdminSettings,atelier_admin::AdminSettingsUpdate,atelier_admin::AdminRule,atelier_admin::AdminRuleInput,atelier_admin::AdminRevisionReason,atelier_admin::AdminRulePage,atelier_admin::AdminInvite,atelier_admin::AdminInviteInput,atelier_admin::AdminInviteUpdate,atelier_admin::AdminInviteCreated,atelier_admin::AdminInvitePage,atelier_admin::AdminAudit,atelier_admin::AdminAuditPage,atelier_admin::AdminDay,atelier_admin::AdminQuality,atelier_admin::AdminHealth,atelier_admin::AdminNotification,atelier_admin::AdminEstimate,atelier_admin::AdminOrderAmount,atelier_admin::AdminDashboard,atelier_admin::UsageView,atelier_wallet::PlanInput,atelier_wallet::PlanView,atelier_wallet::OrderInput,atelier_wallet::OrderView,atelier_wallet::OrderPage,atelier_wallet::PaidInput,atelier_wallet::RefundInput,atelier_wallet::RefundQuote,atelier_wallet::Entitlements,crate::billing_http::PlanUpdate,crate::billing_http::Checkout,
atelier_chat::ConversationInput,atelier_chat::Conversation,atelier_chat::ConversationPage,atelier_chat::ConversationView,atelier_chat::SendMessage,atelier_chat::ChatTurn,atelier_chat::CanvasAction,atelier_chat::CanvasDraft,atelier_chat::ChatConfig,atelier_chat::ChatModel,atelier_chat::ChatEvent,atelier_chat::ChatDelta,atelier_chat::ChatFailure,atelier_agent_core::Intent,
atelier_canvas::ProjectInfo,atelier_canvas::ProjectPage,atelier_canvas::ProjectView,atelier_canvas::CreateProject,atelier_canvas::RenameProject,atelier_canvas::ProjectSnapshot,atelier_canvas::ProjectReference,atelier_canvas::CanvasGraph,atelier_canvas::CanvasNode,atelier_canvas::NodeContent,atelier_canvas::CanvasEdge,atelier_canvas::Point,atelier_canvas::NodeSize,atelier_canvas::Viewport,atelier_canvas::Background,atelier_canvas::EdgeRole,atelier_canvas::TextData,atelier_canvas::ImageData,atelier_canvas::VideoData,atelier_canvas::GenerateData,atelier_canvas::GenMeta,
        atelier_generation::GenerationEvent,atelier_generation::EventOutput,atelier_generation::GenerationLimits,atelier_generation::JobInput,atelier_generation::QuoteInput,atelier_generation::Quote,atelier_generation::JobView,atelier_generation::JobParams,atelier_generation::Reference,atelier_generation::JobOutput,atelier_generation::JobReceipt,atelier_generation::JobPage,atelier_generation::JobEvent,
        atelier_upstream::AccountInput,atelier_upstream::AccountPage,atelier_upstream::AccountView,atelier_upstream::ModelInput,atelier_upstream::ModelView,atelier_upstream::BindingInput,atelier_upstream::QuotaInput,atelier_upstream::Pricing,atelier_upstream::Capabilities,atelier_upstream::PriceRule,atelier_upstream::SizeMultiplier,atelier_upstream::ProbeResult,atelier_upstream::FailureCode,atelier_upstream::AccountStats,atelier_upstream::ErrorCount,atelier_upstream::Catalog,atelier_upstream::CatalogModel,
        atelier_wallet::WalletSummary, atelier_wallet::LedgerPage, atelier_wallet::LedgerEntry, atelier_wallet::CheckinReceipt, atelier_wallet::CreditReceipt, atelier_wallet::RedeemRequest, atelier_wallet::AdjustRequest, atelier_wallet::CreateCodesRequest, atelier_wallet::CreatedCodes, atelier_wallet::CreatedCode, atelier_wallet::CodeInfo, atelier_wallet::CreditAdjustment,
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
            "/api/v1/admin/dashboard",
            get(crate::admin_http::dashboard)
                .layer(axum::extract::DefaultBodyLimit::max(131072))
                .fallback(admin_missing),
        )
        .route(
            "/api/v1/usage",
            get(crate::admin_http::usage)
                .layer(axum::extract::DefaultBodyLimit::max(131072))
                .fallback(protected_missing),
        )
        .route(
            "/api/v1/me/usage",
            get(crate::admin_http::usage).fallback(protected_missing),
        )
        .route(
            "/api/v1/admin/users",
            get(crate::admin_http::users)
                .layer(axum::extract::DefaultBodyLimit::max(131072))
                .fallback(admin_missing),
        )
        .route(
            "/api/v1/admin/users/{id}",
            get(crate::admin_http::user_detail)
                .layer(axum::extract::DefaultBodyLimit::max(131072))
                .fallback(admin_missing),
        )
        .route(
            "/api/v1/admin/users/{id}/ledger",
            get(crate::admin_http::user_ledger)
                .layer(axum::extract::DefaultBodyLimit::max(131072))
                .fallback(admin_missing),
        )
        .route(
            "/api/v1/admin/users/{id}/{action}",
            post(crate::admin_http::user_action)
                .layer(axum::extract::DefaultBodyLimit::max(131072))
                .fallback(admin_missing),
        )
        .route(
            "/api/v1/admin/jobs",
            get(crate::admin_http::jobs)
                .layer(axum::extract::DefaultBodyLimit::max(131072))
                .fallback(admin_missing),
        )
        .route(
            "/api/v1/admin/jobs/{id}/{action}",
            post(crate::admin_http::job_action)
                .layer(axum::extract::DefaultBodyLimit::max(131072))
                .fallback(admin_missing),
        )
        .route(
            "/api/v1/admin/moderation-rules",
            get(crate::admin_http::rules)
                .post(crate::admin_http::create_rule)
                .layer(axum::extract::DefaultBodyLimit::max(131072))
                .fallback(admin_missing),
        )
        .route(
            "/api/v1/admin/moderation-rules/{id}",
            axum::routing::patch(crate::admin_http::update_rule)
                .delete(crate::admin_http::delete_rule)
                .layer(axum::extract::DefaultBodyLimit::max(131072))
                .fallback(admin_missing),
        )
        .route(
            "/api/v1/admin/invite-codes",
            get(crate::admin_http::invites)
                .post(crate::admin_http::create_invite)
                .layer(axum::extract::DefaultBodyLimit::max(131072))
                .fallback(admin_missing),
        )
        .route(
            "/api/v1/admin/invite-codes/{id}",
            axum::routing::patch(crate::admin_http::update_invite)
                .delete(crate::admin_http::revoke_invite)
                .layer(axum::extract::DefaultBodyLimit::max(131072))
                .fallback(admin_missing),
        )
        .route(
            "/api/v1/plans",
            get(crate::billing_http::plans)
                .layer(axum::extract::DefaultBodyLimit::max(16384))
                .fallback(protected_missing),
        )
        .route(
            "/api/v1/subscription",
            get(crate::billing_http::subscription)
                .layer(axum::extract::DefaultBodyLimit::max(16384))
                .fallback(protected_missing),
        )
        .route(
            "/api/v1/orders",
            get(crate::billing_http::orders)
                .post(crate::billing_http::create_order)
                .layer(axum::extract::DefaultBodyLimit::max(16384))
                .fallback(protected_missing),
        )
        .route(
            "/api/v1/orders/{id}",
            get(crate::billing_http::order)
                .layer(axum::extract::DefaultBodyLimit::max(16384))
                .fallback(protected_missing),
        )
        .route(
            "/api/v1/orders/{id}/cancel",
            post(crate::billing_http::cancel)
                .layer(axum::extract::DefaultBodyLimit::max(16384))
                .fallback(protected_missing),
        )
        .route(
            "/api/v1/admin/plans",
            get(crate::billing_http::admin_plans)
                .post(crate::billing_http::create_plan)
                .layer(axum::extract::DefaultBodyLimit::max(16384))
                .fallback(admin_missing),
        )
        .route(
            "/api/v1/admin/plans/{id}",
            axum::routing::patch(crate::billing_http::update_plan)
                .layer(axum::extract::DefaultBodyLimit::max(16384))
                .fallback(admin_missing),
        )
        .route(
            "/api/v1/admin/orders",
            get(crate::billing_http::admin_orders)
                .layer(axum::extract::DefaultBodyLimit::max(16384))
                .fallback(admin_missing),
        )
        .route(
            "/api/v1/admin/orders/{id}/mark-paid",
            post(crate::billing_http::paid)
                .layer(axum::extract::DefaultBodyLimit::max(16384))
                .fallback(admin_missing),
        )
        .route(
            "/api/v1/admin/orders/{id}/refund-quote",
            get(crate::billing_http::refund_quote)
                .layer(axum::extract::DefaultBodyLimit::max(16384))
                .fallback(admin_missing),
        )
        .route(
            "/api/v1/admin/orders/{id}/refund",
            post(crate::billing_http::refund)
                .layer(axum::extract::DefaultBodyLimit::max(16384))
                .fallback(admin_missing),
        )
        .route(
            "/api/v1/chat/config",
            get(crate::chat_http::config).fallback(protected_missing),
        )
        .route(
            "/api/v1/chat/conversations",
            get(crate::chat_http::list)
                .post(crate::chat_http::create)
                .layer(axum::extract::DefaultBodyLimit::max(1024))
                .fallback(protected_missing),
        )
        .route(
            "/api/v1/chat/conversations/{id}",
            get(crate::chat_http::get_one)
                .patch(crate::chat_http::rename)
                .delete(crate::chat_http::delete_one)
                .layer(axum::extract::DefaultBodyLimit::max(1024))
                .fallback(protected_missing),
        )
        .route(
            "/api/v1/chat/conversations/{id}/messages",
            post(crate::chat_http::send)
                .layer(axum::extract::DefaultBodyLimit::max(32768))
                .fallback(protected_missing),
        )
        .route(
            "/api/v1/chat/turns/{id}/cancel",
            post(crate::chat_http::cancel).fallback(protected_missing),
        )
        .route(
            "/api/v1/projects/import",
            post(crate::canvas_http::import)
                .layer(axum::extract::DefaultBodyLimit::disable())
                .fallback(protected_missing),
        )
        .route(
            "/api/v1/projects/{id}/export",
            get(crate::canvas_http::export).fallback(protected_missing),
        )
        .route(
            "/api/v1/projects",
            get(crate::canvas_http::list)
                .post(crate::canvas_http::create)
                .layer(axum::extract::DefaultBodyLimit::max(
                    atelier_canvas::MAX_GRAPH_BYTES + 1024,
                ))
                .fallback(protected_missing),
        )
        .route(
            "/api/v1/projects/{id}",
            get(crate::canvas_http::get_one)
                .patch(crate::canvas_http::rename)
                .delete(crate::canvas_http::delete_one)
                .fallback(protected_missing),
        )
        .route(
            "/api/v1/projects/{id}/graph",
            axum::routing::put(crate::canvas_http::save)
                .layer(axum::extract::DefaultBodyLimit::max(
                    atelier_canvas::MAX_GRAPH_BYTES,
                ))
                .fallback(protected_missing),
        )
        .route(
            "/api/v1/projects/{id}/duplicate",
            post(crate::canvas_http::duplicate).fallback(protected_missing),
        )
        .route(
            "/api/v1/projects/{id}/snapshots",
            get(crate::canvas_http::snapshots).fallback(protected_missing),
        )
        .route(
            "/api/v1/projects/{id}/snapshots/{snapshot}/restore",
            post(crate::canvas_http::restore).fallback(protected_missing),
        )
        .route(
            "/api/v1/assets/{id}/projects",
            get(crate::canvas_http::references).fallback(protected_missing),
        )
        .route(
            "/api/v1/events",
            get(crate::generation_http::events).fallback(protected_missing),
        )
        .route(
            "/api/v1/generation/limits",
            get(crate::generation_http::limits).fallback(protected_missing),
        )
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
            "/api/v1/generation/jobs/{id}/history",
            delete(crate::generation_http::delete_history).fallback(protected_missing),
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
            "/api/v1/admin/redeem-codes/{id}/copy",
            post(crate::wallet_http::copy_code).fallback(admin_missing),
        )
        .route(
            "/api/v1/admin/credits/adjustments",
            get(crate::wallet_http::adjustments).fallback(admin_missing),
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
        .route(
            "/api/v1/admin/settings",
            get(crate::admin_http::settings)
                .put(crate::admin_http::save_settings)
                .layer(axum::extract::DefaultBodyLimit::max(131072))
                .fallback(super_admin_missing),
        )
        .route(
            "/api/v1/admin/audit",
            get(crate::admin_http::audit_logs).fallback(super_admin_missing),
        )
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
