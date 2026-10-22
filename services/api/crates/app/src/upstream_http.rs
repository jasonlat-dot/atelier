use crate::{
    auth_http::{AuthUser, RequireRole},
    AppState,
};
use atelier_common::{ApiError, ErrorResponse};
use atelier_upstream::{
    AccountInput, AccountPage, AccountStats, AccountView, BindingInput, Catalog, CatalogModel,
    Error, ModelInput, ModelView, Pricing, ProbeResult, QuotaInput, UpstreamService,
};
use axum::{
    extract::{
        rejection::{JsonRejection, PathRejection, QueryRejection},
        Path, Query, State,
    },
    http::StatusCode,
    Json,
};
use serde::Deserialize;
use uuid::Uuid;
fn service(state: &AppState) -> Result<&UpstreamService, ApiError> {
    state.upstream.as_ref().ok_or_else(|| Error::Store.into())
}
fn invalid() -> ApiError {
    Error::Validation.into()
}
#[derive(Deserialize, utoipa::IntoParams)]
#[serde(deny_unknown_fields)]
pub struct AccountsQuery {
    pub search: Option<String>,
    pub before: Option<Uuid>,
}
#[derive(Deserialize, utoipa::IntoParams)]
#[serde(deny_unknown_fields)]
pub struct RevisionQuery {
    pub revision: i64,
}
#[utoipa::path(get,path="/api/v1/admin/upstream-accounts",params(AccountsQuery),security(("session"=[])),responses((status=200,body=AccountPage),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=422,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn accounts(
    State(state): State<AppState>,
    _actor: RequireRole<false>,
    query: Result<Query<AccountsQuery>, QueryRejection>,
) -> Result<Json<AccountPage>, ApiError> {
    let Query(query) = query.map_err(|_| invalid())?;
    Ok(Json(
        service(&state)?
            .accounts(&query.search.unwrap_or_default(), query.before)
            .await?,
    ))
}
#[utoipa::path(get,path="/api/v1/admin/upstream-accounts/{id}",params(("id"=Uuid,Path)),security(("session"=[])),responses((status=200,body=AccountView),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=404,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn account(
    State(state): State<AppState>,
    _actor: RequireRole<false>,
    path: Result<Path<Uuid>, PathRejection>,
) -> Result<Json<AccountView>, ApiError> {
    let Path(id) = path.map_err(|_| invalid())?;
    Ok(Json(service(&state)?.account(id).await?))
}
#[utoipa::path(post,path="/api/v1/admin/upstream-accounts",request_body=AccountInput,security(("session"=[],"csrf"=[])),responses((status=201,body=AccountView),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=409,body=ErrorResponse),(status=422,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn create_account(
    State(state): State<AppState>,
    RequireRole(actor): RequireRole<false>,
    body: Result<Json<AccountInput>, JsonRejection>,
) -> Result<(StatusCode, Json<AccountView>), ApiError> {
    let Json(input) = body.map_err(|_| invalid())?;
    Ok((
        StatusCode::CREATED,
        Json(
            service(&state)?
                .save_account(actor.user().id, None, input)
                .await?,
        ),
    ))
}
#[utoipa::path(patch,path="/api/v1/admin/upstream-accounts/{id}",params(("id"=Uuid,Path)),request_body=AccountInput,security(("session"=[],"csrf"=[])),responses((status=200,body=AccountView),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=404,body=ErrorResponse),(status=409,body=ErrorResponse),(status=422,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn update_account(
    State(state): State<AppState>,
    RequireRole(actor): RequireRole<false>,
    path: Result<Path<Uuid>, PathRejection>,
    body: Result<Json<AccountInput>, JsonRejection>,
) -> Result<Json<AccountView>, ApiError> {
    let Path(id) = path.map_err(|_| invalid())?;
    let Json(input) = body.map_err(|_| invalid())?;
    Ok(Json(
        service(&state)?
            .save_account(actor.user().id, Some(id), input)
            .await?,
    ))
}
#[utoipa::path(delete,path="/api/v1/admin/upstream-accounts/{id}",params(("id"=Uuid,Path),RevisionQuery),security(("session"=[],"csrf"=[])),responses((status=204),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=404,body=ErrorResponse),(status=409,body=ErrorResponse),(status=422,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn delete_account(
    State(state): State<AppState>,
    RequireRole(actor): RequireRole<false>,
    path: Result<Path<Uuid>, PathRejection>,
    query: Result<Query<RevisionQuery>, QueryRejection>,
) -> Result<StatusCode, ApiError> {
    let Path(id) = path.map_err(|_| invalid())?;
    let Query(query) = query.map_err(|_| invalid())?;
    service(&state)?
        .delete_account(actor.user().id, id, query.revision)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}
