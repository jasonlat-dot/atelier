use sqlx::{PgPool, Row};
use uuid::Uuid;

async fn user(pool: &PgPool, sub: &str, email: &str) -> Uuid {
    sqlx::query_scalar("INSERT INTO users(google_sub,email,canonical_email,display_name) VALUES($1,$2,$2,'Test') RETURNING id")
        .bind(sub).bind(email).fetch_one(pool).await.unwrap()
}

#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL 16 with database creation privileges; run after deployment"]
async fn identity_constraints_and_default_closed_registration(pool: PgPool) {
    let mode: serde_json::Value =
        sqlx::query_scalar("SELECT value FROM system_settings WHERE key='registration_mode'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(mode, "CLOSED");
    user(&pool, "sub1", "ab@gmail.com").await;
    for (sub, email) in [("sub1", "other@gmail.com"), ("sub2", "ab@gmail.com")] {
        let error = sqlx::query("INSERT INTO users(google_sub,email,canonical_email,display_name) VALUES($1,$2,$2,'Test')").bind(sub).bind(email).execute(&pool).await.unwrap_err();
        assert_eq!(
            error.as_database_error().unwrap().code().as_deref(),
            Some("23505")
        );
    }
    let row = sqlx::query("SELECT role,status FROM users WHERE google_sub='sub1'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(row.get::<String, _>("role"), "USER");
    assert_eq!(row.get::<String, _>("status"), "ACTIVE");
}

#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL 16 with database creation privileges; run after deployment"]
async fn role_changes_and_disabling_revoke_all_sessions_in_same_transaction(pool: PgPool) {
    let id = user(&pool, "sub1", "ab@gmail.com").await;
    for change in [
        "UPDATE users SET role='ADMIN' WHERE id=$1",
        "UPDATE users SET status='DISABLED' WHERE id=$1",
    ] {
        sqlx::query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,$3,now()+interval '30 days')")
            .bind(Uuid::new_v4().as_bytes().repeat(2)).bind(id).bind("a".repeat(43)).execute(&pool).await.unwrap();
        let mut transaction = pool.begin().await.unwrap();
        sqlx::query(change)
            .bind(id)
            .execute(&mut *transaction)
            .await
            .unwrap();
        let active: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM sessions WHERE user_id=$1 AND revoked_at IS NULL",
        )
        .bind(id)
        .fetch_one(&mut *transaction)
        .await
        .unwrap();
        assert_eq!(active, 0);
        transaction.commit().await.unwrap();
    }
}

#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL 16 with database creation privileges; run after deployment"]
async fn session_device_identifiers_are_unique_and_not_token_hashes(pool: PgPool) {
    let owner = user(&pool, "device-sub", "device@gmail.com").await;
    for byte in [1_u8, 2] {
        sqlx::query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,$3,now()+interval '720 hours')")
            .bind(vec![byte;32]).bind(owner).bind("a".repeat(43)).execute(&pool).await.unwrap();
    }
    let count: i64 = sqlx::query_scalar("SELECT count(DISTINCT id) FROM sessions WHERE user_id=$1")
        .bind(owner)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 2);
}

#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL 16 with database creation privileges; run after deployment"]
async fn postgres_session_service_scopes_devices_and_audits_mutations(pool: PgPool) {
    use atelier_auth::{
        postgres::PostgresSessions,
        repository::SessionRepository,
        service::{PublicOrigin, SessionService},
        session::SessionSecrets,
    };
    use axum::http::HeaderMap;
    use std::sync::Arc;
    let owner = user(&pool, "session-owner", "sessionowner@gmail.com").await;
    let foreign = user(&pool, "session-foreign", "sessionforeign@gmail.com").await;
    let secrets = SessionSecrets::generate().unwrap();
    let device: Uuid = sqlx::query_scalar("INSERT INTO sessions(token_hash,user_id,csrf_token,created_at,last_seen_at,expires_at) VALUES($1,$2,$3,now()-interval '24 hours',now()-interval '1 hour',now()+interval '696 hours') RETURNING id")
        .bind(secrets.token_hash().as_slice()).bind(owner).bind(secrets.csrf_token()).fetch_one(&pool).await.unwrap();
    let foreign_device: Uuid = sqlx::query_scalar("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,$3,now()+interval '720 hours') RETURNING id")
        .bind(vec![42_u8;32]).bind(foreign).bind("a".repeat(43)).fetch_one(&pool).await.unwrap();
    let repository = Arc::new(PostgresSessions::new(pool.clone()));
    let service = SessionService::new(
        repository.clone(),
        PublicOrigin::parse("https://atelier.test").unwrap(),
    );
    let mut headers = HeaderMap::new();
    headers.insert(
        "Cookie",
        secrets.cookie().split(';').next().unwrap().parse().unwrap(),
    );
    let actor = service.authenticate("GET", &headers).await.unwrap();
    let devices = service.devices(&actor).await.unwrap().sessions;
    assert_eq!(devices.len(), 1);
    assert_eq!(devices[0].id, device);
    assert!(devices[0].current);
    assert!(service.revoke_device(&actor, foreign_device).await.is_err());
    service.rename(&actor, "Updated").await.unwrap();
    let name: String = sqlx::query_scalar("SELECT display_name FROM users WHERE id=$1")
        .bind(owner)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(name, "Updated");
    let audit: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_logs WHERE actor_id=$1 AND action='USER_RENAMED'",
    )
    .bind(owner)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(audit, 1);
    service.logout(&actor).await.unwrap();
    assert!(service.authenticate("GET", &headers).await.is_err());
    assert!(
        repository
            .devices(foreign, foreign_device, chrono::Utc::now())
            .await
            .unwrap()
            .len()
            == 1
    );
}

#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL 16 with database creation privileges; run after deployment"]
async fn failed_audit_rolls_back_session_revocation(pool: PgPool) {
    use atelier_auth::{postgres::PostgresSessions, repository::SessionRepository};
    let owner = user(&pool, "rollback-owner", "rollback@gmail.com").await;
    sqlx::query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,$3,now()+interval '720 hours')")
        .bind(vec![42_u8;32]).bind(owner).bind("a".repeat(43)).execute(&pool).await.unwrap();
    sqlx::query(
        "ALTER TABLE audit_logs ADD CONSTRAINT reject_logout CHECK (action <> 'SESSIONS_REVOKED')",
    )
    .execute(&pool)
    .await
    .unwrap();
    assert!(PostgresSessions::new(pool.clone())
        .revoke_all(owner)
        .await
        .is_err());
    let active: i64 =
        sqlx::query_scalar("SELECT count(*) FROM sessions WHERE user_id=$1 AND revoked_at IS NULL")
            .bind(owner)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(active, 1);
}
