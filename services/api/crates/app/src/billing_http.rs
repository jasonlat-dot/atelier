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
    http::HeaderMap,
    Json,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

fn invalid() -> ApiError {
    BillingError::Validation.into()
}
fn service(s: &AppState) -> BillingService {
    BillingService::new(s.db.clone())
}
fn key(h: &HeaderMap) -> Result<Uuid, ApiError> {
    let mut keys = h.get_all("Idempotency-Key").iter();
    let k = keys
        .next()
        .and_then(|v| v.to_str().ok())
        .and_then(|v| Uuid::parse_str(v).ok())
        .filter(|v| !v.is_nil())
        .ok_or_else(invalid)?;
    if keys.next().is_some() {
        return Err(invalid());
    }
    Ok(k)
}
#[derive(Deserialize, utoipa::IntoParams)]
#[serde(deny_unknown_fields)]
pub struct OrdersQuery {
    pub before: Option<Uuid>,
}
#[derive(Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PlanUpdate {
    pub revision: i64,
    pub details: PlanInput,
}
#[derive(Serialize, utoipa::ToSchema)]
pub struct Checkout {
    pub order: OrderView,
    pub instructions: String,
}

#[utoipa::path(get,path="/api/v1/plans",security(("session"=[])),responses((status=200,body=Vec<PlanView>),(status=401,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn plans(
    State(s): State<AppState>,
    _: AuthUser,
) -> Result<Json<Vec<PlanView>>, ApiError> {
    Ok(Json(service(&s).plans(false).await?))
}
#[utoipa::path(get,path="/api/v1/subscription",security(("session"=[])),responses((status=200,body=Entitlements),(status=401,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn subscription(
    State(s): State<AppState>,
    AuthUser(a): AuthUser,
) -> Result<Json<Entitlements>, ApiError> {
    Ok(Json(service(&s).entitlements(a.user().id).await?))
}
#[utoipa::path(post,path="/api/v1/orders",request_body=OrderInput,params(("Idempotency-Key"=Uuid,Header)),security(("session"=[],"csrf"=[])),responses((status=200,body=Checkout),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=409,body=ErrorResponse),(status=422,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn create_order(
    State(s): State<AppState>,
    AuthUser(a): AuthUser,
    h: HeaderMap,
    body: Result<Json<OrderInput>, JsonRejection>,
) -> Result<Json<Checkout>, ApiError> {
    let Json(b) = body.map_err(|_| invalid())?;
    let o = service(&s).create_order(a.user().id, key(&h)?, &b).await?;
    Ok(Json(Checkout {
        instructions: ManualProvider.create_checkout(&o),
        order: o,
    }))
}
#[utoipa::path(get,path="/api/v1/orders",params(OrdersQuery),security(("session"=[])),responses((status=200,body=OrderPage),(status=401,body=ErrorResponse),(status=422,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn orders(
    State(s): State<AppState>,
    AuthUser(a): AuthUser,
    q: Result<Query<OrdersQuery>, QueryRejection>,
) -> Result<Json<OrderPage>, ApiError> {
    let Query(q) = q.map_err(|_| invalid())?;
    Ok(Json(service(&s).orders(Some(a.user().id), q.before).await?))
}
#[utoipa::path(get,path="/api/v1/orders/{id}",params(("id"=Uuid,Path)),security(("session"=[])),responses((status=200,body=Checkout),(status=401,body=ErrorResponse),(status=404,body=ErrorResponse),(status=422,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn order(
    State(s): State<AppState>,
    AuthUser(a): AuthUser,
    id: Result<Path<Uuid>, PathRejection>,
) -> Result<Json<Checkout>, ApiError> {
    let Path(id) = id.map_err(|_| invalid())?;
    let o = service(&s).order(a.user().id, id, false).await?;
    Ok(Json(Checkout {
        instructions: ManualProvider.create_checkout(&o),
        order: o,
    }))
}
#[utoipa::path(post,path="/api/v1/orders/{id}/cancel",params(("id"=Uuid,Path)),security(("session"=[],"csrf"=[])),responses((status=200,body=OrderView),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=404,body=ErrorResponse),(status=409,body=ErrorResponse),(status=422,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn cancel(
    State(s): State<AppState>,
    AuthUser(a): AuthUser,
    id: Result<Path<Uuid>, PathRejection>,
) -> Result<Json<OrderView>, ApiError> {
    let Path(id) = id.map_err(|_| invalid())?;
    Ok(Json(service(&s).cancel_order(a.user().id, id).await?))
}
#[utoipa::path(get,path="/api/v1/admin/plans",security(("session"=[])),responses((status=200,body=Vec<PlanView>),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn admin_plans(
    State(s): State<AppState>,
    _: RequireRole<false>,
) -> Result<Json<Vec<PlanView>>, ApiError> {
    Ok(Json(service(&s).plans(true).await?))
}
#[utoipa::path(post,path="/api/v1/admin/plans",request_body=PlanInput,security(("session"=[],"csrf"=[])),responses((status=200,body=PlanView),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=422,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn create_plan(
    State(s): State<AppState>,
    RequireRole(a): RequireRole<false>,
    body: Result<Json<PlanInput>, JsonRejection>,
) -> Result<Json<PlanView>, ApiError> {
    let Json(b) = body.map_err(|_| invalid())?;
    Ok(Json(service(&s).create_plan(a.user().id, &b).await?))
}
#[utoipa::path(patch,path="/api/v1/admin/plans/{id}",request_body=PlanUpdate,params(("id"=Uuid,Path)),security(("session"=[],"csrf"=[])),responses((status=200,body=PlanView),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=404,body=ErrorResponse),(status=409,body=ErrorResponse),(status=422,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn update_plan(
    State(s): State<AppState>,
    RequireRole(a): RequireRole<false>,
    id: Result<Path<Uuid>, PathRejection>,
    body: Result<Json<PlanUpdate>, JsonRejection>,
) -> Result<Json<PlanView>, ApiError> {
    let Path(id) = id.map_err(|_| invalid())?;
    let Json(b) = body.map_err(|_| invalid())?;
    Ok(Json(
        service(&s)
            .update_plan(a.user().id, id, b.revision, &b.details)
            .await?,
    ))
}
#[utoipa::path(get,path="/api/v1/admin/orders",params(OrdersQuery),security(("session"=[])),responses((status=200,body=OrderPage),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=422,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn admin_orders(
    State(s): State<AppState>,
    _: RequireRole<false>,
    q: Result<Query<OrdersQuery>, QueryRejection>,
) -> Result<Json<OrderPage>, ApiError> {
    let Query(q) = q.map_err(|_| invalid())?;
    Ok(Json(service(&s).orders(None, q.before).await?))
}
#[utoipa::path(post,path="/api/v1/admin/orders/{id}/mark-paid",request_body=PaidInput,params(("id"=Uuid,Path),("Idempotency-Key"=Uuid,Header)),security(("session"=[],"csrf"=[])),responses((status=200,body=OrderView),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=404,body=ErrorResponse),(status=409,body=ErrorResponse),(status=422,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn paid(
    State(s): State<AppState>,
    RequireRole(a): RequireRole<false>,
    id: Result<Path<Uuid>, PathRejection>,
    h: HeaderMap,
    body: Result<Json<PaidInput>, JsonRejection>,
) -> Result<Json<OrderView>, ApiError> {
    let Path(id) = id.map_err(|_| invalid())?;
    let Json(b) = body.map_err(|_| invalid())?;
    Ok(Json(
        service(&s).mark_paid(a.user().id, id, key(&h)?, &b).await?,
    ))
}
#[utoipa::path(get,path="/api/v1/admin/orders/{id}/refund-quote",params(("id"=Uuid,Path)),security(("session"=[])),responses((status=200,body=RefundQuote),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=404,body=ErrorResponse),(status=409,body=ErrorResponse),(status=422,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn refund_quote(
    State(s): State<AppState>,
    _: RequireRole<false>,
    id: Result<Path<Uuid>, PathRejection>,
) -> Result<Json<RefundQuote>, ApiError> {
    let Path(id) = id.map_err(|_| invalid())?;
    Ok(Json(service(&s).refund_quote(id).await?))
}
#[utoipa::path(post,path="/api/v1/admin/orders/{id}/refund",request_body=RefundInput,params(("id"=Uuid,Path),("Idempotency-Key"=Uuid,Header)),security(("session"=[],"csrf"=[])),responses((status=200,body=OrderView),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=404,body=ErrorResponse),(status=409,body=ErrorResponse),(status=422,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn refund(
    State(s): State<AppState>,
    RequireRole(a): RequireRole<false>,
    id: Result<Path<Uuid>, PathRejection>,
    h: HeaderMap,
    body: Result<Json<RefundInput>, JsonRejection>,
) -> Result<Json<OrderView>, ApiError> {
    let Path(id) = id.map_err(|_| invalid())?;
    let Json(b) = body.map_err(|_| invalid())?;
    Ok(Json(
        service(&s).refund(a.user().id, id, key(&h)?, &b).await?,
    ))
}
