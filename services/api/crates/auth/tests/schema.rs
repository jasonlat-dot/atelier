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
