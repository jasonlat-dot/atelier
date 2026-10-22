use atelier_assets::{signing::MediaSigner, storage::Storage, AssetError, AssetService};
use base64::{engine::general_purpose::STANDARD, Engine};
use sqlx::PgPool;
use uuid::Uuid;
fn png() -> Vec<u8> {
    let mut bytes = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(12, 8)
        .write_to(&mut bytes, image::ImageFormat::Png)
        .unwrap();
    bytes.into_inner()
}
async fn user(db: &PgPool) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO users(id,google_sub,email,canonical_email,display_name) VALUES($1,$2,$2,$2,'Asset test')").bind(id).bind(format!("{id}@gmail.com")).execute(db).await.unwrap();
    id
}
fn signature(url: &str) -> (i64, &str) {
    let query = url.split('?').nth(1).unwrap();
    let (expires, signature) = query.split_once('&').unwrap();
    (
        expires.strip_prefix("expires=").unwrap().parse().unwrap(),
        signature.strip_prefix("signature=").unwrap(),
    )
}
#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL; run explicitly"]
async fn assets_are_private_paginated_soft_deleted_and_expired(db: PgPool) {
    let owner = user(&db).await;
    let other = user(&db).await;
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::local(directory.path().into()).await.unwrap();
    let service = AssetService::new(
        db.clone(),
        storage.clone(),
        MediaSigner::from_base64(&STANDARD.encode([3u8; 32])).unwrap(),
    );
    assert!(service
        .upload_image(owner, "Fake.png", "image/png", b"fake".to_vec())
        .await
        .is_err());
    let asset = service
        .upload_image(owner, "Reference photo.png", "image/png", png())
        .await
        .unwrap();
    assert_eq!(asset.state, "READY");
    assert_eq!((asset.width, asset.height), (Some(12), Some(8)));
    assert!(matches!(
        service.get(other, asset.id).await,
        Err(AssetError::NotFound)
    ));
    let (expires, sig) = signature(asset.media_url.as_ref().unwrap());
    let media = service
        .media(owner, asset.id, "original", expires, sig, None)
        .await
        .unwrap();
    let media_bytes = axum::body::to_bytes(media.body, 20 * 1024 * 1024)
        .await
        .unwrap();
    assert_eq!(
        image::guess_format(&media_bytes).unwrap(),
        image::ImageFormat::Png
    );
    assert!(service
        .media(other, asset.id, "original", expires, sig, None)
        .await
        .is_err());
    assert!(service
        .media(owner, asset.id, "thumbnail", expires, sig, None)
        .await
        .is_err());
    let range = service
        .media(owner, asset.id, "original", expires, sig, Some("bytes=1-4"))
        .await
        .unwrap();
    assert_eq!(
        &axum::body::to_bytes(range.body, 1024).await.unwrap()[..],
        &media_bytes[1..5]
    );
    assert!(range.partial);
    assert!(service
        .media(owner, asset.id, "original", expires - 1, sig, None)
        .await
        .is_err());
    let second = service
        .upload_image(owner, "Other.png", "image/png", png())
        .await
        .unwrap();
    let first_page = service
        .list(owner, None, None, String::new(), None, 1)
        .await
        .unwrap();
    assert_eq!(first_page.items.len(), 1);
    assert_eq!(first_page.total, 2);
    let second_page = service
        .list(owner, None, None, String::new(), first_page.next_cursor, 1)
        .await
        .unwrap();
    assert_eq!(second_page.items.len(), 1);
    assert_ne!(first_page.items[0].id, second_page.items[0].id);
    assert!(second_page.next_cursor.is_none());
    assert_eq!(
        service
            .list(owner, None, None, "Reference".into(), None, 24)
            .await
            .unwrap()
            .total,
        1
    );
    assert_eq!(
        service
            .list(other, None, None, String::new(), None, 24)
            .await
            .unwrap()
            .total,
        0
    );
    assert!(matches!(
        service.delete(other, vec![asset.id]).await,
        Err(AssetError::NotFound)
    ));
    assert!(matches!(
        service.delete(owner, vec![asset.id, Uuid::new_v4()]).await,
        Err(AssetError::NotFound)
    ));
    assert!(service.get(owner, asset.id).await.is_ok());
    service.delete(owner, vec![asset.id]).await.unwrap();
    assert!(service
        .media(owner, asset.id, "original", expires, sig, None)
        .await
        .is_err());
    service.cleanup().await.unwrap();
    assert!(storage
        .get(&format!("assets/{}/original.png", asset.id), 0..1)
        .await
        .is_err());
    sqlx::query("UPDATE assets SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1")
        .bind(second.id)
        .execute(&db)
        .await
        .unwrap();
    assert!(matches!(
        service.get(owner, second.id).await,
        Err(AssetError::NotFound)
    ));
    assert_eq!(
        service
            .list(owner, None, None, String::new(), None, 24)
            .await
            .unwrap()
            .total,
        0
    );
    assert_eq!(service.cleanup().await.unwrap(), 1);
    assert!(storage
        .get(&format!("assets/{}/original.png", second.id), 0..1)
        .await
        .is_err());
}

#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL; run explicitly"]
async fn audit_failure_keeps_asset_hidden_and_retention_recovers_interrupted_uploads(db: PgPool) {
    let owner = user(&db).await;
    let service = AssetService::new(
        db.clone(),
        Storage::memory(),
        MediaSigner::from_base64(&STANDARD.encode([4u8; 32])).unwrap(),
    );
    sqlx::query("CREATE FUNCTION reject_asset_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$").execute(&db).await.unwrap();
    sqlx::query("CREATE TRIGGER reject_asset_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_asset_audit()").execute(&db).await.unwrap();
    assert!(service
        .upload_image(owner, "Audit fail.png", "image/png", png())
        .await
        .is_err());
    let states: Vec<String> = sqlx::query_scalar("SELECT state FROM assets WHERE owner_id=$1")
        .bind(owner)
        .fetch_all(&db)
        .await
        .unwrap();
    assert_eq!(states, vec!["PROCESSING"]);
    sqlx::query("UPDATE assets SET created_at=clock_timestamp()-interval '11 minutes',lease_until=clock_timestamp()-interval '1 second'").execute(&db).await.unwrap();
    assert_eq!(service.cleanup().await.unwrap(), 1);
    assert_eq!(
        service
            .list(owner, None, None, String::new(), None, 24)
            .await
            .unwrap()
            .total,
        0
    );
}
