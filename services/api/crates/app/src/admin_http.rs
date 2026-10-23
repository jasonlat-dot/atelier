use crate::{
    auth_http::{AuthUser, RequireRole},
    AppState,
};
use atelier_admin::*;
use atelier_common::{ApiError, ErrorResponse};
use axum::{
    extract::{
        rejection::{JsonRejection, PathRejection, QueryRejection},
        Path, Query, State,
    },
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::Deserialize;
use uuid::Uuid;
fn service(s: &AppState) -> AdminService {
    AdminService::new(s.db.clone())
}
fn invalid() -> ApiError {
    AdminError::Validation.into()
}
fn path<T>(p: Result<Path<T>, PathRejection>) -> Result<T, ApiError> {
    p.map(|Path(v)| v).map_err(|_| invalid())
}
fn body<T>(b: Result<Json<T>, JsonRejection>) -> Result<T, ApiError> {
    b.map(|Json(v)| v).map_err(|_| invalid())
}
fn query<T>(q: Result<Query<T>, QueryRejection>) -> Result<T, ApiError> {
    q.map(|Query(v)| v).map_err(|_| invalid())
}
fn key(h: &HeaderMap) -> Result<Uuid, ApiError> {
    let mut values = h.get_all("Idempotency-Key").iter();
    let key = values
        .next()
        .and_then(|h| h.to_str().ok())
        .and_then(|v| Uuid::parse_str(v).ok())
        .filter(|v| !v.is_nil())
        .ok_or_else(invalid)?;
    if values.next().is_some() {
        return Err(invalid());
    }
    Ok(key)
}
fn week() -> i32 {
    7
}
#[derive(Deserialize, utoipa::IntoParams)]
#[serde(deny_unknown_fields)]
pub struct DaysQuery {
    #[serde(default = "week")]
    pub days: i32,
}
#[derive(Deserialize, utoipa::IntoParams)]
#[serde(deny_unknown_fields)]
pub struct UsersQuery {
    #[serde(default)]
    pub q: String,
    pub status: Option<String>,
    pub role: Option<String>,
    pub before: Option<Uuid>,
}
#[derive(Deserialize, utoipa::IntoParams)]
#[serde(deny_unknown_fields)]
pub struct JobsQuery {
    #[serde(default)]
    pub q: String,
    pub status: Option<String>,
    pub user_id: Option<Uuid>,
    pub before: Option<Uuid>,
}
#[derive(Deserialize, utoipa::IntoParams)]
#[serde(deny_unknown_fields)]
pub struct ListQuery {
    #[serde(default)]
    pub q: String,
    pub before: Option<i64>,
}
#[derive(Deserialize, utoipa::IntoParams)]
#[serde(deny_unknown_fields)]
pub struct InviteQuery {
    #[serde(default)]
    pub q: String,
    pub before: Option<Uuid>,
}
#[derive(Deserialize, utoipa::IntoParams)]
#[serde(deny_unknown_fields)]
pub struct LedgerQuery {
    pub before: Option<i64>,
}

#[utoipa::path(get,path="/api/v1/admin/dashboard",params(DaysQuery),security(("session"=[])),responses((status=200,body=AdminDashboard),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=422,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn dashboard(
    State(s): State<AppState>,
    _: RequireRole<false>,
    q: Result<Query<DaysQuery>, QueryRejection>,
) -> Result<Json<AdminDashboard>, ApiError> {
    Ok(Json(service(&s).dashboard(query(q)?.days).await?))
}
#[utoipa::path(get,path="/api/v1/usage",params(DaysQuery),security(("session"=[])),responses((status=200,body=UsageView),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=422,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn usage(
    State(s): State<AppState>,
    AuthUser(a): AuthUser,
    q: Result<Query<DaysQuery>, QueryRejection>,
) -> Result<Json<UsageView>, ApiError> {
    Ok(Json(service(&s).usage(a.user().id, query(q)?.days).await?))
}
#[utoipa::path(get,path="/api/v1/admin/users",params(UsersQuery),security(("session"=[])),responses((status=200,body=AdminUserPage),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=422,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn users(
    State(s): State<AppState>,
    _: RequireRole<false>,
    q: Result<Query<UsersQuery>, QueryRejection>,
) -> Result<Json<AdminUserPage>, ApiError> {
    let q = query(q)?;
    Ok(Json(
        service(&s)
            .users(&q.q, q.status.as_deref(), q.role.as_deref(), q.before)
            .await?,
    ))
}
#[utoipa::path(get,path="/api/v1/admin/users/{id}",params(("id"=Uuid,Path)),security(("session"=[])),responses((status=200,body=AdminUserDetail),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=404,body=ErrorResponse),(status=422,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn user_detail(
    State(s): State<AppState>,
    _: RequireRole<false>,
    id: Result<Path<Uuid>, PathRejection>,
) -> Result<Json<AdminUserDetail>, ApiError> {
    Ok(Json(service(&s).user_detail(path(id)?).await?))
}
#[utoipa::path(get,path="/api/v1/admin/users/{id}/ledger",params(("id"=Uuid,Path),LedgerQuery),security(("session"=[])),responses((status=200,body=atelier_wallet::LedgerPage),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=404,body=ErrorResponse),(status=422,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn user_ledger(
    State(s): State<AppState>,
    _: RequireRole<false>,
    id: Result<Path<Uuid>, PathRejection>,
    q: Result<Query<LedgerQuery>, QueryRejection>,
) -> Result<Json<atelier_wallet::LedgerPage>, ApiError> {
    Ok(Json(
        service(&s).user_ledger(path(id)?, query(q)?.before).await?,
    ))
}
#[utoipa::path(post,path="/api/v1/admin/users/{id}/{action}",params(("id"=Uuid,Path),("action"=String,Path,description="disable, enable, role, revoke-sessions, review")),request_body=AdminUserAction,security(("session"=[],"csrf"=[])),responses((status=200,body=AdminUser),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=404,body=ErrorResponse),(status=409,body=ErrorResponse),(status=422,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn user_action(
    State(s): State<AppState>,
    RequireRole(a): RequireRole<false>,
    p: Result<Path<(Uuid, String)>, PathRejection>,
    b: Result<Json<AdminUserAction>, JsonRejection>,
) -> Result<Json<AdminUser>, ApiError> {
    let (id, action) = path(p)?;
    Ok(Json(
        service(&s)
            .user_action(a.user().id, id, &action, &body(b)?)
            .await?,
    ))
}
#[utoipa::path(get,path="/api/v1/admin/jobs",params(JobsQuery),security(("session"=[])),responses((status=200,body=AdminJobPage),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=422,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn jobs(
    State(s): State<AppState>,
    _: RequireRole<false>,
    q: Result<Query<JobsQuery>, QueryRejection>,
) -> Result<Json<AdminJobPage>, ApiError> {
    let q = query(q)?;
    Ok(Json(
        service(&s)
            .jobs(&q.q, q.status.as_deref(), q.user_id, q.before)
            .await?,
    ))
}
#[utoipa::path(post,path="/api/v1/admin/jobs/{id}/{action}",params(("id"=Uuid,Path),("action"=String,Path,description="cancel or refund"),("Idempotency-Key"=Uuid,Header)),request_body=AdminJobAction,security(("session"=[],"csrf"=[])),responses((status=200,body=AdminJob),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=404,body=ErrorResponse),(status=409,body=ErrorResponse),(status=422,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn job_action(
    State(s): State<AppState>,
    RequireRole(a): RequireRole<false>,
    p: Result<Path<(Uuid, String)>, PathRejection>,
    h: HeaderMap,
    b: Result<Json<AdminJobAction>, JsonRejection>,
) -> Result<Json<AdminJob>, ApiError> {
    let (id, action) = path(p)?;
    Ok(Json(
        service(&s)
            .job_action(a.user().id, id, key(&h)?, &action, &body(b)?)
            .await?,
    ))
}
#[utoipa::path(get,path="/api/v1/admin/settings",security(("session"=[])),responses((status=200,body=AdminSettings),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn settings(
    State(s): State<AppState>,
    _: RequireRole<true>,
) -> Result<Json<AdminSettings>, ApiError> {
    Ok(Json(service(&s).settings().await?))
}
#[utoipa::path(put,path="/api/v1/admin/settings",request_body=AdminSettingsUpdate,security(("session"=[],"csrf"=[])),responses((status=200,body=AdminSettings),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=409,body=ErrorResponse),(status=422,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn save_settings(
    State(s): State<AppState>,
    RequireRole(a): RequireRole<true>,
    b: Result<Json<AdminSettingsUpdate>, JsonRejection>,
) -> Result<Json<AdminSettings>, ApiError> {
    Ok(Json(
        service(&s).save_settings(a.user().id, &body(b)?).await?,
    ))
}
#[utoipa::path(get,path="/api/v1/admin/moderation-rules",params(ListQuery),security(("session"=[])),responses((status=200,body=AdminRulePage),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=422,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn rules(
    State(s): State<AppState>,
    _: RequireRole<false>,
    q: Result<Query<ListQuery>, QueryRejection>,
) -> Result<Json<AdminRulePage>, ApiError> {
    let q = query(q)?;
    Ok(Json(service(&s).rules(&q.q, q.before).await?))
}
#[utoipa::path(post,path="/api/v1/admin/moderation-rules",request_body=AdminRuleInput,security(("session"=[],"csrf"=[])),responses((status=200,body=AdminRule),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=409,body=ErrorResponse),(status=422,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn create_rule(
    State(s): State<AppState>,
    RequireRole(a): RequireRole<false>,
    b: Result<Json<AdminRuleInput>, JsonRejection>,
) -> Result<Json<AdminRule>, ApiError> {
    Ok(Json(
        service(&s).save_rule(a.user().id, None, &body(b)?).await?,
    ))
}
#[utoipa::path(patch,path="/api/v1/admin/moderation-rules/{id}",params(("id"=i64,Path)),request_body=AdminRuleInput,security(("session"=[],"csrf"=[])),responses((status=200,body=AdminRule),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=404,body=ErrorResponse),(status=409,body=ErrorResponse),(status=422,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn update_rule(
    State(s): State<AppState>,
    RequireRole(a): RequireRole<false>,
    p: Result<Path<i64>, PathRejection>,
    b: Result<Json<AdminRuleInput>, JsonRejection>,
) -> Result<Json<AdminRule>, ApiError> {
    Ok(Json(
        service(&s)
            .save_rule(a.user().id, Some(path(p)?), &body(b)?)
            .await?,
    ))
}
#[utoipa::path(delete,path="/api/v1/admin/moderation-rules/{id}",params(("id"=i64,Path)),request_body=AdminRevisionReason,security(("session"=[],"csrf"=[])),responses((status=204),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=404,body=ErrorResponse),(status=409,body=ErrorResponse),(status=422,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn delete_rule(
    State(s): State<AppState>,
    RequireRole(a): RequireRole<false>,
    p: Result<Path<i64>, PathRejection>,
    b: Result<Json<AdminRevisionReason>, JsonRejection>,
) -> Result<StatusCode, ApiError> {
    service(&s)
        .delete_rule(a.user().id, path(p)?, &body(b)?)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}
