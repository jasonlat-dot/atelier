use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL; run explicitly"]
async fn assets_schema_enforces_ownership_state_and_size(pool: PgPool) {
    let owner = Uuid::new_v4();
    sqlx::query("INSERT INTO users(id,google_sub,email,canonical_email,display_name) VALUES($1,$2,$2,$2,'Asset schema')")
        .bind(owner).bind(format!("{owner}@gmail.com")).execute(&pool).await.unwrap();
    let insert = "INSERT INTO assets(owner_id,name,kind,source,object_key,thumb_key,mime,bytes,thumb_bytes,width,height,sha256,state) VALUES($1,'Reference','image','upload',$2,$3,'image/png',10,5,2,2,decode(repeat('01',32),'hex'),'READY')";
    sqlx::query(insert)
        .bind(owner)
        .bind("test/original")
        .bind("test/thumb")
        .execute(&pool)
        .await
        .unwrap();
    assert!(sqlx::query(insert)
        .bind(Uuid::new_v4())
        .bind("other/original")
        .bind("other/thumb")
        .execute(&pool)
        .await
        .is_err());
    assert!(sqlx::query("UPDATE assets SET bytes=-1")
        .execute(&pool)
        .await
        .is_err());
    assert!(sqlx::query("UPDATE assets SET state='UNSAFE'")
        .execute(&pool)
        .await
        .is_err());
    assert!(sqlx::query("UPDATE assets SET object_key='../escape'")
        .execute(&pool)
        .await
        .is_err());
}
