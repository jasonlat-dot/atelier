//! Opt-in CI fixture only: production main never references this provider or signing key.
use atelier_app::{router, AppState};
use atelier_auth::{
    identity::{AuthFailure, AuthFuture, PostgresIdentity},
    login::LoginService,
    mfa::{MfaCipher, MfaService},
    oidc_attempt::AttemptFlow,
    oidc_provider::{verify_id_token, IdentityProvider, VerifiedIdentity},
    postgres::PostgresSessions,
    service::{PublicOrigin, SessionService},
    transient::RedisTransient,
};
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD as B64},
    Engine,
};
use ring::{
    rand::{SecureRandom, SystemRandom},
    signature::{RsaKeyPair, RSA_PKCS1_SHA256},
};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, sync::Arc};
struct FixtureProvider;
impl IdentityProvider for FixtureProvider {
    fn exchange(
        &self,
        code: String,
        verifier: String,
        nonce: String,
    ) -> AuthFuture<'_, VerifiedIdentity> {
        Box::pin(async move {
            let parts: Vec<_> = code.split('~').collect();
            if parts.len() != 3
                || parts[1] != nonce
                || parts[2] != B64.encode(Sha256::digest(verifier.as_bytes()))
            {
                return Err(AuthFailure::Identity);
            }
            let (sub, email) = match parts[0] {
                "user" => ("browser-user", "browseruser@gmail.com"),
                "admin" => ("browser-admin", "browseradmin@gmail.com"),
                _ => return Err(AuthFailure::Identity),
            };
            let now = chrono::Utc::now().timestamp();
            let claims = serde_json::json!({"iss":"https://accounts.google.com","aud":"browser-test","sub":sub,"email":email,"email_verified":true,"nonce":nonce,"exp":now+300,"iat":now});
            let input = format!(
                "{}.{}",
                B64.encode(r#"{"alg":"RS256","kid":"test-key"}"#),
                B64.encode(claims.to_string())
            );
            let key = RsaKeyPair::from_pkcs8(include_bytes!(
                "../../auth/tests/fixtures/oidc-test-only.pk8"
            ))
            .unwrap();
            let mut signature = vec![0; key.public().modulus_len()];
            key.sign(
                &RSA_PKCS1_SHA256,
                &SystemRandom::new(),
                input.as_bytes(),
                &mut signature,
            )
            .unwrap();
            verify_id_token(
                &format!("{input}.{}", B64.encode(signature)),
                include_str!("../../auth/tests/fixtures/jwks.json"),
                "browser-test",
                &nonce,
                now,
            )
        })
    }
}
#[tokio::test]
#[ignore = "Opt-in Playwright fixture with isolated PostgreSQL/Redis; never a production login mode"]
async fn browser_harness() {
    assert_eq!(std::env::var("TEST_AUTH_HARNESS").as_deref(), Ok("1"));
    let db = sqlx::postgres::PgPoolOptions::new()
        .max_connections(8)
        .connect(&std::env::var("DATABASE_URL").expect("isolated test database only"))
        .await
        .unwrap();
    sqlx::migrate!("../../migrations").run(&db).await.unwrap();
    sqlx::query("UPDATE system_settings SET value='\"OPEN\"' WHERE key='registration_mode'")
        .execute(&db)
        .await
        .unwrap();
    let limits = Arc::new(
        RedisTransient::connect(
            &std::env::var("TEST_REDIS_URL").expect("isolated test Redis only"),
        )
        .await
        .unwrap(),
    );
    let identity = Arc::new(PostgresIdentity::new(
        db.clone(),
        HashSet::from(["browseradmin@gmail.com".into()]),
    ));
    let flow = AttemptFlow::new(
        limits.clone(),
        "browser-test".into(),
        "http://127.0.0.1:8080/api/v1/auth/google/callback".into(),
    )
    .unwrap();
    let mut key = [0u8; 32];
    SystemRandom::new().fill(&mut key).unwrap();
    let cipher = MfaCipher::from_base64(&STANDARD.encode(key)).unwrap();
    let mut state = AppState::test();
    state.db = db.clone();
    state.auth = SessionService::new(
        Arc::new(PostgresSessions::new(db)),
        PublicOrigin::parse("http://127.0.0.1:8080").unwrap(),
    );
    state.login = Some(LoginService::new(
        flow,
        Arc::new(FixtureProvider),
        identity.clone(),
    ));
    state.mfa = Some(MfaService::new(identity, limits.clone(), cipher));
    state.limits = Some(limits);
    state.web_dir =
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../apps/web/dist");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:8080")
        .await
        .unwrap();
    axum::serve(
        listener,
        router(state).into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .await
    .unwrap();
}
