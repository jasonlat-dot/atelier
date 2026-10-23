use crate::{auth_http::AuthUser, AppState};
use atelier_common::{ApiError, ErrorResponse};
use atelier_generation::*;
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
fn invalid() -> ApiError {
    GenerationError::Validation.into()
}
pub(crate) fn service(state: &AppState) -> Result<&GenerationService, ApiError> {
    state
        .generation
        .as_ref()
        .ok_or_else(|| GenerationError::Store.into())
}
async fn rate(state: &AppState, owner: Uuid, kind: &str) -> Result<(), ApiError> {
    use atelier_auth::transient::{RateDecision, GENERATION_RATE};
    let store = state
        .limits
        .as_ref()
        .ok_or_else(|| ApiError::from(GenerationError::Store))?;
    match store
        .rate_limit(format!("generation:{kind}:{owner}"), GENERATION_RATE)
        .await
    {
        Ok(RateDecision::Allowed) => Ok(()),
        Ok(RateDecision::Limited { .. }) => Err(ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "TOO_MANY_REQUESTS",
            "Please retry later",
        )),
        Err(_) => Err(GenerationError::Store.into()),
    }
}
fn idempotency(headers: &HeaderMap) -> Result<Uuid, ApiError> {
    let mut values = headers.get_all("Idempotency-Key").iter();
    let key = values
        .next()
        .and_then(|v| v.to_str().ok())
        .and_then(|v| Uuid::parse_str(v).ok())
        .filter(|v| !v.is_nil())
        .ok_or_else(invalid)?;
    if values.next().is_some() {
        return Err(invalid());
    }
    Ok(key)
}
#[utoipa::path(post,path="/api/v1/generation/quote",request_body=QuoteInput,security(("session"=[],"csrf"=[])),responses((status=200,body=Quote),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=422,body=ErrorResponse),(status=429,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn quote(
    State(s): State<AppState>,
    AuthUser(actor): AuthUser,
    body: Result<Json<QuoteInput>, JsonRejection>,
) -> Result<Json<Quote>, ApiError> {
    let Json(input) = body.map_err(|_| invalid())?;
    rate(&s, actor.user().id, "quote").await?;
    Ok(Json(service(&s)?.quote(actor.user().id, &input).await?))
}
#[utoipa::path(post,path="/api/v1/generation/jobs",request_body=JobInput,params(("Idempotency-Key"=Uuid,Header)),security(("session"=[],"csrf"=[])),responses((status=202,body=JobReceipt),(status=401,body=ErrorResponse),(status=402,body=ErrorResponse),(status=403,body=ErrorResponse),(status=422,body=ErrorResponse),(status=429,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn create(
    State(s): State<AppState>,
    AuthUser(actor): AuthUser,
    headers: HeaderMap,
    body: Result<Json<JobInput>, JsonRejection>,
) -> Result<(StatusCode, Json<JobReceipt>), ApiError> {
    let key = idempotency(&headers)?;
    let Json(input) = body.map_err(|_| invalid())?;
    rate(&s, actor.user().id, "create").await?;
    Ok((
        StatusCode::ACCEPTED,
        Json(service(&s)?.create(actor.user().id, key, input).await?),
    ))
}
#[derive(Deserialize, utoipa::IntoParams)]
#[serde(deny_unknown_fields)]
pub struct JobsQuery {
    pub before: Option<Uuid>,
    pub status: Option<String>,
    pub limit: Option<i64>,
}
#[utoipa::path(get,path="/api/v1/generation/jobs",params(JobsQuery),security(("session"=[])),responses((status=200,body=JobPage),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=422,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn list(
    State(s): State<AppState>,
    AuthUser(actor): AuthUser,
    query: Result<Query<JobsQuery>, QueryRejection>,
) -> Result<Json<JobPage>, ApiError> {
    let Query(q) = query.map_err(|_| invalid())?;
    Ok(Json(
        service(&s)?
            .list(actor.user().id, q.before, q.status, q.limit.unwrap_or(25))
            .await?,
    ))
}
#[utoipa::path(get,path="/api/v1/generation/jobs/{id}",params(("id"=Uuid,Path)),security(("session"=[])),responses((status=200,body=JobReceipt),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=404,body=ErrorResponse),(status=422,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn get_one(
    State(s): State<AppState>,
    AuthUser(actor): AuthUser,
    path: Result<Path<Uuid>, PathRejection>,
) -> Result<Json<JobReceipt>, ApiError> {
    let Path(id) = path.map_err(|_| invalid())?;
    Ok(Json(JobReceipt {
        job: service(&s)?.get(actor.user().id, id).await?,
    }))
}
#[utoipa::path(post,path="/api/v1/generation/jobs/{id}/cancel",params(("id"=Uuid,Path)),security(("session"=[],"csrf"=[])),responses((status=200,body=JobReceipt),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=404,body=ErrorResponse),(status=422,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn cancel(
    State(s): State<AppState>,
    AuthUser(actor): AuthUser,
    path: Result<Path<Uuid>, PathRejection>,
) -> Result<Json<JobReceipt>, ApiError> {
    let Path(id) = path.map_err(|_| invalid())?;
    Ok(Json(service(&s)?.cancel(actor.user().id, id).await?))
}
