use crate::{auth_http::AuthUser, AppState};
use atelier_assets::{
    AssetError, AssetLimits, AssetPage, AssetService, AssetView, DeleteAssets, MAX_IMAGE_BYTES,
    MAX_VIDEO_BYTES,
};
use atelier_common::{ApiError, ErrorResponse};
use axum::{
    extract::{
        multipart::MultipartRejection,
        rejection::{JsonRejection, PathRejection, QueryRejection},
        Multipart, Path, Query, State,
    },
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use uuid::Uuid;

fn service(state: &AppState) -> Result<&AssetService, ApiError> {
    state
        .assets
        .as_ref()
        .ok_or_else(|| AssetError::Store.into())
}
fn invalid() -> ApiError {
    AssetError::Validation.into()
}
#[derive(Deserialize, utoipa::IntoParams)]
#[serde(deny_unknown_fields)]
pub struct AssetsQuery {
    pub kind: Option<String>,
    pub source: Option<String>,
    pub search: Option<String>,
    pub before: Option<Uuid>,
    pub limit: Option<i64>,
}
#[utoipa::path(get,path="/api/v1/assets",params(AssetsQuery),security(("session"=[])),responses((status=200,body=AssetPage),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=422,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn list(
    State(state): State<AppState>,
    AuthUser(actor): AuthUser,
    query: Result<Query<AssetsQuery>, QueryRejection>,
) -> Result<Json<AssetPage>, ApiError> {
    let Query(query) = query.map_err(|_| invalid())?;
    Ok(Json(
        service(&state)?
            .list(
                actor.user().id,
                query.kind,
                query.source,
                query.search.unwrap_or_default(),
                query.before,
                query.limit.unwrap_or(24),
            )
            .await?,
    ))
}
#[utoipa::path(get,path="/api/v1/assets/{id}",params(("id"=Uuid,Path)),security(("session"=[])),responses((status=200,body=AssetView),(status=401,body=ErrorResponse),(status=404,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn get_one(
    State(state): State<AppState>,
    AuthUser(actor): AuthUser,
    id: Result<Path<Uuid>, PathRejection>,
) -> Result<Json<AssetView>, ApiError> {
    let Path(id) = id.map_err(|_| invalid())?;
    Ok(Json(service(&state)?.get(actor.user().id, id).await?))
}
#[utoipa::path(get,path="/api/v1/assets/limits",security(("session"=[])),responses((status=200,body=AssetLimits),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn limits(
    State(state): State<AppState>,
    _actor: AuthUser,
) -> Result<Json<AssetLimits>, ApiError> {
    Ok(Json(AssetLimits {
        image_max_bytes: MAX_IMAGE_BYTES,
        video_max_bytes: MAX_VIDEO_BYTES,
        video_enabled: service(&state)?.video_enabled(),
        max_video_seconds: 60,
    }))
}
#[derive(utoipa::ToSchema)]
pub struct UploadFile {
    #[schema(value_type=String,format=Binary)]
    pub file: String,
}
#[utoipa::path(post,path="/api/v1/assets/uploads",request_body(content=UploadFile,content_type="multipart/form-data"),security(("session"=[],"csrf"=[])),responses((status=201,body=AssetView),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=413,body=ErrorResponse),(status=422,body=ErrorResponse),(status=429,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn upload(
    State(state): State<AppState>,
    AuthUser(actor): AuthUser,
    multipart: Result<Multipart, MultipartRejection>,
) -> Result<(StatusCode, Json<AssetView>), ApiError> {
    let service = service(&state)?;
    let _slot = service.ingest_slot()?;
    let limits = state
        .limits
        .as_ref()
        .ok_or_else(|| ApiError::from(AssetError::Store))?;
    match limits
        .rate_limit(
            format!("assets:upload:{}", actor.user().id),
            atelier_auth::transient::RateRule {
                limit: 10,
                window_seconds: 60,
            },
        )
        .await
    {
        Ok(atelier_auth::transient::RateDecision::Allowed) => {}
        Ok(atelier_auth::transient::RateDecision::Limited { .. }) => {
            return Err(AssetError::Busy.into())
        }
        Err(_) => return Err(AssetError::Store.into()),
    }
    let mut multipart = multipart.map_err(|_| invalid())?;
    let mut file = None;
    while let Some(mut field) = multipart.next_field().await.map_err(|_| invalid())? {
        if field.name() != Some("file") || file.is_some() {
            return Err(invalid());
        }
        let name = field.file_name().ok_or_else(invalid)?.to_owned();
        let mime = field.content_type().ok_or_else(invalid)?.to_owned();
        if !matches!(
            mime.as_str(),
            "image/png" | "image/jpeg" | "image/webp" | "video/mp4" | "video/webm"
        ) {
            return Err(invalid());
        }
        let max_bytes = if mime.starts_with("video/") {
            MAX_VIDEO_BYTES
        } else {
            MAX_IMAGE_BYTES
        };
        let mut bytes = Vec::new();
        while let Some(chunk) = field.chunk().await.map_err(|error| {
            if error.status() == StatusCode::PAYLOAD_TOO_LARGE {
                ApiError::from(AssetError::TooLarge)
            } else {
                invalid()
            }
        })? {
            if bytes.len() + chunk.len() > max_bytes {
                return Err(AssetError::TooLarge.into());
            }
            bytes.extend_from_slice(&chunk);
        }
        file = Some((name, mime, bytes));
    }
    let (name, mime, bytes) = file.ok_or_else(invalid)?;
    Ok((
        StatusCode::CREATED,
        Json(if mime.starts_with("video/") {
            service
                .upload_video(actor.user().id, &name, &mime, bytes)
                .await?
        } else {
            service
                .upload_image(actor.user().id, &name, &mime, bytes)
                .await?
        }),
    ))
}
#[utoipa::path(delete,path="/api/v1/assets/{id}",params(("id"=Uuid,Path)),security(("session"=[],"csrf"=[])),responses((status=204),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=404,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn delete_one(
    State(state): State<AppState>,
    AuthUser(actor): AuthUser,
    id: Result<Path<Uuid>, PathRejection>,
) -> Result<StatusCode, ApiError> {
    let Path(id) = id.map_err(|_| invalid())?;
    service(&state)?.delete(actor.user().id, vec![id]).await?;
    Ok(StatusCode::NO_CONTENT)
}
#[utoipa::path(delete,path="/api/v1/assets",request_body=DeleteAssets,security(("session"=[],"csrf"=[])),responses((status=204),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=404,body=ErrorResponse),(status=422,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn delete_many(
    State(state): State<AppState>,
    AuthUser(actor): AuthUser,
    body: Result<Json<DeleteAssets>, JsonRejection>,
) -> Result<StatusCode, ApiError> {
    let Json(body) = body.map_err(|_| invalid())?;
    service(&state)?.delete(actor.user().id, body.ids).await?;
    Ok(StatusCode::NO_CONTENT)
}
#[derive(Deserialize, utoipa::IntoParams)]
#[serde(deny_unknown_fields)]
pub struct MediaQuery {
    pub expires: i64,
    pub signature: String,
}
#[utoipa::path(get,path="/media/{id}/{variant}",params(("id"=Uuid,Path),("variant"=String,Path),MediaQuery),security(("session"=[])),responses((status=200,description="Private sanitized media"),(status=206,description="Byte range"),(status=401,body=ErrorResponse),(status=404,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn media(
    State(state): State<AppState>,
    AuthUser(actor): AuthUser,
    path: Result<Path<(Uuid, String)>, PathRejection>,
    query: Result<Query<MediaQuery>, QueryRejection>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let Path((id, variant)) = path.map_err(|_| ApiError::not_found())?;
    let Query(query) = query.map_err(|_| ApiError::not_found())?;
    let mut ranges = headers.get_all(header::RANGE).iter();
    let range = ranges
        .next()
        .map(|v| v.to_str().map_err(|_| invalid()))
        .transpose()?;
    if ranges.next().is_some() {
        return Err(invalid());
    }
    let value = service(&state)?
        .media(
            actor.user().id,
            id,
            &variant,
            query.expires,
            &query.signature,
            range,
        )
        .await?;
    let mut response = (
        if value.partial {
            StatusCode::PARTIAL_CONTENT
        } else {
            StatusCode::OK
        },
        value.body,
    )
        .into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        value.mime.parse().map_err(|_| invalid())?,
    );
    headers.insert(
        header::CONTENT_LENGTH,
        (value.end - value.start)
            .to_string()
            .parse()
            .map_err(|_| invalid())?,
    );
    headers.insert(header::ACCEPT_RANGES, "bytes".parse().unwrap());
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    headers.insert(
        header::CONTENT_DISPOSITION,
        format!(
            "inline; filename=\"Atelier-{id}.{}\"",
            if value.mime == "video/mp4" {
                "mp4"
            } else if value.mime == "image/jpeg" {
                "jpg"
            } else {
                "png"
            }
        )
        .parse()
        .map_err(|_| invalid())?,
    );
    if value.partial {
        headers.insert(
            header::CONTENT_RANGE,
            format!("bytes {}-{}/{}", value.start, value.end - 1, value.total)
                .parse()
                .map_err(|_| invalid())?,
        );
    }
    Ok(response)
}