#[utoipa::path(get,path="/api/v1/admin/invite-codes",params(InviteQuery),security(("session"=[])),responses((status=200,body=AdminInvitePage),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=422,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn invites(
    State(s): State<AppState>,
    _: RequireRole<false>,
    q: Result<Query<InviteQuery>, QueryRejection>,
) -> Result<Json<AdminInvitePage>, ApiError> {
    let q = query(q)?;
    Ok(Json(service(&s).invites(&q.q, q.before).await?))
}
#[utoipa::path(post,path="/api/v1/admin/invite-codes",request_body=AdminInviteInput,security(("session"=[],"csrf"=[])),responses((status=200,body=AdminInviteCreated),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=422,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn create_invite(
    State(s): State<AppState>,
    RequireRole(a): RequireRole<false>,
    b: Result<Json<AdminInviteInput>, JsonRejection>,
) -> Result<Json<AdminInviteCreated>, ApiError> {
    Ok(Json(
        service(&s).create_invite(a.user().id, &body(b)?).await?,
    ))
}
#[utoipa::path(patch,path="/api/v1/admin/invite-codes/{id}",params(("id"=Uuid,Path)),request_body=AdminInviteUpdate,security(("session"=[],"csrf"=[])),responses((status=200,body=AdminInvite),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=404,body=ErrorResponse),(status=409,body=ErrorResponse),(status=422,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn update_invite(
    State(s): State<AppState>,
    RequireRole(a): RequireRole<false>,
    p: Result<Path<Uuid>, PathRejection>,
    b: Result<Json<AdminInviteUpdate>, JsonRejection>,
) -> Result<Json<AdminInvite>, ApiError> {
    Ok(Json(
        service(&s)
            .update_invite(a.user().id, path(p)?, &body(b)?)
            .await?,
    ))
}
#[utoipa::path(delete,path="/api/v1/admin/invite-codes/{id}",params(("id"=Uuid,Path)),request_body=AdminRevisionReason,security(("session"=[],"csrf"=[])),responses((status=200,body=AdminInvite),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=404,body=ErrorResponse),(status=409,body=ErrorResponse),(status=422,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn revoke_invite(
    State(s): State<AppState>,
    RequireRole(a): RequireRole<false>,
    p: Result<Path<Uuid>, PathRejection>,
    b: Result<Json<AdminRevisionReason>, JsonRejection>,
) -> Result<Json<AdminInvite>, ApiError> {
    Ok(Json(
        service(&s)
            .revoke_invite(a.user().id, path(p)?, &body(b)?)
            .await?,
    ))
}
#[utoipa::path(get,path="/api/v1/admin/audit",params(ListQuery),security(("session"=[])),responses((status=200,body=AdminAuditPage),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=422,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn audit_logs(
    State(s): State<AppState>,
    _: RequireRole<true>,
    q: Result<Query<ListQuery>, QueryRejection>,
) -> Result<Json<AdminAuditPage>, ApiError> {
    let q = query(q)?;
    Ok(Json(service(&s).audit_logs(&q.q, q.before).await?))
}
