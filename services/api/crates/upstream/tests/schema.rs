use sqlx::PgPool;
#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL"]
async fn upstream_schema_keeps_secrets_private_and_constrains_configuration(db: PgPool) {
    let columns: i64=sqlx::query_scalar("SELECT count(*) FROM information_schema.columns WHERE table_name='upstream_accounts' AND column_name IN ('secret_enc','key_version','revision')").fetch_one(&db).await.unwrap();
    assert_eq!(columns, 3);
    assert!(sqlx::query("INSERT INTO models(id,kind,display_name,upstream_model,capabilities) VALUES('video-test','video','Video test','private-provider-model','{}')").execute(&db).await.is_ok());
    assert!(sqlx::query("INSERT INTO pricing_rules(model_id,quality,base_credits) VALUES('video-test','standard',-1)").execute(&db).await.is_err());
    assert!(sqlx::query("INSERT INTO upstream_accounts(name,base_url,secret_enc,secret_last4,concurrency_limit) VALUES('Invalid limit','https://example.com/v1',decode(repeat('ab',41),'hex'),'abcd',0)").execute(&db).await.is_err());
    let tables:i64=sqlx::query_scalar("SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('account_models','upstream_leases','upstream_attempts')").fetch_one(&db).await.unwrap();
    assert_eq!(tables, 3);
}
