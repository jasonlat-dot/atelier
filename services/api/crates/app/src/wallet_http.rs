use crate::{
    auth_http::{AuthUser, RequireRole},
    AppState,
};
use atelier_common::{ApiError, ErrorResponse};
use atelier_wallet::*;
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
    WalletError::Validation.into()
}
fn key(headers: &HeaderMap) -> Result<Uuid, ApiError> {
    let mut keys = headers.get_all("Idempotency-Key").iter();
    let key = keys
        .next()
        .and_then(|h| h.to_str().ok())
        .and_then(|v| Uuid::parse_str(v).ok())
        .ok_or_else(invalid)?;
    if keys.next().is_some() || key.is_nil() {
        return Err(invalid());
    }
    Ok(key)
}
fn service(state: &AppState) -> WalletService {
    let wallet = WalletService::new(state.db.clone());
    match &state.code_cipher {
        Some(cipher) => wallet.with_code_cipher(cipher.clone()),
        None => wallet,
    }
}
#[utoipa::path(get,path="/api/v1/wallet",security(("session"=[])),responses((status=200,body=WalletSummary),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn summary(
    State(state): State<AppState>,
    AuthUser(actor): AuthUser,
) -> Result<Json<WalletSummary>, ApiError> {
    BillingService::new(state.db.clone())
        .entitlements(actor.user().id)
        .await?;
    Ok(Json(service(&state).summary(actor.user().id).await?))
}
#[derive(Deserialize, utoipa::IntoParams)]
#[serde(deny_unknown_fields)]
pub struct LedgerQuery {
    pub before: Option<i64>,
    pub limit: Option<i64>,
}
#[utoipa::path(get,path="/api/v1/wallet/ledger",params(LedgerQuery),security(("session"=[])),responses((status=200,body=LedgerPage),(status=422,body=ErrorResponse),(status=401,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn ledger(
    State(state): State<AppState>,
    AuthUser(actor): AuthUser,
    query: Result<Query<LedgerQuery>, QueryRejection>,
) -> Result<Json<LedgerPage>, ApiError> {
    let Query(query) = query.map_err(|_| invalid())?;
    Ok(Json(
        service(&state)
            .ledger(actor.user().id, query.before, query.limit.unwrap_or(25))
            .await?,
    ))
}
#[utoipa::path(post,path="/api/v1/wallet/checkin",security(("session"=[],"csrf"=[])),responses((status=200,body=CheckinReceipt),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=429,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn checkin(
    State(state): State<AppState>,
    AuthUser(actor): AuthUser,
) -> Result<Json<CheckinReceipt>, ApiError> {
    use atelier_auth::transient::{RateDecision, CHECKIN_RATE};
    let limits = state
        .limits
        .as_ref()
        .ok_or_else(|| ApiError::from(WalletError::Store))?;
    match limits
        .rate_limit(format!("wallet:checkin:{}", actor.user().id), CHECKIN_RATE)
        .await
    {
        Ok(RateDecision::Allowed) => {}
        Ok(RateDecision::Limited { .. }) => {
            return Err(ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "TOO_MANY_REQUESTS",
                "Please retry later",
            ))
        }
        Err(_) => return Err(WalletError::Store.into()),
    }
    Ok(Json(service(&state).checkin(actor.user().id).await?))
}
#[utoipa::path(post,path="/api/v1/wallet/redeem",request_body=RedeemRequest,params(("Idempotency-Key"=Uuid,Header)),security(("session"=[],"csrf"=[])),responses((status=200,body=CreditReceipt),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=422,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn redeem(
    State(state): State<AppState>,
    AuthUser(actor): AuthUser,
    headers: HeaderMap,
    body: Result<Json<RedeemRequest>, JsonRejection>,
) -> Result<Json<CreditReceipt>, ApiError> {
    let request = key(&headers)?;
    let Json(body) = body.map_err(|_| invalid())?;
    Ok(Json(
        service(&state)
            .redeem(actor.user().id, request, &body.code)
            .await?,
    ))
}
#[utoipa::path(post,path="/api/v1/admin/users/{id}/credits",request_body=AdjustRequest,params(("id"=Uuid,Path),("Idempotency-Key"=Uuid,Header)),security(("session"=[],"csrf"=[])),responses((status=200,body=CreditReceipt),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=402,body=ErrorResponse),(status=422,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn adjust(
    State(state): State<AppState>,
    RequireRole(actor): RequireRole<false>,
    id: Result<Path<Uuid>, PathRejection>,
    headers: HeaderMap,
    body: Result<Json<AdjustRequest>, JsonRejection>,
) -> Result<Json<CreditReceipt>, ApiError> {
    let Path(id) = id.map_err(|_| invalid())?;
    let request = key(&headers)?;
    let Json(body) = body.map_err(|_| invalid())?;
    Ok(Json(
        atelier_admin::AdminService::new(state.db.clone())
            .adjust_credits(actor.user().id, id, request, body.amount, &body.reason)
            .await?,
    ))
}
#[utoipa::path(post,path="/api/v1/admin/redeem-codes",request_body=CreateCodesRequest,security(("session"=[],"csrf"=[])),responses((status=200,body=CreatedCodes),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=422,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn create_codes(
    State(state): State<AppState>,
    RequireRole(actor): RequireRole<false>,
    body: Result<Json<CreateCodesRequest>, JsonRejection>,
) -> Result<Json<CreatedCodes>, ApiError> {
    let Json(body) = body.map_err(|_| invalid())?;
    Ok(Json(
        service(&state).create_codes(actor.user().id, &body).await?,
    ))
}
#[derive(Deserialize, utoipa::IntoParams)]
#[serde(deny_unknown_fields)]
pub struct CodesQuery {
    pub before: Option<Uuid>,
}
#[utoipa::path(get,path="/api/v1/admin/redeem-codes",params(CodesQuery),security(("session"=[])),responses((status=200,body=Vec<CodeInfo>),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=422,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn codes(
    State(state): State<AppState>,
    _actor: RequireRole<false>,
    query: Result<Query<CodesQuery>, QueryRejection>,
) -> Result<Json<Vec<CodeInfo>>, ApiError> {
    let Query(query) = query.map_err(|_| invalid())?;
    Ok(Json(service(&state).codes(query.before).await?))
}

