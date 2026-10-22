#[path = "../../auth/tests/support/mod.rs"]
mod support;
#[path = "../../auth/tests/support/transient.rs"]
mod transient;
use atelier_app::{router, AppState};
use atelier_auth::{
    identity::{AuthFailure, AuthFuture, IdentityRepository, LoginContext, PublicConfig},
    login::LoginService,
    oidc_attempt::AttemptFlow,
    oidc_provider::{IdentityProvider, VerifiedIdentity},
    session::SessionSecrets,
};
use axum::{
    body::{to_bytes, Body},
    extract::ConnectInfo,
    http::{Request, StatusCode},
};
use std::{
    net::SocketAddr,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
};
use tower::ServiceExt;
struct Provider;
impl IdentityProvider for Provider {
    fn exchange(
        &self,
        code: String,
        verifier: String,
        nonce: String,
    ) -> AuthFuture<'_, VerifiedIdentity> {
        Box::pin(async move {
            if code != "valid-code" || verifier.len() < 43 || nonce.is_empty() {
                return Err(AuthFailure::Identity);
            }
            Ok(support::identity("sub", "user@gmail.com"))
        })
    }
}
#[derive(Default)]
struct Repo {
    calls: AtomicUsize,
    invite: Mutex<Option<String>>,
}
impl IdentityRepository for Repo {
    fn login(
        &self,
        _identity: VerifiedIdentity,
        context: LoginContext,
    ) -> AuthFuture<'_, SessionSecrets> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            *self.invite.lock().unwrap() = context.invite;
            Ok(SessionSecrets::generate().unwrap())
        })
    }
    fn public_config(&self) -> AuthFuture<'_, PublicConfig> {
        Box::pin(async {
            Ok(PublicConfig {
                registration_mode: "CLOSED".into(),
                version: "test".into(),
            })
        })
    }
}
fn fixture() -> (AppState, Arc<Repo>) {
    let mut state = AppState::test();
    let store = Arc::new(transient::MemoryTransient::default());
    let repo = Arc::new(Repo::default());
    state.login = Some(LoginService::new(
        AttemptFlow::new(
            store.clone(),
            "client-id".into(),
            "https://atelier.test/api/v1/auth/google/callback".into(),
        )
        .unwrap(),
        Arc::new(Provider),
        repo.clone(),
    ));
    state.limits = Some(store);
    (state, repo)
}
async fn get(state: AppState, url: &str, cookie: &str) -> axum::response::Response {
    let mut request = Request::get(url)
        .header("cookie", cookie)
        .body(Body::empty())
        .unwrap();
    request
        .extensions_mut()
        .insert(ConnectInfo("192.0.2.1:1234".parse::<SocketAddr>().unwrap()));
    router(state).oneshot(request).await.unwrap()
}
#[tokio::test]
async fn oidc_start_callback_replay_and_invite_binding_are_enforced_over_http() {
    let (state, repo) = fixture();
    let begin = get(
        state.clone(),
        "/api/v1/auth/google/start?invite=bound-code",
        "",
    )
    .await;
    assert_eq!(begin.status(), StatusCode::FOUND);
    assert_eq!(begin.headers()["cache-control"], "no-store");
    let location = url::Url::parse(begin.headers()["location"].to_str().unwrap()).unwrap();
    assert_eq!(location.host_str(), Some("accounts.google.com"));
    let oauth_state = location
        .query_pairs()
        .find(|(k, _)| k == "state")
        .unwrap()
        .1
        .into_owned();
    let cookie = begin.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let callback = format!("/api/v1/auth/google/callback?state={oauth_state}&code=valid-code&iss=https%3A%2F%2Faccounts.google.com");
    assert_eq!(
        get(state.clone(), &callback, "__Host-oidc=forged")
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let response = get(state.clone(), &callback, &cookie).await;
    assert_eq!(response.status(), StatusCode::SEE_OTHER);
    assert_eq!(response.headers()["location"], "/settings");
    assert!(response
        .headers()
        .get_all("set-cookie")
        .iter()
        .any(|v| v.to_str().unwrap().starts_with("__Host-sid=")));
    assert_eq!(repo.invite.lock().unwrap().as_deref(), Some("bound-code"));
    assert_eq!(
        get(state.clone(), &callback, &cookie).await.status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(repo.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        get(
            state.clone(),
            "/api/v1/auth/google/callback?code=forged",
            &cookie
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        get(
            state,
            "/api/v1/auth/google/callback?id_token=forged&role=SUPER_ADMIN",
            &cookie
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
}
#[tokio::test]
async fn callback_issuer_must_match_google_without_consuming_a_valid_attempt() {
    let (state, repo) = fixture();
    let begin = get(state.clone(), "/api/v1/auth/google/start", "").await;
    let location = url::Url::parse(begin.headers()["location"].to_str().unwrap()).unwrap();
    let oauth_state = location
        .query_pairs()
        .find(|(key, _)| key == "state")
        .unwrap()
        .1
        .into_owned();
    let cookie = begin.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let callback = format!("/api/v1/auth/google/callback?state={oauth_state}&code=valid-code");
    for issuer in [
        "",
        "&iss=",
        "&iss=https%3A%2F%2Fevil.test",
        "&iss=http%3A%2F%2Faccounts.google.com",
        "&iss=accounts.google.com",
        "&iss=https%3A%2F%2Faccounts.google.com%2F",
        "&iss=https%3A%2F%2Faccounts.google.com&iss=https%3A%2F%2Faccounts.google.com",
        "&iss=https%3A%2F%2Faccounts.google.com&id_token=forged",
    ] {
        assert_eq!(
            get(state.clone(), &format!("{callback}{issuer}"), &cookie)
                .await
                .status(),
            StatusCode::UNAUTHORIZED,
            "issuer suffix: {issuer}"
        );
        assert_eq!(repo.calls.load(Ordering::SeqCst), 0);
    }
    let valid = format!("{callback}&iss=https%3A%2F%2Faccounts.google.com&scope=openid%20email%20profile&authuser=0&prompt=none");
    assert_eq!(
        get(state.clone(), &valid, &cookie).await.status(),
        StatusCode::SEE_OTHER
    );
    assert_eq!(
        get(state, &valid, &cookie).await.status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(repo.calls.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn public_config_is_redacted_and_start_rate_is_not_bypassed_by_forwarded_headers() {
    let (state, _) = fixture();
    let response = get(state.clone(), "/api/v1/public/config", "").await;
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = to_bytes(response.into_body(), 4096).await.unwrap();
    let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(value.as_object().unwrap().len(), 2);
    assert_eq!(value["registration_mode"], "CLOSED");
    for _ in 0..20 {
        assert_eq!(
            get(state.clone(), "/api/v1/auth/google/start", "")
                .await
                .status(),
            StatusCode::FOUND
        );
    }
    let mut request = Request::get("/api/v1/auth/google/start")
        .header("x-forwarded-for", "198.51.100.9")
        .header("x-real-ip", "198.51.100.9")
        .body(Body::empty())
        .unwrap();
    request
        .extensions_mut()
        .insert(ConnectInfo("192.0.2.1:1234".parse::<SocketAddr>().unwrap()));
    let response = router(state).oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    assert!(response.headers().contains_key("retry-after"));
}

#[tokio::test]
async fn empty_optional_invitation_allows_existing_account_login_and_head_does_not_start() {
    let (state, _) = fixture();
    assert_eq!(
        get(state.clone(), "/api/v1/auth/google/start?invite=", "")
            .await
            .status(),
        StatusCode::FOUND
    );
    let response = router(state)
        .oneshot(
            Request::head("/api/v1/auth/google/start")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
}

#[tokio::test]
async fn only_allowlisted_proxy_can_provide_one_well_formed_client_ip() {
    let (mut state, _) = fixture();
    state.trusted_proxy_ips = Arc::new(std::collections::HashSet::from(["192.0.2.1"
        .parse()
        .unwrap()]));
    for (values, expected) in [
        (vec![], StatusCode::UNAUTHORIZED),
        (vec!["198.51.100.1"], StatusCode::FOUND),
        (vec!["invalid"], StatusCode::UNAUTHORIZED),
        (
            vec!["198.51.100.1", "198.51.100.2"],
            StatusCode::UNAUTHORIZED,
        ),
    ] {
        let mut builder = Request::get("/api/v1/auth/google/start");
        for value in values {
            builder = builder.header("x-real-ip", value);
        }
        let mut request = builder.body(Body::empty()).unwrap();
        request
            .extensions_mut()
            .insert(ConnectInfo("192.0.2.1:1234".parse::<SocketAddr>().unwrap()));
        assert_eq!(
            router(state.clone())
                .oneshot(request)
                .await
                .unwrap()
                .status(),
            expected
        );
    }
}
