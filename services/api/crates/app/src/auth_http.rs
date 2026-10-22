use crate::AppState;
use atelier_auth::{policy::Role, service::AuthenticatedSession};
use atelier_common::ApiError;
use axum::{
    extract::{FromRequestParts, Request, State},
    http::{header, request::Parts, HeaderValue},
    middleware::Next,
    response::{IntoResponse, Response},
};

pub struct AuthUser(pub AuthenticatedSession);
impl FromRequestParts<AppState> for AuthUser {
    type Rejection = ApiError;
    async fn from_request_parts(
        parts: &mut Parts,
        _state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        parts
            .extensions
            .get::<AuthenticatedSession>()
            .cloned()
            .map(Self)
            .ok_or_else(ApiError::unauthenticated)
    }
}

pub struct RequireRole<const SUPER: bool>(pub AuthenticatedSession);
impl<const SUPER: bool> FromRequestParts<AppState> for RequireRole<SUPER> {
    type Rejection = ApiError;
    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let AuthUser(actor) = AuthUser::from_request_parts(parts, state).await?;
        actor
            .require_admin(if SUPER { Role::SuperAdmin } else { Role::Admin })
            .map_err(ApiError::from)?;
        Ok(Self(actor))
    }
}

pub async fn require_session(
    State(state): State<AppState>,
    mut request: Request,
    next: Next,
) -> Response {
    // HTTP/2 authority is a trusted input only after matching configured origin.
    let mut headers = request.headers().clone();
    if !headers.contains_key(header::HOST) {
        if let Some(authority) = request.uri().authority() {
            if let Ok(value) = HeaderValue::from_str(authority.as_str()) {
                headers.insert(header::HOST, value);
            }
        }
    }
    let authenticated = state
        .auth
        .authenticate(request.method().as_str(), &headers)
        .await;
    let mut response = match authenticated {
        Err(error) => ApiError::from(error).into_response(),
        Ok(actor) => {
            // Me and logout remain reachable for MFA enrollment UX and safe exit.
            let path = request.uri().path();
            let enrollment_entry = (path == "/api/v1/me" && request.method() == "GET")
                || path == "/api/v1/auth/logout"
                || path == "/api/v1/admin/mfa/setup"
                || path == "/api/v1/admin/mfa/verify";
            let mfa_check = if actor.user().role != Role::User && !enrollment_entry {
                actor.require_admin(Role::Admin)
            } else {
                Ok(())
            };
            match mfa_check {
                Err(error) => ApiError::from(error).into_response(),
                Ok(()) => {
                    if request.method() != "GET"
                        && actor.user().role != Role::User
                        && (path == "/api/v1/admin"
                            || path == "/api/admin"
                            || path.starts_with("/api/v1/admin/")
                            || path.starts_with("/api/admin/"))
                    {
                        let result = match &state.limits {
                            Some(limits) => limits
                                .rate_limit(
                                    format!("auth:admin-write:{}", actor.user().id),
                                    atelier_auth::transient::ADMIN_WRITE_RATE,
                                )
                                .await
                                .map_err(|_| atelier_auth::identity::AuthFailure::Store),
                            None => Err(atelier_auth::identity::AuthFailure::Store),
                        };
                        match result {
                            Ok(atelier_auth::transient::RateDecision::Allowed) => {}
                            Ok(atelier_auth::transient::RateDecision::Limited {
                                retry_after_seconds,
                            }) => {
                                return crate::login_http::private_error(
                                    atelier_auth::identity::AuthFailure::Rate(retry_after_seconds),
                                )
                            }
                            Err(e) => return crate::login_http::private_error(e),
                        }
                    }
                    request.extensions_mut().insert(actor);
                    next.run(request).await
                }
            }
        }
    };
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}
