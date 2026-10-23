#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL"]
async fn generation_schema_installs_fenced_jobs_events_and_output_constraints(db: sqlx::PgPool) {
    let checks: i64 = sqlx::query_scalar("SELECT count(*) FROM information_schema.columns WHERE table_name='generation_jobs' AND column_name IN ('lease_token','request_hash','cost','model_revision','upstream_job_id','dispatch_started')")
        .fetch_one(&db).await.unwrap();
    assert_eq!(checks, 6);
    let state_guard: i64 = sqlx::query_scalar("SELECT count(*) FROM pg_trigger WHERE tgrelid='generation_jobs'::regclass AND NOT tgisinternal")
        .fetch_one(&db).await.unwrap();
    assert!(state_guard > 0);
    let immutable: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM pg_trigger WHERE tgrelid='job_events'::regclass AND NOT tgisinternal",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert!(immutable > 0);
}
