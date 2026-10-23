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
    pub project_id: Option<Uuid>,
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
            .list_project(
                actor.user().id,
                q.before,
                q.status,
                q.limit.unwrap_or(25),
                q.project_id,
            )
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

#[utoipa::path(get,path="/api/v1/generation/limits",security(("session"=[])),responses((status=200,body=GenerationLimits),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn limits(
    State(s): State<AppState>,
    _actor: AuthUser,
) -> Result<Json<GenerationLimits>, ApiError> {
    Ok(Json(service(&s)?.limits().await?))
}

#[derive(Deserialize, utoipa::IntoParams)]
#[serde(deny_unknown_fields)]
pub struct EventsQuery {
    pub after: Option<i64>,
}
struct EventState {
    service: GenerationService,
    app: AppState,
    headers: HeaderMap,
    owner: Uuid,
    cursor: i64,
    pending: std::collections::VecDeque<JobEvent>,
    permit: EventPermit,
}
#[utoipa::path(get,path="/api/v1/events",params(EventsQuery,("Last-Event-ID"=i64,Header)),security(("session"=[])),responses((status=200,body=GenerationEvent,content_type="text/event-stream",description="job.updated events; PostgreSQL seq as event id, owner-scoped replay"),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=422,body=ErrorResponse),(status=429,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn events(
    State(s): State<AppState>,
    AuthUser(actor): AuthUser,
    headers: HeaderMap,
    query: Result<Query<EventsQuery>, QueryRejection>,
) -> Result<axum::response::Response, ApiError> {
    use axum::response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse,
    };
    let Query(q) = query.map_err(|_| invalid())?;
    let mut values = headers.get_all("Last-Event-ID").iter();
    let requested = match values.next() {
        Some(v) => v
            .to_str()
            .ok()
            .and_then(|s| s.parse::<i64>().ok())
            .ok_or_else(invalid)?,
        None => q.after.unwrap_or(0),
    };
    if values.next().is_some() || requested < 0 {
        return Err(invalid());
    }
    let service = service(&s)?.clone();
    let cursor = service.event_cursor(actor.user().id, requested).await?;
    let permit = service.open_events(actor.user().id).await?;
    let stream = futures_util::stream::unfold(
        EventState {
            service,
            app: s,
            headers,
            owner: actor.user().id,
            cursor,
            pending: std::collections::VecDeque::new(),
            permit,
        },
        |mut state| async move {
            loop {
                if !state.permit.valid() {
                    return None;
                }
                let actor = state
                    .app
                    .auth
                    .authenticate("GET", &state.headers)
                    .await
                    .ok()?;
                if actor.user().id != state.owner {
                    return None;
                }
                if actor.user().role != atelier_auth::policy::Role::User
                    && actor
                        .require_admin(atelier_auth::policy::Role::Admin)
                        .is_err()
                {
                    return None;
                }
                if let Some(mut item) = state.pending.pop_front() {
                    if let Some(outputs) = item
                        .payload
                        .get_mut("outputs")
                        .and_then(|v| v.as_array_mut())
                    {
                        for output in outputs {
                            if let Some(id) = output["asset_id"]
                                .as_str()
                                .and_then(|s| Uuid::parse_str(s).ok())
                            {
                                match state.app.assets.as_ref()?.get(state.owner, id).await {
                                    Ok(asset) => {
                                        output["url"] = serde_json::json!(asset.media_url);
                                        output["width"] = serde_json::json!(asset.width);
                                        output["height"] = serde_json::json!(asset.height);
                                    }
                                    Err(atelier_assets::AssetError::NotFound) => {
                                        output["url"] = serde_json::Value::Null;
                                    }
                                    Err(_) => return None,
                                }
                            }
                        }
                    }
                    state.cursor = item.seq;
                    let event = Event::default()
                        .event("job.updated")
                        .id(item.seq.to_string())
                        .json_data(item.payload)
                        .ok()?;
                    return Some((Ok::<_, std::convert::Infallible>(event), state));
                }
                state.pending = state
                    .service
                    .events(state.owner, state.cursor, 50)
                    .await
                    .ok()?
                    .into();
                if state.pending.is_empty() {
                    tokio::select! {_=state.service.wait_events()=>{},_=tokio::time::sleep(std::time::Duration::from_secs(1))=>{}}
                }
            }
        },
    );
    let mut response = Sse::new(stream)
        .keep_alive(
            KeepAlive::new()
                .interval(std::time::Duration::from_secs(10))
                .text("keepalive"),
        )
        .into_response();
    response.headers_mut().insert(
        "X-Accel-Buffering",
        axum::http::HeaderValue::from_static("no"),
    );
    Ok(response)
}
