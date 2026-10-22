use atelier_app::{router, AppState};
use atelier_auth::{
    policy::{Role, SessionWindow, UserStatus},
    repository::{RepoFuture, RepositoryError, SessionRecord, SessionRepository},
    service::{PublicOrigin, SessionService},
    session::SessionSecrets,
    views::{DeviceSession, SessionUser},
};
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use chrono::{Duration, Utc};
use std::sync::{Arc, Mutex};
use tower::ServiceExt;
use uuid::Uuid;

struct FakeRepository {
    record: Mutex<SessionRecord>,
    fail: bool,
    deny_touch: std::sync::atomic::AtomicBool,
}
impl SessionRepository for FakeRepository {
    fn lookup(&self, hash: [u8; 32]) -> RepoFuture<'_, Option<SessionRecord>> {
        Box::pin(async move {
            if self.fail {
                return Err(RepositoryError);
            }
            let record = self.record.lock().unwrap();
            Ok((record.token_hash == hash).then(|| record.clone()))
        })
    }
    fn touch(
        &self,
        hash: [u8; 32],
        role: Role,
        now: chrono::DateTime<Utc>,
    ) -> RepoFuture<'_, bool> {
        Box::pin(async move {
            let mut record = self.record.lock().unwrap();
            if self.deny_touch.load(std::sync::atomic::Ordering::Acquire) {
                return Ok(false);
            }
            if record.token_hash != hash
                || record.window.revoked
                || record.user.role != role
                || record.status != UserStatus::Active
            {
                return Ok(false);
            }
            record.window.last_seen_at = now;
            Ok(true)
        })
    }
    fn rename(&self, owner: Uuid, name: String) -> RepoFuture<'_, bool> {
        Box::pin(async move {
            let mut record = self.record.lock().unwrap();
            if record.user.id != owner {
                return Ok(false);
            }
            record.user.display_name = name;
            Ok(true)
        })
    }
    fn revoke_all(&self, owner: Uuid) -> RepoFuture<'_, ()> {
        Box::pin(async move {
            let mut record = self.record.lock().unwrap();
            if record.user.id == owner {
                record.window.revoked = true;
            }
            Ok(())
        })
    }
    fn devices(
        &self,
        owner: Uuid,
        current: Uuid,
        _now: chrono::DateTime<Utc>,
    ) -> RepoFuture<'_, Vec<DeviceSession>> {
        Box::pin(async move {
            let record = self.record.lock().unwrap();
            Ok(if owner == record.user.id {
                vec![DeviceSession {
                    id: record.id,
                    created_at: record.window.created_at,
                    last_seen_at: record.window.last_seen_at,
                    user_agent: Some("test browser".into()),
                    ip: None,
                    current: current == record.id,
                }]
            } else {
                vec![]
            })
        })
    }
    fn revoke_device(&self, owner: Uuid, device: Uuid) -> RepoFuture<'_, bool> {
        Box::pin(async move {
            let mut record = self.record.lock().unwrap();
            if record.user.id != owner || record.id != device {
                return Ok(false);
            }
            record.window.revoked = true;
            Ok(true)
        })
    }
}
fn fixture() -> (AppState, Arc<FakeRepository>, String, String) {
    let secrets = SessionSecrets::generate().unwrap();
    let now = Utc::now();
    let repository = Arc::new(FakeRepository {
        record: Mutex::new(SessionRecord {
            id: Uuid::new_v4(),
            token_hash: secrets.token_hash(),
            user: SessionUser {
                id: Uuid::new_v4(),
                email: "test@gmail.com".into(),
                display_name: "Test".into(),
                role: Role::User,
                mfa_enabled: false,
            },
            status: UserStatus::Active,
            csrf_token: secrets.csrf_token().into(),
            mfa_verified_at: None,
            window: SessionWindow {
                created_at: now - Duration::days(1),
                last_seen_at: now - Duration::hours(1),
                expires_at: now + Duration::days(29),
                revoked: false,
            },
        }),
        fail: false,
        deny_touch: std::sync::atomic::AtomicBool::new(false),
    });
    let mut state = AppState::test();
    state.auth = SessionService::new(
        repository.clone(),
        PublicOrigin::parse("https://atelier.test").unwrap(),
    );
    (
        state,
        repository,
        secrets.cookie().split(';').next().unwrap().into(),
        secrets.csrf_token().into(),
    )
}
async fn request(
    state: AppState,
    method: &str,
    path: &str,
    cookie: &str,
    origin: Option<&str>,
    csrf: Option<&str>,
    body: &str,
) -> axum::response::Response {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("Host", "atelier.test")
        .header("Cookie", cookie)
        .header("Content-Type", "application/json");
    if let Some(origin) = origin {
        request = request.header("Origin", origin);
    }
    if let Some(csrf) = csrf {
        request = request.header("X-CSRF-Token", csrf);
    }
    router(state)
        .oneshot(request.body(Body::from(body.to_owned())).unwrap())
        .await
        .unwrap()
}
async fn json(response: axum::response::Response) -> serde_json::Value {
    serde_json::from_slice(&to_bytes(response.into_body(), 16000).await.unwrap()).unwrap()
}