#[utoipa::path(post,path="/api/v1/admin/redeem-codes/{id}/copy",params(("id"=Uuid,Path)),security(("session"=[],"csrf"=[])),responses((status=200,body=CreatedCode),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=404,body=ErrorResponse),(status=409,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn copy_code(
    State(state): State<AppState>,
    RequireRole(actor): RequireRole<false>,
    path: Result<Path<Uuid>, PathRejection>,
) -> Result<Json<CreatedCode>, ApiError> {
    let Path(id) = path.map_err(|_| invalid())?;
    Ok(Json(
        service(&state).reveal_code(actor.user().id, id).await?,
    ))
}

#[utoipa::path(patch,path="/api/v1/admin/redeem-codes/{id}",params(("id"=Uuid,Path)),request_body=CodeStateRequest,security(("session"=[],"csrf"=[])),responses((status=200,body=CodeInfo),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=404,body=ErrorResponse),(status=409,body=ErrorResponse),(status=422,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn update_code(
    State(state): State<AppState>,
    RequireRole(actor): RequireRole<false>,
    path: Result<Path<Uuid>, PathRejection>,
    body: Result<Json<CodeStateRequest>, JsonRejection>,
) -> Result<Json<CodeInfo>, ApiError> {
    let Path(id) = path.map_err(|_| invalid())?;
    let Json(body) = body.map_err(|_| invalid())?;
    Ok(Json(
        service(&state)
            .update_code(actor.user().id, id, body)
            .await?,
    ))
}

#[utoipa::path(delete,path="/api/v1/admin/redeem-codes/{id}",params(("id"=Uuid,Path)),request_body=CodeDeleteRequest,security(("session"=[],"csrf"=[])),responses((status=200,body=CodeInfo),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=404,body=ErrorResponse),(status=409,body=ErrorResponse),(status=422,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn delete_code(
    State(state): State<AppState>,
    RequireRole(actor): RequireRole<false>,
    path: Result<Path<Uuid>, PathRejection>,
    body: Result<Json<CodeDeleteRequest>, JsonRejection>,
) -> Result<Json<CodeInfo>, ApiError> {
    let Path(id) = path.map_err(|_| invalid())?;
    let Json(body) = body.map_err(|_| invalid())?;
    Ok(Json(
        service(&state)
            .delete_code(actor.user().id, id, body.revision)
            .await?,
    ))
}
#[utoipa::path(get,path="/api/v1/admin/credits/adjustments",security(("session"=[])),responses((status=200,body=Vec<CreditAdjustment>),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn adjustments(
    State(state): State<AppState>,
    _actor: RequireRole<false>,
) -> Result<Json<Vec<CreditAdjustment>>, ApiError> {
    Ok(Json(service(&state).adjustments().await?))
}
