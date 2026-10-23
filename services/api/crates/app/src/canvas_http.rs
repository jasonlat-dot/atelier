use crate::{auth_http::AuthUser, AppState};
use atelier_canvas::*;
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
fn service(s: &AppState) -> Result<&CanvasService, ApiError> {
    s.canvas.as_ref().ok_or_else(|| CanvasError::Store.into())
}
#[utoipa::path(get,path="/api/v1/projects/{id}/export",params(("id"=Uuid,Path)),security(("session"=[])),responses((status=200,body=String,content_type="application/zip"),(status=401,body=ErrorResponse),(status=404,body=ErrorResponse),(status=413,body=ErrorResponse),(status=429,body=ErrorResponse)))]
pub async fn export(
    State(s): State<AppState>,
    AuthUser(actor): AuthUser,
    path: Result<Path<Uuid>, PathRejection>,
) -> Result<impl axum::response::IntoResponse, ApiError> {
    let Path(id) = path.map_err(|_| invalid())?;
    let bytes = service(&s)?.export(actor.user().id, id).await?;
    Ok((
        [
            ("Content-Type", "application/zip"),
            (
                "Content-Disposition",
                "attachment; filename=atelier-project.zip",
            ),
        ],
        bytes,
    ))
}
#[utoipa::path(post,path="/api/v1/projects/import",request_body(content=String,content_type="application/zip"),params(("Idempotency-Key"=Uuid,Header)),security(("session"=[],"csrf"=[])),responses((status=201,body=ProjectView),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=413,body=ErrorResponse),(status=422,body=ErrorResponse),(status=429,body=ErrorResponse)))]
pub async fn import(
    State(s): State<AppState>,
    AuthUser(actor): AuthUser,
    request: axum::extract::Request,
) -> Result<(StatusCode, Json<ProjectView>), ApiError> {
    let key = key(request.headers())?;
    if request
        .headers()
        .get("Content-Type")
        .and_then(|v| v.to_str().ok())
        != Some("application/zip")
    {
        return Err(invalid());
    }
    let service = service(&s)?;
    let slot = service.archive_slot()?;
    let bytes = axum::body::to_bytes(request.into_body(), MAX_ARCHIVE_BYTES)
        .await
        .map_err(|_| ApiError::from(CanvasError::TooLarge))?;
    Ok((
        StatusCode::CREATED,
        Json(
            service
                .import(actor.user().id, key, bytes.to_vec(), slot)
                .await?,
        ),
    ))
}
fn invalid() -> ApiError {
    CanvasError::Validation.into()
}
fn revision(headers: &HeaderMap) -> Result<i64, ApiError> {
    let mut values = headers.get_all("If-Match").iter();
    let raw = values.next().and_then(|v| v.to_str().ok()).ok_or_else(|| {
        ApiError::new(
            StatusCode::PRECONDITION_REQUIRED,
            "REVISION_REQUIRED",
            "If-Match project revision required",
        )
    })?;
    if values.next().is_some() {
        return Err(invalid());
    }
    let number = raw
        .strip_prefix('"')
        .and_then(|v| v.strip_suffix('"'))
        .unwrap_or(raw);
    if number.is_empty() || !number.bytes().all(|b| b.is_ascii_digit()) {
        return Err(invalid());
    }
    number.parse::<i64>().map_err(|_| invalid())
}
fn key(headers: &HeaderMap) -> Result<Uuid, ApiError> {
    let mut values = headers.get_all("Idempotency-Key").iter();
    let id = values
        .next()
        .and_then(|v| v.to_str().ok())
        .and_then(|s| Uuid::parse_str(s).ok())
        .filter(|id| !id.is_nil())
        .ok_or_else(invalid)?;
    if values.next().is_some() {
        return Err(invalid());
    }
    Ok(id)
}
#[derive(Deserialize, utoipa::IntoParams)]
#[serde(deny_unknown_fields)]
pub struct ProjectsQuery {
    pub before: Option<Uuid>,
    pub limit: Option<i64>,
}
#[utoipa::path(get,path="/api/v1/projects",params(ProjectsQuery),security(("session"=[])),responses((status=200,body=ProjectPage),(status=401,body=ErrorResponse),(status=422,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn list(
    State(s): State<AppState>,
    AuthUser(actor): AuthUser,
    q: Result<Query<ProjectsQuery>, QueryRejection>,
) -> Result<Json<ProjectPage>, ApiError> {
    let Query(q) = q.map_err(|_| invalid())?;
    Ok(Json(
        service(&s)?
            .list(actor.user().id, q.before, q.limit.unwrap_or(25))
            .await?,
    ))
}
#[utoipa::path(post,path="/api/v1/projects",request_body=CreateProject,params(("Idempotency-Key"=Uuid,Header)),security(("session"=[],"csrf"=[])),responses((status=201,body=ProjectView),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=404,body=ErrorResponse),(status=409,body=ErrorResponse),(status=422,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn create(
    State(s): State<AppState>,
    AuthUser(actor): AuthUser,
    headers: HeaderMap,
    body: Result<Json<CreateProject>, JsonRejection>,
) -> Result<(StatusCode, Json<ProjectView>), ApiError> {
    let Json(input) = body.map_err(|_| invalid())?;
    Ok((
        StatusCode::CREATED,
        Json(
            service(&s)?
                .create(actor.user().id, key(&headers)?, input)
                .await?,
        ),
    ))
}
#[utoipa::path(get,path="/api/v1/projects/{id}",params(("id"=Uuid,Path)),security(("session"=[])),responses((status=200,body=ProjectView),(status=401,body=ErrorResponse),(status=404,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn get_one(
    State(s): State<AppState>,
    AuthUser(actor): AuthUser,
    path: Result<Path<Uuid>, PathRejection>,
) -> Result<Json<ProjectView>, ApiError> {
    let Path(id) = path.map_err(|_| invalid())?;
    Ok(Json(service(&s)?.get(actor.user().id, id).await?))
}
#[utoipa::path(put,path="/api/v1/projects/{id}/graph",request_body=CanvasGraph,params(("id"=Uuid,Path),("If-Match"=String,Header)),security(("session"=[],"csrf"=[])),responses((status=200,body=ProjectView),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=404,body=ErrorResponse),(status=409,body=ErrorResponse),(status=422,body=ErrorResponse),(status=428,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn save(
    State(s): State<AppState>,
    AuthUser(actor): AuthUser,
    path: Result<Path<Uuid>, PathRejection>,
    headers: HeaderMap,
    body: Result<Json<CanvasGraph>, JsonRejection>,
) -> Result<Json<ProjectView>, ApiError> {
    let Path(id) = path.map_err(|_| invalid())?;
    let Json(graph) = body.map_err(|_| invalid())?;
    Ok(Json(
        service(&s)?
            .save(actor.user().id, id, revision(&headers)?, graph)
            .await?,
    ))
}
#[utoipa::path(patch,path="/api/v1/projects/{id}",request_body=RenameProject,params(("id"=Uuid,Path),("If-Match"=String,Header)),security(("session"=[],"csrf"=[])),responses((status=200,body=ProjectView),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=404,body=ErrorResponse),(status=409,body=ErrorResponse),(status=422,body=ErrorResponse),(status=428,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn rename(
    State(s): State<AppState>,
    AuthUser(actor): AuthUser,
    path: Result<Path<Uuid>, PathRejection>,
    headers: HeaderMap,
    body: Result<Json<RenameProject>, JsonRejection>,
) -> Result<Json<ProjectView>, ApiError> {
    let Path(id) = path.map_err(|_| invalid())?;
    let Json(input) = body.map_err(|_| invalid())?;
    Ok(Json(
        service(&s)?
            .rename(actor.user().id, id, revision(&headers)?, &input.name)
            .await?,
    ))
}
#[utoipa::path(delete,path="/api/v1/projects/{id}",params(("id"=Uuid,Path),("If-Match"=String,Header)),security(("session"=[],"csrf"=[])),responses((status=204),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=404,body=ErrorResponse),(status=409,body=ErrorResponse),(status=422,body=ErrorResponse),(status=428,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn delete_one(
    State(s): State<AppState>,
    AuthUser(actor): AuthUser,
    path: Result<Path<Uuid>, PathRejection>,
    headers: HeaderMap,
) -> Result<StatusCode, ApiError> {
    let Path(id) = path.map_err(|_| invalid())?;
    service(&s)?
        .delete(actor.user().id, id, revision(&headers)?)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}