#[tokio::test]
async fn me_is_database_owned_and_sensitive_data_is_never_serialized() {
    let (state, repo, cookie, csrf) = fixture();
    let response = request(state, "GET", "/api/v1/me", &cookie, None, None, "").await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["cache-control"], "no-store");
    let value = json(response).await;
    assert_eq!(
        value["user"]["id"],
        repo.record.lock().unwrap().user.id.to_string()
    );
    assert_eq!(value["user"]["role"], "USER");
    assert_eq!(value["csrf_token"], csrf);
    for key in [
        "token_hash",
        "mfa_secret_enc",
        "google_sub",
        "id_token",
        "credits",
    ] {
        assert!(!value.to_string().contains(key), "{key}");
    }
}

#[tokio::test]
async fn expiry_revocation_and_current_database_status_are_enforced_each_request() {
    let (state, repo, cookie, _) = fixture();
    assert_eq!(
        request(state.clone(), "GET", "/api/v1/me", &cookie, None, None, "")
            .await
            .status(),
        StatusCode::OK
    );
    repo.record.lock().unwrap().status = UserStatus::Disabled;
    let response = request(state, "GET", "/api/v1/me", &cookie, None, None, "").await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_eq!(json(response).await["error"]["code"], "ACCOUNT_DISABLED");
    for mode in ["revoked", "idle", "absolute", "unknown"] {
        let (state, repo, cookie, _) = fixture();
        {
            let mut record = repo.record.lock().unwrap();
            match mode {
                "revoked" => record.window.revoked = true,
                "idle" => record.window.last_seen_at = Utc::now() - Duration::days(7),
                "absolute" => record.window.created_at = Utc::now() - Duration::days(30),
                _ => record.token_hash = [0; 32],
            };
        }
        assert_eq!(
            request(state, "GET", "/api/v1/me", &cookie, None, None, "")
                .await
                .status(),
            StatusCode::UNAUTHORIZED,
            "{mode}"
        );
    }
}

