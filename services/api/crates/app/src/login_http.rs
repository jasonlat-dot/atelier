use crate::{auth_http::AuthUser, AppState};
use atelier_auth::{
    identity::{AuthFailure, LoginContext, PublicConfig},
    mfa::{MfaCode, MfaSetup},
    session::token_hash,
};
use atelier_common::{ApiError, ErrorResponse};
use axum::{
    extract::{
        rejection::{JsonRejection, QueryRejection},
        ConnectInfo, Query, State,
    },
    http::{header, HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde::Deserialize;
use std::net::{IpAddr, SocketAddr};
pub fn failure(error: AuthFailure) -> Response {
    let mut response = ApiError::from(error).into_response();
    if let AuthFailure::Rate(seconds) = error {
        if let Ok(value) = seconds.to_string().parse() {
            response.headers_mut().insert(header::RETRY_AFTER, value);
        }
    }
    response
}
fn client_ip(
    state: &AppState,
    connection: Option<Extension<ConnectInfo<SocketAddr>>>,
    headers: &HeaderMap,
) -> Result<IpAddr, AuthFailure> {
    let Some(Extension(ConnectInfo(peer))) = connection else {
        return Err(AuthFailure::Store);
    };
    if !state.trusted_proxy_ips.contains(&peer.ip()) {
        return Ok(peer.ip());
    }
    let mut values = headers.get_all("x-real-ip").iter();
    let ip = values
        .next()
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .ok_or(AuthFailure::State)?;
    if values.next().is_some() {
        return Err(AuthFailure::State);
    }
    Ok(ip)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Start {
    invite: Option<String>,
}
#[utoipa::path(get,path="/api/v1/auth/google/start",params(("invite"=Option<String>,Query)),responses((status=302,description="Redirect to Google; secure browser binding cookie"),(status=401,body=ErrorResponse),(status=429,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn google_start(
    State(state): State<AppState>,
    method: Method,
    connection: Option<Extension<ConnectInfo<SocketAddr>>>,
    headers: HeaderMap,
    query: Result<Query<Start>, QueryRejection>,
) -> Response {
    if method != Method::GET {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    let result = async {
        let Query(query) = query.map_err(|_| AuthFailure::State)?;
        if headers
            .get("sec-fetch-site")
            .is_some_and(|v| v == "cross-site")
        {
            return Err(AuthFailure::Forbidden);
        }
        let ip = client_ip(&state, connection, &headers)?;
        let started = state
            .login
            .as_ref()
            .ok_or(AuthFailure::Store)?
            .begin(ip, query.invite.filter(|v| !v.is_empty()))
            .await?;
        Ok((
            StatusCode::FOUND,
            [
                (header::LOCATION, started.authorization_url),
                (header::SET_COOKIE, started.browser_cookie),
            ],
        )
            .into_response())
    }
    .await;
    match result {
        Ok(r) => r,
        Err(e) => failure(e),
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Callback {
    iss: String,
    state: Option<String>,
    code: Option<String>,
    error: Option<String>,
    #[serde(rename = "error_description")]
    _description: Option<String>,
    #[serde(rename = "scope")]
    _scope: Option<String>,
    #[serde(rename = "authuser")]
    _authuser: Option<String>,
    #[serde(rename = "prompt")]
    _prompt: Option<String>,
}
fn browser_cookie(headers: &HeaderMap) -> Result<String, AuthFailure> {
    let mut value = None;
    for header in headers.get_all(header::COOKIE) {
        for pair in header.to_str().map_err(|_| AuthFailure::State)?.split(';') {
            if let Some((name, v)) = pair.trim().split_once('=') {
                if name == "__Host-oidc" && value.replace(v.to_string()).is_some() {
                    return Err(AuthFailure::State);
                }
            }
        }
    }
    value.ok_or(AuthFailure::State)
}
#[utoipa::path(get,path="/api/v1/auth/google/callback",params(("iss"=String,Query,description="Must exactly equal https://accounts.google.com"),("state"=String,Query),("code"=Option<String>,Query)),responses((status=303,description="Session issued; redirect to settings"),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=409,body=ErrorResponse),(status=429,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn google_callback(
    State(state): State<AppState>,
    method: Method,
    connection: Option<Extension<ConnectInfo<SocketAddr>>>,
    headers: HeaderMap,
    query: Result<Query<Callback>, QueryRejection>,
) -> Response {
    if method != Method::GET {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    let result = async {
        let Query(query) = query.map_err(|_| AuthFailure::State)?;
        // RFC 9207: Google always supplies its issuer. Check before consuming state
        // or sending the authorization code to the fixed token endpoint.
        if query.iss != "https://accounts.google.com" {
            return Err(AuthFailure::State);
        }
        let browser = browser_cookie(&headers)?;
        let ip = client_ip(&state, connection, &headers)?;
        let context = LoginContext {
            ip,
            user_agent: headers
                .get(header::USER_AGENT)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .chars()
                .take(512)
                .collect(),
            invite: None,
            previous_token_hash: token_hash(&headers).ok(),
        };
        let code = if query.error.is_some() {
            String::new()
        } else {
            query.code.unwrap_or_default()
        };
        let secrets = state
            .login
            .as_ref()
            .ok_or(AuthFailure::Store)?
            .callback(
                query.state.as_deref().ok_or(AuthFailure::State)?,
                &browser,
                code,
                context,
            )
            .await?;
        let mut response =
            (StatusCode::SEE_OTHER, [(header::LOCATION, "/settings")]).into_response();
        response.headers_mut().append(
            header::SET_COOKIE,
            secrets.cookie().parse().map_err(|_| AuthFailure::Store)?,
        );
        response.headers_mut().append(
            header::SET_COOKIE,
            "__Host-oidc=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0"
                .parse()
                .expect("static cookie"),
        );
        Ok(response)
    }
    .await;
    match result {
        Ok(r) => r,
        Err(e) => failure(e),
    }
}
#[utoipa::path(get,path="/api/v1/public/config",responses((status=200,body=PublicConfig),(status=503,body=ErrorResponse)))]
pub async fn public_config(State(state): State<AppState>) -> Response {
    match state.login {
        Some(login) => match login.public_config().await {
            Ok(config) => Json(config).into_response(),
            Err(e) => failure(e),
        },
        None => failure(AuthFailure::Store),
    }
}
#[utoipa::path(post,path="/api/v1/admin/mfa/setup",security(("session"=[],"csrf"=[])),responses((status=200,body=MfaSetup),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=429,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn mfa_setup(State(state): State<AppState>, AuthUser(actor): AuthUser) -> Response {
    if actor.user().role == atelier_auth::policy::Role::User {
        return failure(AuthFailure::Forbidden);
    }
    match state.mfa {
        Some(mfa) => match mfa.setup(&actor).await {
            Ok(setup) => Json(setup).into_response(),
            Err(e) => failure(e),
        },
        None => failure(AuthFailure::Store),
    }
}
#[utoipa::path(post,path="/api/v1/admin/mfa/verify",request_body=MfaCode,security(("session"=[],"csrf"=[])),responses((status=204),(status=401,body=ErrorResponse),(status=403,body=ErrorResponse),(status=422,body=ErrorResponse),(status=429,body=ErrorResponse),(status=503,body=ErrorResponse)))]
pub async fn mfa_verify(
    State(state): State<AppState>,
    AuthUser(actor): AuthUser,
    body: Result<Json<MfaCode>, JsonRejection>,
) -> Response {
    if actor.user().role == atelier_auth::policy::Role::User {
        return failure(AuthFailure::Forbidden);
    }
    let Ok(Json(body)) = body else {
        return ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "VALIDATION",
            "Expected a six digit code only",
        )
        .into_response();
    };
    match state.mfa {
        Some(mfa) => match mfa.verify(&actor, &body.code).await {
            Ok(()) => StatusCode::NO_CONTENT.into_response(),
            Err(e) => failure(e),
        },
        None => failure(AuthFailure::Store),
    }
}
pub async fn private_response(
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
        .headers_mut()
        .insert(header::REFERRER_POLICY, "no-referrer".parse().unwrap());
    response
}

pub fn private_error(error: AuthFailure) -> Response {
    let mut response = failure(error);
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
}
