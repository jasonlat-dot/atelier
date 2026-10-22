use atelier_assets::{
    signing::MediaSigner, storage::Storage, video::VideoProcessor, AssetError, AssetService,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use bytes::Bytes;
use sqlx::PgPool;
use uuid::Uuid;

fn processor() -> VideoProcessor {
    VideoProcessor::from_lookup(|key| std::env::var(key).ok())
        .unwrap()
        .expect("FFmpeg required")
}
fn video() -> Vec<u8> {
    include_bytes!("../../app/tests/fixtures/reference.mp4").to_vec()
}
#[tokio::test]
#[ignore = "Requires FFmpeg/ffprobe and Linux process resource limits"]
async fn real_video_is_probed_reencoded_and_has_a_decodable_cover() {
    let processor = processor();
    assert!(processor.available().await);
    assert!(matches!(
        processor
            .inspect_upload(
                Bytes::from_static(include_bytes!("../../app/tests/fixtures/too-long.mp4")),
                "video/mp4"
            )
            .await,
        Err(AssetError::TooLarge)
    ));
    let input = Bytes::from(video());
    let info = processor
        .inspect_upload(input.clone(), "video/mp4")
        .await
        .unwrap();
    assert_eq!((info.width, info.height, info.duration_ms), (96, 64, 2000));
    assert!(processor
        .inspect_upload(input.clone(), "video/webm")
        .await
        .is_err());
    assert!(processor
        .inspect_upload(
            Bytes::from_static(b"#EXTM3U\nfile:///etc/passwd"),
            "video/mp4"
        )
        .await
        .is_err());
    assert!(processor
        .inspect_upload(input.slice(..20), "video/mp4")
        .await
        .is_err());
    let output = processor.transcode(input.clone()).await.unwrap();
    assert_ne!(&output.original[..], &input[..]);
    assert!(!output
        .original
        .windows(b"synthetic-test".len())
        .any(|bytes| bytes == b"synthetic-test"));
    assert_eq!((output.info.width, output.info.height), (96, 64));
    assert!((output.info.duration_ms - 2000).abs() <= 100);
    assert!(image::load_from_memory(&output.thumbnail).is_ok());
    for (data, mime) in [
        (
            include_bytes!("../../app/tests/fixtures/reference.webm").as_slice(),
            "video/webm",
        ),
        (
            include_bytes!("../../app/tests/fixtures/boundary.mp4").as_slice(),
            "video/mp4",
        ),
    ] {
        let data = Bytes::copy_from_slice(data);
        processor.inspect_upload(data.clone(), mime).await.unwrap();
        let output = processor.transcode(data).await.unwrap();
        assert!(output.info.duration_ms <= 60000);
    }
}

#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL and FFmpeg/ffprobe"]
async fn corrupt_jobs_fail_closed_and_audit_rollback_is_retryable(db: PgPool) {
    let owner = Uuid::new_v4();
    sqlx::query("INSERT INTO users(id,google_sub,email,canonical_email,display_name) VALUES($1,$2,$2,$2,'Video failure test')").bind(owner).bind(format!("{owner}@gmail.com")).execute(&db).await.unwrap();
    let storage = Storage::memory();
    let service = AssetService::new(
        db.clone(),
        storage.clone(),
        MediaSigner::from_base64(&STANDARD.encode([6u8; 32])).unwrap(),
    )
    .with_video(processor());
    let invalid = service
        .upload_video(owner, "Broken.mp4", "video/mp4", video())
        .await
        .unwrap();
    storage
        .put(
            &format!("assets/{}/source.bin", invalid.id),
            vec![0; video().len()],
        )
        .await
        .unwrap();
    assert!(service.process_next_video().await.unwrap());
    let failed = service.get(owner, invalid.id).await.unwrap();
    assert_eq!(failed.state, "FAILED");
    assert!(failed.media_url.is_none());
    service.cleanup().await.unwrap();
    assert!(storage
        .get(&format!("assets/{}/source.bin", invalid.id), 0..1)
        .await
        .is_err());
    let retry = service
        .upload_video(owner, "Retry.mp4", "video/mp4", video())
        .await
        .unwrap();
    sqlx::query("CREATE FUNCTION reject_video_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='asset.process' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$").execute(&db).await.unwrap();
    sqlx::query("CREATE TRIGGER reject_video_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_video_audit()").execute(&db).await.unwrap();
    assert!(service.process_next_video().await.unwrap());
    assert_eq!(
        service.get(owner, retry.id).await.unwrap().state,
        "PROCESSING"
    );
    sqlx::query("DROP TRIGGER reject_video_audit ON audit_logs")
        .execute(&db)
        .await
        .unwrap();
    sqlx::query("UPDATE assets SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1")
        .bind(retry.id)
        .execute(&db)
        .await
        .unwrap();
    assert!(service.process_next_video().await.unwrap());
    assert_eq!(service.get(owner, retry.id).await.unwrap().state, "READY");
    let exhausted = service
        .upload_video(owner, "Interrupted.mp4", "video/mp4", video())
        .await
        .unwrap();
    sqlx::query("UPDATE assets SET attempts=3,lease_until=clock_timestamp()-interval '1 second' WHERE id=$1").bind(exhausted.id).execute(&db).await.unwrap();
    service.cleanup().await.unwrap();
    assert_eq!(
        service.get(owner, exhausted.id).await.unwrap().state,
        "FAILED"
    );
    assert!(!service.process_next_video().await.unwrap());
}

#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL and FFmpeg/ffprobe"]
async fn durable_video_job_is_claimed_once_and_only_ready_output_can_be_read(db: PgPool) {
    let owner = Uuid::new_v4();
    sqlx::query("INSERT INTO users(id,google_sub,email,canonical_email,display_name) VALUES($1,$2,$2,$2,'Video test')").bind(owner).bind(format!("{owner}@gmail.com")).execute(&db).await.unwrap();
    let storage = Storage::memory();
    let service = AssetService::new(
        db.clone(),
        storage.clone(),
        MediaSigner::from_base64(&STANDARD.encode([5u8; 32])).unwrap(),
    )
    .with_video(processor());
    let asset = service
        .upload_video(owner, "Film.mp4", "video/mp4", video())
        .await
        .unwrap();
    assert_eq!(asset.state, "PROCESSING");
    assert!(asset.media_url.is_none());
    let (a, b) = tokio::join!(service.process_next_video(), service.process_next_video());
    assert_ne!(a.unwrap(), b.unwrap());
    let ready = service.get(owner, asset.id).await.unwrap();
    assert_eq!(ready.state, "READY");
    let attempts: i32 = sqlx::query_scalar("SELECT attempts FROM assets WHERE id=$1")
        .bind(asset.id)
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(attempts, 1);
    assert!(storage
        .get(&format!("assets/{}/source.bin", asset.id), 0..1)
        .await
        .is_err());
    let url = ready.media_url.unwrap();
    let query = url.split('?').nth(1).unwrap();
    let (expires, signature) = query.split_once('&').unwrap();
    let expires = expires.strip_prefix("expires=").unwrap().parse().unwrap();
    let signature = signature.strip_prefix("signature=").unwrap();
    let media = service
        .media(
            owner,
            asset.id,
            "original",
            expires,
            signature,
            Some("bytes=0-31"),
        )
        .await
        .unwrap();
    assert!(media.partial);
    assert_eq!(media.mime, "video/mp4");
    let bytes = axum::body::to_bytes(media.body, 32).await.unwrap();
    assert_eq!(&bytes[4..8], b"ftyp");
    assert!(matches!(
        service.get(Uuid::new_v4(), asset.id).await,
        Err(AssetError::NotFound)
    ));
    service.delete(owner, vec![asset.id]).await.unwrap();
    assert!(service
        .media(owner, asset.id, "original", expires, signature, None)
        .await
        .is_err());
    service.cleanup().await.unwrap();
    let remaining: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM asset_blobs WHERE asset_id=$1 AND purged_at IS NULL",
    )
    .bind(asset.id)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(remaining, 0);
    let deleted = service
        .upload_video(owner, "Removed.mp4", "video/mp4", video())
        .await
        .unwrap();
    service.delete(owner, vec![deleted.id]).await.unwrap();
    assert!(!service.process_next_video().await.unwrap());
    service.cleanup().await.unwrap();
}