#[tokio::test]
async fn csrf_guards_every_mutation_and_admin_role_cannot_come_from_json() {
    let (state, repo, cookie, csrf) = fixture();
    for (origin, supplied) in [
        (None, Some(csrf.as_str())),
        (Some("https://evil.test"), Some(csrf.as_str())),
        (Some("https://atelier.test"), None),
        (Some("https://atelier.test"), Some("forged")),
    ] {
        assert_eq!(
            request(
                state.clone(),
                "PATCH",
                "/api/v1/me",
                &cookie,
                origin,
                supplied,
                r#"{"display_name":"Hacked"}"#
            )
            .await
            .status(),
            StatusCode::FORBIDDEN
        );
    }
    assert_eq!(repo.record.lock().unwrap().user.display_name, "Test");
    let response = request(
        state.clone(),
        "PATCH",
        "/api/v1/me",
        &cookie,
        Some("https://atelier.test"),
        Some(&csrf),
        r#"{"display_name":"Hacked","role":"SUPER_ADMIN","credits":99999}"#,
    )
    .await;
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(repo.record.lock().unwrap().user.role, Role::User);
    assert_eq!(
        request(
            state.clone(),
            "GET",
            "/api/v1/admin/users",
            &cookie,
            None,
            None,
            ""
        )
        .await
        .status(),
        StatusCode::FORBIDDEN
    );
    let response = request(
        state,
        "PATCH",
        "/api/v1/me",
        &cookie,
        Some("https://atelier.test"),
        Some(&csrf),
        r#"{"display_name":"  Updated  "}"#,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(json(response).await["user"]["display_name"], "Updated");
}

#[tokio::test]
async fn admin_routes_require_recent_mfa_and_re_read_roles() {
    let (state, repo, cookie, _) = fixture();
    {
        let mut record = repo.record.lock().unwrap();
        record.user.role = Role::Admin;
    }
    let response = request(
        state.clone(),
        "GET",
        "/api/v1/admin/users",
        &cookie,
        None,
        None,
        "",
    )
    .await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_eq!(json(response).await["error"]["code"], "MFA_REQUIRED");
    {
        let mut record = repo.record.lock().unwrap();
        record.user.mfa_enabled = true;
        record.mfa_verified_at = Some(Utc::now());
    }
    assert_eq!(
        request(
            state.clone(),
            "GET",
            "/api/v1/admin/users",
            &cookie,
            None,
            None,
            ""
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    repo.record.lock().unwrap().user.role = Role::User;
    assert_eq!(
        request(state, "GET", "/api/v1/admin/users", &cookie, None, None, "")
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn device_revocation_is_scoped_and_logout_revokes_session_and_cookie() {
    let (state, repo, cookie, csrf) = fixture();
    let response = request(
        state.clone(),
        "GET",
        "/api/v1/me/sessions",
        &cookie,
        None,
        None,
        "",
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let value = json(response).await;
    assert_eq!(value["sessions"][0]["current"], true);
    assert!(!value.to_string().contains("token_hash"));
    let foreign = format!("/api/v1/me/sessions/{}", Uuid::new_v4());
    assert_eq!(
        request(
            state.clone(),
            "DELETE",
            &foreign,
            &cookie,
            Some("https://atelier.test"),
            Some(&csrf),
            ""
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    assert!(!repo.record.lock().unwrap().window.revoked);
    let response = request(
        state.clone(),
        "POST",
        "/api/v1/auth/logout",
        &cookie,
        Some("https://atelier.test"),
        Some(&csrf),
        "",
    )
    .await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert!(response.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .contains("Max-Age=0"));
    assert_eq!(
        request(state, "GET", "/api/v1/me", &cookie, None, None, "")
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn origin_host_and_duplicate_headers_must_all_match() {
    let (state, repo, cookie, csrf) = fixture();
    for host in [
        "evil.test",
        "atelier.test/",
        "atelier.test.evil",
        "atelier.test:444",
    ] {
        let request = Request::builder()
            .method("PATCH")
            .uri("/api/v1/me")
            .header("Host", host)
            .header("Cookie", &cookie)
            .header("Origin", "https://atelier.test")
            .header("X-CSRF-Token", &csrf)
            .header("Content-Type", "application/json")
            .body(Body::from(r#"{"display_name":"Hacked"}"#))
            .unwrap();
        assert_eq!(
            router(state.clone())
                .oneshot(request)
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN,
            "{host}"
        );
    }
    let request = Request::builder()
        .method("PATCH")
        .uri("/api/v1/me")
        .header("Host", "atelier.test")
        .header("Cookie", &cookie)
        .header("Origin", "https://atelier.test")
        .header("Origin", "https://evil.test")
        .header("X-CSRF-Token", &csrf)
        .header("Content-Type", "application/json")
        .body(Body::from(r#"{"display_name":"Hacked"}"#))
        .unwrap();
    assert_eq!(
        router(state).oneshot(request).await.unwrap().status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(repo.record.lock().unwrap().user.display_name, "Test");
}

#[tokio::test]
async fn invalid_names_do_not_mutate_and_unicode_limit_counts_characters() {
    let (state, repo, cookie, csrf) = fixture();
    for name in ["   ".to_string(), "界".repeat(101), "bad\nname".into()] {
        let body = serde_json::json!({"display_name":name}).to_string();
        assert_eq!(
            request(
                state.clone(),
                "PATCH",
                "/api/v1/me",
                &cookie,
                Some("https://atelier.test"),
                Some(&csrf),
                &body
            )
            .await
            .status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }
    assert_eq!(repo.record.lock().unwrap().user.display_name, "Test");
    let body = serde_json::json!({"display_name":"界".repeat(100)}).to_string();
    assert_eq!(
        request(
            state,
            "PATCH",
            "/api/v1/me",
            &cookie,
            Some("https://atelier.test"),
            Some(&csrf),
            &body
        )
        .await
        .status(),
        StatusCode::OK
    );
}

#[tokio::test]
async fn current_device_revocation_clears_cookie_and_repository_failure_fails_closed() {
    let (state, repo, cookie, csrf) = fixture();
    let id = repo.record.lock().unwrap().id;
    let response = request(
        state.clone(),
        "DELETE",
        &format!("/api/v1/me/sessions/{id}"),
        &cookie,
        Some("https://atelier.test"),
        Some(&csrf),
        "",
    )
    .await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert!(response.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .contains("Max-Age=0"));
    assert_eq!(
        request(state, "GET", "/api/v1/me", &cookie, None, None, "")
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let (mut state, repo, cookie, _) = fixture();
    state.auth = SessionService::new(
        Arc::new(FakeRepository {
            record: Mutex::new(repo.record.lock().unwrap().clone()),
            fail: true,
            deny_touch: std::sync::atomic::AtomicBool::new(false),
        }),
        PublicOrigin::parse("https://atelier.test").unwrap(),
    );
    let response = request(state, "GET", "/api/v1/me", &cookie, None, None, "").await;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(json(response).await["error"]["code"], "SERVICE_UNAVAILABLE");
}

#[tokio::test]
async fn super_admin_permission_is_distinct_and_mfa_expiry_is_enforced_over_http() {
    let (state, repo, cookie, _) = fixture();
    {
        let mut row = repo.record.lock().unwrap();
        row.user.role = Role::Admin;
        row.user.mfa_enabled = true;
        row.mfa_verified_at = Some(Utc::now());
    }
    assert_eq!(
        request(
            state.clone(),
            "GET",
            "/api/v1/admin/settings",
            &cookie,
            None,
            None,
            ""
        )
        .await
        .status(),
        StatusCode::FORBIDDEN
    );
    repo.record.lock().unwrap().user.role = Role::SuperAdmin;
    assert_eq!(
        request(
            state.clone(),
            "GET",
            "/api/v1/admin/settings",
            &cookie,
            None,
            None,
            ""
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    repo.record.lock().unwrap().mfa_verified_at = Some(Utc::now() - Duration::hours(12));
    assert_eq!(
        request(
            state.clone(),
            "GET",
            "/api/v1/admin/settings",
            &cookie,
            None,
            None,
            ""
        )
        .await
        .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        json(request(state, "GET", "/api/v1/me", &cookie, None, None, "").await).await
            ["mfa_required"],
        true
    );
}

#[test]
fn public_origin_never_trusts_userinfo_external_http_or_paths() {
    for value in [
        "https://atelier.test/path",
        "https://user@atelier.test",
        "https://atelier.test?secret=x",
        "https://atelier.test#fragment",
        "http://evil.test",
        "file:///tmp/x",
        "https:///",
        "http://localhost.evil",
    ] {
        assert!(PublicOrigin::parse(value).is_err(), "{value}");
    }
    assert_eq!(
        PublicOrigin::parse("https://Atelier.Test:443/")
            .unwrap()
            .as_str(),
        "https://atelier.test"
    );
    for value in [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://[::1]:5173",
    ] {
        assert!(PublicOrigin::parse(value).is_ok());
    }
}

#[test]
fn contract_declares_cookie_and_csrf_for_protected_operations() {
    let value = serde_json::to_value(atelier_app::openapi()).unwrap();
    assert_eq!(
        value["components"]["securitySchemes"]["session"]["in"],
        "cookie"
    );
    assert_eq!(
        value["components"]["securitySchemes"]["session"]["name"],
        "__Host-sid"
    );
    for (path, method) in [
        ("/api/v1/me", "get"),
        ("/api/v1/me", "patch"),
        ("/api/v1/me/sessions", "get"),
        ("/api/v1/me/sessions/{id}", "delete"),
        ("/api/v1/auth/logout", "post"),
    ] {
        let security = &value["paths"][path][method]["security"][0];
        assert!(security.get("session").is_some(), "{method} {path}");
        assert_eq!(security.get("csrf").is_some(), method != "get");
    }
}

#[tokio::test]
async fn revocation_between_lookup_and_touch_never_authenticates() {
    let (state, repo, cookie, _) = fixture();
    repo.deny_touch
        .store(true, std::sync::atomic::Ordering::Release);
    assert_eq!(
        request(state, "GET", "/api/v1/me", &cookie, None, None, "")
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
}
