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
#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Opt-in Playwright fixture with isolated PostgreSQL/Redis; never a production login mode"]
async fn browser_harness(db: sqlx::PgPool) {
    assert_eq!(std::env::var("TEST_AUTH_HARNESS").as_deref(), Ok("1"));
    let port: u16 = std::env::var("TEST_AUTH_PORT")
        .unwrap_or_else(|_| "8080".into())
        .parse()
        .unwrap();
    assert_ne!(port, 0);
    let base_url = format!("http://127.0.0.1:{port}");
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
        format!("{base_url}/api/v1/auth/google/callback"),
    )
    .unwrap();
    let mut key = [0u8; 32];
    SystemRandom::new().fill(&mut key).unwrap();
    let cipher = MfaCipher::from_base64(&STANDARD.encode(key)).unwrap();
    let mut state = AppState::test();
    state.db = db.clone();
    let video = atelier_assets::video::VideoProcessor::from_lookup(|key| std::env::var(key).ok())
        .unwrap()
        .expect("Browser fixture requires FFmpeg");
    assert!(
        video.available().await,
        "Browser fixture requires FFmpeg/ffprobe"
    );
    let assets = atelier_assets::AssetService::new(
        db.clone(),
        atelier_assets::storage::Storage::memory(),
        atelier_assets::signing::MediaSigner::from_base64(&STANDARD.encode(key)).unwrap(),
    )
    .with_video(video);
    let processing = tokio::spawn(assets.clone().processing_loop());
    state.assets = Some(assets);
    state.auth = SessionService::new(
        Arc::new(PostgresSessions::new(db)),
        PublicOrigin::parse(&base_url).unwrap(),
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
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
        .await
        .unwrap();
    axum::serve(
        listener,
        router(state).into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .await
    .unwrap();
    processing.abort();
}