#[utoipa::path(post,path="/api/v1/admin/upstream-accounts/import",request_body=Vec<AccountInput>,security(("session"=[],"csrf"=[])),responses((status=201,body=Vec<AccountView>),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=409,body=ErrorResponse),(status=422,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn import_accounts(
    State(state): State<AppState>,
    RequireRole(actor): RequireRole<false>,
    body: Result<Json<Vec<AccountInput>>, JsonRejection>,
) -> Result<(StatusCode, Json<Vec<AccountView>>), ApiError> {
    let Json(input) = body.map_err(|_| invalid())?;
    Ok((
        StatusCode::CREATED,
        Json(
            service(&state)?
                .import_accounts(actor.user().id, input)
                .await?,
        ),
    ))
}
#[utoipa::path(post,path="/api/v1/admin/upstream-accounts/{id}/test",params(("id"=Uuid,Path)),security(("session"=[],"csrf"=[])),responses((status=200,body=ProbeResult),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=404,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn probe(
    State(state): State<AppState>,
    RequireRole(actor): RequireRole<false>,
    path: Result<Path<Uuid>, PathRejection>,
) -> Result<Json<ProbeResult>, ApiError> {
    let Path(id) = path.map_err(|_| invalid())?;
    Ok(Json(service(&state)?.probe(actor.user().id, id).await?))
}
#[utoipa::path(post,path="/api/v1/admin/upstream-accounts/{id}/refresh-quota",params(("id"=Uuid,Path)),request_body=QuotaInput,security(("session"=[],"csrf"=[])),responses((status=200,body=AccountView),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=404,body=ErrorResponse),(status=409,body=ErrorResponse),(status=422,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn refresh_quota(
    State(state): State<AppState>,
    RequireRole(actor): RequireRole<false>,
    path: Result<Path<Uuid>, PathRejection>,
    body: Result<Json<QuotaInput>, JsonRejection>,
) -> Result<Json<AccountView>, ApiError> {
    let Path(id) = path.map_err(|_| invalid())?;
    let Json(input) = body.map_err(|_| invalid())?;
    Ok(Json(
        service(&state)?
            .refresh_quota(actor.user().id, id, input)
            .await?,
    ))
}
#[utoipa::path(get,path="/api/v1/admin/upstream-accounts/{id}/stats",params(("id"=Uuid,Path)),security(("session"=[])),responses((status=200,body=AccountStats),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=404,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn stats(
    State(state): State<AppState>,
    _actor: RequireRole<false>,
    path: Result<Path<Uuid>, PathRejection>,
) -> Result<Json<AccountStats>, ApiError> {
    let Path(id) = path.map_err(|_| invalid())?;
    Ok(Json(service(&state)?.stats(id).await?))
}
#[utoipa::path(get,path="/api/v1/admin/models",security(("session"=[])),responses((status=200,body=Vec<ModelView>),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn models(
    State(state): State<AppState>,
    _actor: RequireRole<false>,
) -> Result<Json<Vec<ModelView>>, ApiError> {
    Ok(Json(service(&state)?.models().await?))
}
#[utoipa::path(post,path="/api/v1/admin/models",request_body=ModelInput,security(("session"=[],"csrf"=[])),responses((status=201,body=ModelView),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=409,body=ErrorResponse),(status=422,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn create_model(
    State(state): State<AppState>,
    RequireRole(actor): RequireRole<false>,
    body: Result<Json<ModelInput>, JsonRejection>,
) -> Result<(StatusCode, Json<ModelView>), ApiError> {
    let Json(input) = body.map_err(|_| invalid())?;
    Ok((
        StatusCode::CREATED,
        Json(
            service(&state)?
                .save_model(actor.user().id, false, input)
                .await?,
        ),
    ))
}
#[utoipa::path(patch,path="/api/v1/admin/models",request_body=ModelInput,security(("session"=[],"csrf"=[])),responses((status=200,body=ModelView),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=404,body=ErrorResponse),(status=409,body=ErrorResponse),(status=422,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn update_model(
    State(state): State<AppState>,
    RequireRole(actor): RequireRole<false>,
    body: Result<Json<ModelInput>, JsonRejection>,
) -> Result<Json<ModelView>, ApiError> {
    let Json(input) = body.map_err(|_| invalid())?;
    Ok(Json(
        service(&state)?
            .save_model(actor.user().id, true, input)
            .await?,
    ))
}
#[utoipa::path(put,path="/api/v1/admin/models/{id}/accounts",params(("id"=String,Path)),request_body=BindingInput,security(("session"=[],"csrf"=[])),responses((status=200,body=ModelView),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=404,body=ErrorResponse),(status=409,body=ErrorResponse),(status=422,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn bindings(
    State(state): State<AppState>,
    RequireRole(actor): RequireRole<false>,
    path: Result<Path<String>, PathRejection>,
    body: Result<Json<BindingInput>, JsonRejection>,
) -> Result<Json<ModelView>, ApiError> {
    let Path(id) = path.map_err(|_| invalid())?;
    let Json(input) = body.map_err(|_| invalid())?;
    Ok(Json(
        service(&state)?
            .bind_accounts(actor.user().id, &id, input)
            .await?,
    ))
}
#[utoipa::path(get,path="/api/v1/admin/pricing",security(("session"=[])),responses((status=200,body=Pricing),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn pricing(
    State(state): State<AppState>,
    _actor: RequireRole<false>,
) -> Result<Json<Pricing>, ApiError> {
    Ok(Json(service(&state)?.pricing().await?))
}
#[utoipa::path(put,path="/api/v1/admin/pricing",request_body=Pricing,security(("session"=[],"csrf"=[])),responses((status=200,body=Pricing),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=409,body=ErrorResponse),(status=422,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn save_pricing(
    State(state): State<AppState>,
    RequireRole(actor): RequireRole<false>,
    body: Result<Json<Pricing>, JsonRejection>,
) -> Result<Json<Pricing>, ApiError> {
    let Json(input) = body.map_err(|_| invalid())?;
    Ok(Json(
        service(&state)?
            .save_pricing(actor.user().id, input)
            .await?,
    ))
}
#[utoipa::path(get,path="/api/v1/models",security(("session"=[])),responses((status=200,body=Catalog),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn catalog(
    State(state): State<AppState>,
    _actor: AuthUser,
) -> Result<Json<Catalog>, ApiError> {
    let service = service(&state)?;
    let models = service.models().await?;
    let pricing = service.pricing().await?;
    Ok(Json(Catalog {
        models: models
            .into_iter()
            .filter(|m| m.enabled)
            .map(|m| {
                let prices = pricing
                    .rules
                    .iter()
                    .filter(|r| r.model_id == m.id)
                    .cloned()
                    .collect();
                CatalogModel {
                    id: m.id,
                    kind: m.kind,
                    display_name: m.display_name,
                    capabilities: m.capabilities,
                    prices,
                }
            })
            .collect(),
        multipliers: pricing.multipliers,
    }))
}
