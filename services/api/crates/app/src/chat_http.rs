use crate::{auth_http::AuthUser, AppState};
use atelier_chat::*;
use atelier_common::{ApiError, ErrorResponse};
use axum::{
    extract::{
        rejection::{JsonRejection, PathRejection, QueryRejection},
        Path, Query, State,
    },
    http::{HeaderMap, StatusCode},
    response::{
        sse::{Event, KeepAlive},
        IntoResponse, Response, Sse,
    },
    Json,
};
use serde::Deserialize;
use std::{convert::Infallible, sync::Arc, time::Duration};
use uuid::Uuid;
fn service(s: &AppState) -> Result<&ChatService, ApiError> {
    s.chat.as_ref().ok_or_else(|| ChatError::Store.into())
}
fn invalid() -> ApiError {
    ChatError::Validation.into()
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
async fn rate(s: &AppState, owner: Uuid) -> Result<(), ApiError> {
    let store = s
        .limits
        .as_ref()
        .ok_or_else(|| ApiError::from(ChatError::Store))?;
    match store
        .rate_limit(
            format!("chat:write:{owner}"),
            atelier_auth::transient::RateRule {
                limit: 30,
                window_seconds: 60,
            },
        )
        .await
    {
        Ok(atelier_auth::transient::RateDecision::Allowed) => Ok(()),
        Ok(_) => Err(ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "TOO_MANY_REQUESTS",
            "Please retry later",
        )),
        Err(_) => Err(ChatError::Store.into()),
    }
}
#[derive(Deserialize, utoipa::IntoParams)]
#[serde(deny_unknown_fields)]
pub struct ChatQuery {
    pub before: Option<Uuid>,
}
#[utoipa::path(get,path="/api/v1/chat/config",security(("session"=[])),responses((status=200,body=ChatConfig),(status=401,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn config(
    State(s): State<AppState>,
    _actor: AuthUser,
) -> Result<Json<ChatConfig>, ApiError> {
    Ok(Json(service(&s)?.config().await?))
}
#[utoipa::path(get,path="/api/v1/chat/conversations",params(ChatQuery),security(("session"=[])),responses((status=200,body=ConversationPage),(status=401,body=ErrorResponse),(status=422,body=ErrorResponse)))]
pub async fn list(
    State(s): State<AppState>,
    AuthUser(actor): AuthUser,
    q: Result<Query<ChatQuery>, QueryRejection>,
) -> Result<Json<ConversationPage>, ApiError> {
    let Query(q) = q.map_err(|_| invalid())?;
    Ok(Json(service(&s)?.list(actor.user().id, q.before).await?))
}
#[utoipa::path(post,path="/api/v1/chat/conversations",request_body=ConversationInput,params(("Idempotency-Key"=Uuid,Header)),security(("session"=[],"csrf"=[])),responses((status=201,body=Conversation),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=409,body=ErrorResponse),(status=422,body=ErrorResponse),(status=429,body=ErrorResponse)))]
pub async fn create(
    State(s): State<AppState>,
    AuthUser(actor): AuthUser,
    headers: HeaderMap,
    body: Result<Json<ConversationInput>, JsonRejection>,
) -> Result<(StatusCode, Json<Conversation>), ApiError> {
    let Json(input) = body.map_err(|_| invalid())?;
    rate(&s, actor.user().id).await?;
    Ok((
        StatusCode::CREATED,
        Json(
            service(&s)?
                .create(actor.user().id, key(&headers)?, input)
                .await?,
        ),
    ))
}
#[utoipa::path(get,path="/api/v1/chat/conversations/{id}",params(("id"=Uuid,Path),ChatQuery),security(("session"=[])),responses((status=200,body=ConversationView),(status=401,body=ErrorResponse),(status=404,body=ErrorResponse)))]
pub async fn get_one(
    State(s): State<AppState>,
    AuthUser(actor): AuthUser,
    path: Result<Path<Uuid>, PathRejection>,
    q: Result<Query<ChatQuery>, QueryRejection>,
) -> Result<Json<ConversationView>, ApiError> {
    let Path(id) = path.map_err(|_| invalid())?;
    let Query(q) = q.map_err(|_| invalid())?;
    Ok(Json(service(&s)?.get(actor.user().id, id, q.before).await?))
}
#[utoipa::path(patch,path="/api/v1/chat/conversations/{id}",request_body=ConversationInput,params(("id"=Uuid,Path)),security(("session"=[],"csrf"=[])),responses((status=200,body=Conversation),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=404,body=ErrorResponse),(status=422,body=ErrorResponse)))]
pub async fn rename(
    State(s): State<AppState>,
    AuthUser(actor): AuthUser,
    path: Result<Path<Uuid>, PathRejection>,
    body: Result<Json<ConversationInput>, JsonRejection>,
) -> Result<Json<Conversation>, ApiError> {
    let Path(id) = path.map_err(|_| invalid())?;
    let Json(input) = body.map_err(|_| invalid())?;
    rate(&s, actor.user().id).await?;
    Ok(Json(service(&s)?.rename(actor.user().id, id, input).await?))
}
#[utoipa::path(delete,path="/api/v1/chat/conversations/{id}",params(("id"=Uuid,Path)),security(("session"=[],"csrf"=[])),responses((status=204),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=404,body=ErrorResponse)))]
pub async fn delete_one(
    State(s): State<AppState>,
    AuthUser(actor): AuthUser,
    path: Result<Path<Uuid>, PathRejection>,
) -> Result<StatusCode, ApiError> {
    let Path(id) = path.map_err(|_| invalid())?;
    rate(&s, actor.user().id).await?;
    service(&s)?.delete(actor.user().id, id).await?;
    Ok(StatusCode::NO_CONTENT)
}
#[utoipa::path(post,path="/api/v1/chat/turns/{id}/cancel",params(("id"=Uuid,Path)),security(("session"=[],"csrf"=[])),responses((status=204),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=404,body=ErrorResponse)))]
pub async fn cancel(
    State(s): State<AppState>,
    AuthUser(actor): AuthUser,
    path: Result<Path<Uuid>, PathRejection>,
) -> Result<StatusCode, ApiError> {
    let Path(id) = path.map_err(|_| invalid())?;
    rate(&s, actor.user().id).await?;
    service(&s)?.cancel(actor.user().id, id).await?;
    Ok(StatusCode::NO_CONTENT)
}
fn event(value: ChatEvent) -> Result<Event, Infallible> {
    let encoded = serde_json::to_value(value).expect("typed chat event");
    Ok(Event::default()
        .event(encoded["event"].as_str().unwrap_or("error"))
        .json_data(&encoded["data"])
        .expect("typed event JSON"))
}
#[utoipa::path(post,path="/api/v1/chat/conversations/{id}/messages",request_body=SendMessage,params(("id"=Uuid,Path),("Idempotency-Key"=Uuid,Header)),security(("session"=[],"csrf"=[])),responses((status=200,description="SSE: delta, intent, action, done, error. ChatEvent schema defines payloads",body=String,content_type="text/event-stream"),(status=401,body=ErrorResponse),(status=402,body=ErrorResponse),(status=403,body=ErrorResponse),(status=404,body=ErrorResponse),(status=409,body=ErrorResponse),(status=422,body=ErrorResponse),(status=429,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn send(
    State(s): State<AppState>,
    AuthUser(actor): AuthUser,
    path: Result<Path<Uuid>, PathRejection>,
    headers: HeaderMap,
    body: Result<Json<SendMessage>, JsonRejection>,
) -> Result<Response, ApiError> {
    let Path(id) = path.map_err(|_| invalid())?;
    let Json(input) = body.map_err(|_| invalid())?;
    rate(&s, actor.user().id).await?;
    let service = service(&s)?.clone();
    let owner = actor.user().id;
    let (sender, receiver) = tokio::sync::mpsc::channel(1);
    let start = service.start(owner, id, key(&headers)?, input).await?;
    match start {
        Start::Replay(turn) => {
            let turn = *turn;
            tokio::spawn(async move {
                let _ = sender
                    .send(ChatEvent::Delta(ChatDelta {
                        turn_id: turn.id,
                        text: turn.reply.clone(),
                    }))
                    .await;
                if let Some(intent) = turn.intent {
                    let _ = sender.send(ChatEvent::Intent(intent)).await;
                }
                if let Some(action) = &turn.action {
                    let _ = sender.send(ChatEvent::Action(action.clone())).await;
                }
                let _ = sender.send(ChatEvent::Done(turn)).await;
            });
        }
        Start::Running { turn, token } => {
            let authorized: Authorization = Arc::new(move || {
                let auth = s.auth.clone();
                let headers = headers.clone();
                Box::pin(async move {
                    match auth.authenticate("GET", &headers).await {
                        Ok(actor) => {
                            actor.user().id == owner
                                && (actor.user().role == atelier_auth::policy::Role::User
                                    || actor
                                        .require_admin(atelier_auth::policy::Role::Admin)
                                        .is_ok())
                        }
                        Err(_) => false,
                    }
                })
            });
            tokio::spawn(async move {
                service.reply(owner, turn, token, sender, authorized).await;
            });
        }
    }
    let stream = futures_util::stream::unfold(receiver, |mut receiver| async move {
        receiver.recv().await.map(|value| (event(value), receiver))
    });
    let mut response = Sse::new(stream)
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(10)))
        .into_response();
    response.headers_mut().insert(
        "X-Accel-Buffering",
        axum::http::HeaderValue::from_static("no"),
    );
    Ok(response)
}
