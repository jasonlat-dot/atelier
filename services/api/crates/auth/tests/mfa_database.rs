mod support;
mod transient {
    include!("support/transient.rs");
}
use atelier_auth::{
    identity::{AuthFailure, IdentityRepository, LoginContext, PostgresIdentity},
    mfa::{totp, MfaCipher, MfaRepository, MfaService},
    postgres::PostgresSessions,
    service::{PublicOrigin, SessionService},
};
use axum::http::HeaderMap;
use base64::{engine::general_purpose::STANDARD, Engine};
use sqlx::PgPool;
use std::{collections::HashSet, sync::Arc};
#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL 16; executed by CI"]
async fn mfa_enrollment_replay_concurrency_expiry_and_audit_rollback(pool: PgPool) {
    let repo = Arc::new(PostgresIdentity::new(
        pool.clone(),
        HashSet::from(["admin@gmail.com".into()]),
    ));
    let cookie = repo
        .login(
            support::identity("admin", "admin@gmail.com"),
            LoginContext {
                ip: "192.0.2.8".parse().unwrap(),
                user_agent: "test".into(),
                invite: None,
                previous_token_hash: None,
            },
        )
        .await
        .unwrap()
        .cookie();
    let service = SessionService::new(
        Arc::new(PostgresSessions::new(pool.clone())),
        PublicOrigin::parse("https://atelier.test").unwrap(),
    );
    let mut headers = HeaderMap::new();
    headers.insert("cookie", cookie.split(';').next().unwrap().parse().unwrap());
    let actor = service.authenticate("GET", &headers).await.unwrap();
    assert!(actor.me().mfa_required);
    let cipher = MfaCipher::from_base64(&STANDARD.encode([8u8; 32])).unwrap();
    let mfa = MfaService::new(
        repo.clone(),
        Arc::new(transient::MemoryTransient::default()),
        cipher.clone(),
    );
    let setup = mfa.setup(&actor).await.unwrap();
    assert!(setup.otpauth_uri.starts_with("otpauth://totp/"));
    let original = repo
        .material(actor.user().id, actor.session_id())
        .await
        .unwrap();
    sqlx::query("UPDATE users SET mfa_pending_expires_at=now()-interval '1 second' WHERE id=$1")
        .bind(actor.user().id)
        .execute(&pool)
        .await
        .unwrap();
    let expiry = repo
        .material(actor.user().id, actor.session_id())
        .await
        .err()
        .unwrap();
    assert_eq!(expiry, AuthFailure::MfaEnrollmentExpired);
    assert_eq!(
        mfa.verify(&actor, "123456").await,
        Err(AuthFailure::MfaEnrollmentExpired)
    );
    assert_eq!(
        repo.accept(
            actor.user().id,
            actor.session_id(),
            original.encrypted.clone(),
            1,
            true
        )
        .await,
        Err(AuthFailure::MfaEnrollmentExpired)
    );
    // A different session must not receive the current enrollment's expiry status.
    let other_session = uuid::Uuid::new_v4();
    let other_secrets = atelier_auth::session::SessionSecrets::generate().unwrap();
    sqlx::query("INSERT INTO sessions(id,user_id,token_hash,csrf_token,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')")
        .bind(other_session).bind(actor.user().id).bind(other_secrets.token_hash().as_slice())
        .bind(other_secrets.csrf_token()).execute(&pool).await.unwrap();
    sqlx::query("UPDATE users SET mfa_pending_session=$2 WHERE id=$1")
        .bind(actor.user().id)
        .bind(other_session)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        repo.material(actor.user().id, actor.session_id())
            .await
            .err(),
        Some(AuthFailure::Mfa)
    );
    let renewed = mfa.setup(&actor).await.unwrap();
    assert_ne!(renewed.otpauth_uri, setup.otpauth_uri);
    assert!(!repo
        .accept(
            actor.user().id,
            actor.session_id(),
            original.encrypted,
            1,
            true
        )
        .await
        .unwrap());
    let material = repo
        .material(actor.user().id, actor.session_id())
        .await
        .unwrap();
    assert!(!material.enabled);
    let plaintext = cipher.open(actor.user().id, &material.encrypted).unwrap();
    let otp = totp(&plaintext, "admin@gmail.com").unwrap();
    let now = chrono::Utc::now().timestamp() as u64;
    let code = otp.generate(now).to_string();
    let wrong = (0..10)
        .map(|value| format!("{value:06}"))
        .find(|value| otp.check(value, now).is_none())
        .unwrap();
    assert_eq!(mfa.verify(&actor, &wrong).await, Err(AuthFailure::Mfa));
    mfa.verify(&actor, &code).await.unwrap();
    let current = service.authenticate("GET", &headers).await.unwrap();
    assert!(!current.me().mfa_required);
    assert!(mfa.verify(&actor, &code).await.is_err());
    assert!(mfa.setup(&current).await.is_err());
    let enabled = repo
        .material(actor.user().id, actor.session_id())
        .await
        .unwrap();
    assert!(enabled.enabled);
    let step = (now / 30 + 2) as i64;
    let mut tasks = Vec::new();
    for _ in 0..100 {
        let repo = repo.clone();
        let encrypted = enabled.encrypted.clone();
        let owner = actor.user().id;
        let session = actor.session_id();
        tasks.push(tokio::spawn(async move {
            repo.accept(owner, session, encrypted, step, false)
                .await
                .unwrap()
        }));
    }
    let mut accepted = 0;
    for task in tasks {
        accepted += usize::from(task.await.unwrap());
    }
    assert_eq!(accepted, 1);
    sqlx::query("ALTER TABLE audit_logs ADD CONSTRAINT reject_mfa CHECK(action <> 'MFA_VERIFIED') NOT VALID")
        .execute(&pool)
        .await
        .unwrap();
    assert!(repo
        .accept(
            actor.user().id,
            actor.session_id(),
            enabled.encrypted.clone(),
            step + 1,
            false
        )
        .await
        .is_err());
    let last: i64 = sqlx::query_scalar("SELECT mfa_last_step FROM users WHERE id=$1")
        .bind(actor.user().id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(last, step);
    sqlx::query("UPDATE users SET status='DISABLED' WHERE id=$1")
        .bind(actor.user().id)
        .execute(&pool)
        .await
        .unwrap();
    assert!(repo
        .material(actor.user().id, actor.session_id())
        .await
        .is_err());
}