#[utoipa::path(post,path="/api/v1/projects/{id}/duplicate",params(("id"=Uuid,Path),("Idempotency-Key"=Uuid,Header)),security(("session"=[],"csrf"=[])),responses((status=201,body=ProjectView),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=404,body=ErrorResponse),(status=409,body=ErrorResponse),(status=422,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn duplicate(
    State(s): State<AppState>,
    AuthUser(actor): AuthUser,
    path: Result<Path<Uuid>, PathRejection>,
    headers: HeaderMap,
) -> Result<(StatusCode, Json<ProjectView>), ApiError> {
    let Path(id) = path.map_err(|_| invalid())?;
    Ok((
        StatusCode::CREATED,
        Json(
            service(&s)?
                .duplicate(actor.user().id, id, key(&headers)?)
                .await?,
        ),
    ))
}
#[utoipa::path(get,path="/api/v1/projects/{id}/snapshots",params(("id"=Uuid,Path)),security(("session"=[])),responses((status=200,body=Vec<ProjectSnapshot>),(status=401,body=ErrorResponse),(status=404,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn snapshots(
    State(s): State<AppState>,
    AuthUser(actor): AuthUser,
    path: Result<Path<Uuid>, PathRejection>,
) -> Result<Json<Vec<ProjectSnapshot>>, ApiError> {
    let Path(id) = path.map_err(|_| invalid())?;
    Ok(Json(service(&s)?.snapshots(actor.user().id, id).await?))
}
#[utoipa::path(post,path="/api/v1/projects/{id}/snapshots/{snapshot}/restore",params(("id"=Uuid,Path),("snapshot"=Uuid,Path),("If-Match"=String,Header)),security(("session"=[],"csrf"=[])),responses((status=200,body=ProjectView),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=404,body=ErrorResponse),(status=409,body=ErrorResponse),(status=422,body=ErrorResponse),(status=428,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn restore(
    State(s): State<AppState>,
    AuthUser(actor): AuthUser,
    path: Result<Path<(Uuid, Uuid)>, PathRejection>,
    headers: HeaderMap,
) -> Result<Json<ProjectView>, ApiError> {
    let Path((id, snapshot)) = path.map_err(|_| invalid())?;
    Ok(Json(
        service(&s)?
            .restore(actor.user().id, id, revision(&headers)?, snapshot)
            .await?,
    ))
}
#[utoipa::path(get,path="/api/v1/assets/{id}/projects",params(("id"=Uuid,Path)),security(("session"=[])),responses((status=200,body=Vec<ProjectReference>),(status=401,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn references(
    State(s): State<AppState>,
    AuthUser(actor): AuthUser,
    path: Result<Path<Uuid>, PathRejection>,
) -> Result<Json<Vec<ProjectReference>>, ApiError> {
    let Path(id) = path.map_err(|_| invalid())?;
    Ok(Json(service(&s)?.references(actor.user().id, id).await?))
}
