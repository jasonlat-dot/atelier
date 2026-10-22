mod support;
use atelier_auth::identity::{IdentityRepository, LoginContext, PostgresIdentity};
use sqlx::PgPool;
use std::{collections::HashSet, sync::Arc};
fn context(ip: &str, invite: Option<&str>) -> LoginContext {
    LoginContext {
        ip: ip.parse().unwrap(),
        user_agent: "test browser".into(),
        invite: invite.map(str::to_string),
        previous_token_hash: None,
    }
}
async fn mode(pool: &PgPool, value: &str) {
    sqlx::query(
        "UPDATE system_settings SET value=to_jsonb($1::text) WHERE key='registration_mode'",
    )
    .bind(value)
    .execute(pool)
    .await
    .unwrap();
}
#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL 16; executed by CI"]
async fn registration_closed_existing_alias_disabled_and_bootstrap_only_once(pool: PgPool) {
    let repo = PostgresIdentity::new(pool.clone(), HashSet::from(["admin@gmail.com".into()]));
    assert!(repo
        .login(
            support::identity("new", "new@gmail.com"),
            context("192.0.2.1", None)
        )
        .await
        .is_err());
    repo.login(
        support::identity("admin", "ad.min+alias@gmail.com"),
        context("192.0.2.1", None),
    )
    .await
    .unwrap();
    let role: String = sqlx::query_scalar("SELECT role FROM users WHERE google_sub='admin'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(role, "SUPER_ADMIN");
    sqlx::query("UPDATE users SET role='USER' WHERE google_sub='admin'")
        .execute(&pool)
        .await
        .unwrap();
    repo.login(
        support::identity("admin", "admin@gmail.com"),
        context("192.0.2.1", None),
    )
    .await
    .unwrap();
    let role: String = sqlx::query_scalar("SELECT role FROM users WHERE google_sub='admin'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(role, "USER");
    mode(&pool, "OPEN").await;
    assert!(repo
        .login(
            support::identity("other", "ad.min+2@gmail.com"),
            context("192.0.2.2", None)
        )
        .await
        .is_err());
    sqlx::query("UPDATE users SET status='DISABLED' WHERE google_sub='admin'")
        .execute(&pool)
        .await
        .unwrap();
    assert!(repo
        .login(
            support::identity("admin", "admin@gmail.com"),
            context("192.0.2.2", None)
        )
        .await
        .is_err());
}
#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL 16; executed by CI"]
async fn concurrent_registration_obeys_ip_quota_and_subject_uniqueness(pool: PgPool) {
    mode(&pool, "OPEN").await;
    let repo = Arc::new(PostgresIdentity::new(pool.clone(), HashSet::new()));
    let mut tasks = Vec::new();
    for i in 0..20 {
        let repo = repo.clone();
        tasks.push(tokio::spawn(async move {
            repo.login(
                support::identity(&format!("sub{i}"), &format!("user{i}@gmail.com")),
                context(
                    if i % 2 == 0 {
                        "192.0.2.3"
                    } else {
                        "::ffff:192.0.2.3"
                    },
                    None,
                ),
            )
            .await
            .is_ok()
        }));
    }
    let mut accepted = 0;
    for t in tasks {
        accepted += usize::from(t.await.unwrap());
    }
    assert_eq!(accepted, 3);
    let mut tasks = Vec::new();
    for _ in 0..20 {
        let repo = repo.clone();
        tasks.push(tokio::spawn(async move {
            repo.login(
                support::identity("one-sub", "one@gmail.com"),
                context("192.0.2.4", None),
            )
            .await
            .is_ok()
        }));
    }
    for t in tasks {
        assert!(t.await.unwrap());
    }
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM users WHERE google_sub='one-sub'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
    let bonus_count:i64=sqlx::query_scalar("SELECT count(*) FROM credit_ledger l JOIN users u ON u.id=l.user_id WHERE u.google_sub='one-sub' AND l.type='SIGNUP_BONUS'").fetch_one(&pool).await.unwrap();
    assert_eq!(bonus_count, 1);
    let balance: i64 = sqlx::query_scalar(
        "SELECT balance FROM wallets w JOIN users u ON u.id=w.user_id WHERE u.google_sub='one-sub'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(balance, 20);
}
#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL 16; executed by CI"]
async fn invitation_is_atomic_and_failed_audit_rolls_back_registration(pool: PgPool) {
    use sha2::{Digest, Sha256};
    mode(&pool, "INVITE_ONLY").await;
    sqlx::query("INSERT INTO invite_codes(code_hash) VALUES($1)")
        .bind(Sha256::digest(b"single-invite").as_slice())
        .execute(&pool)
        .await
        .unwrap();
    let repo = Arc::new(PostgresIdentity::new(pool.clone(), HashSet::new()));
    let mut tasks = Vec::new();
    for i in 0..10 {
        let repo = repo.clone();
        tasks.push(tokio::spawn(async move {
            repo.login(
                support::identity(&format!("inv{i}"), &format!("inv{i}@gmail.com")),
                context("192.0.2.5", Some("single-invite")),
            )
            .await
            .is_ok()
        }));
    }
    let mut accepted = 0;
    for t in tasks {
        accepted += usize::from(t.await.unwrap());
    }
    assert_eq!(accepted, 1);
    mode(&pool, "OPEN").await;
    sqlx::query(
        "ALTER TABLE audit_logs ADD CONSTRAINT reject_signup CHECK(action <> 'USER_REGISTERED') NOT VALID",
    )
    .execute(&pool)
    .await
    .unwrap();
    assert!(repo
        .login(
            support::identity("rollback", "rollback@gmail.com"),
            context("192.0.2.6", None)
        )
        .await
        .is_err());
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM users WHERE google_sub='rollback'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
}

#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL 16; executed by CI"]
async fn live_settings_whitelist_expired_invite_and_session_rotation(pool: PgPool) {
    use atelier_auth::identity::AuthFailure;
    use sha2::{Digest, Sha256};
    let repo = PostgresIdentity::new(pool.clone(), HashSet::new());
    mode(&pool, "INVITE_ONLY").await;
    sqlx::query("UPDATE system_settings SET value='[\"white.list+allowed@gmail.com\"]' WHERE key='registration_whitelist'").execute(&pool).await.unwrap();
    let first = repo
        .login(
            support::identity("white", "whitelist@gmail.com"),
            context("192.0.2.10", None),
        )
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO invite_codes(code_hash,expires_at) VALUES($1,now()-interval '1 second')",
    )
    .bind(Sha256::digest(b"expired").as_slice())
    .execute(&pool)
    .await
    .unwrap();
    assert!(matches!(
        repo.login(
            support::identity("expired", "expired@gmail.com"),
            context("192.0.2.11", Some("expired"))
        )
        .await,
        Err(AuthFailure::Invite)
    ));
    mode(&pool, "CLOSED").await;
    assert!(matches!(
        repo.login(
            support::identity("closed-new", "closednew@gmail.com"),
            context("192.0.2.12", None)
        )
        .await,
        Err(AuthFailure::Closed)
    ));
    let mut ctx = context("192.0.2.10", None);
    ctx.previous_token_hash = Some(first.token_hash());
    let rotated = repo
        .login(support::identity("white", "whitelist@gmail.com"), ctx)
        .await
        .unwrap();
    assert_ne!(first.token_hash(), rotated.token_hash());
    let revoked: bool =
        sqlx::query_scalar("SELECT revoked_at IS NOT NULL FROM sessions WHERE token_hash=$1")
            .bind(first.token_hash().as_slice())
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(revoked);
    mode(&pool, "OPEN").await;
    repo.login(
        support::identity("open-now", "opennow@gmail.com"),
        context("192.0.2.13", None),
    )
    .await
    .unwrap();
}
