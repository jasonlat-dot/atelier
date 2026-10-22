use crate::{service::clean_name, video::VideoProcessor, AssetError, AssetService, AssetView};
use bytes::Bytes;
use sha2::{Digest, Sha256};
use sqlx::Row;
use std::time::Duration;
use uuid::Uuid;
impl AssetService {
    pub fn with_video(mut self, processor: VideoProcessor) -> Self {
        self.video = Some(processor);
        self
    }
    pub fn video_enabled(&self) -> bool {
        self.video.is_some()
    }
    pub async fn upload_video(
        &self,
        owner: Uuid,
        name: &str,
        mime: &str,
        input: Vec<u8>,
    ) -> Result<AssetView, AssetError> {
        let processor = self.video.as_ref().ok_or(AssetError::VideoUnavailable)?;
        let _permit = self
            .processing
            .clone()
            .try_acquire_owned()
            .map_err(|_| AssetError::Busy)?;
        let input = Bytes::from(input);
        let info = processor.inspect_upload(input.clone(), mime).await?;
        let name = clean_name(name)?;
        let id = Uuid::new_v4();
        let original = format!("assets/{id}/original.mp4");
        let thumb = format!("assets/{id}/thumbnail.jpg");
        let raw = format!("assets/{id}/source.bin");
        let (mut tx, retention) = self
            .reservation(owner, (crate::MAX_VIDEO_BYTES * 2) as i64)
            .await?;
        sqlx::query("INSERT INTO assets(id,owner_id,name,kind,source,object_key,thumb_key,mime,bytes,raw_bytes,width,height,duration_ms,reserved_bytes,expires_at,lease_until) VALUES($1,$2,$3,'video','upload',$4,$5,'video/mp4',$6,$6,$7,$8,$9,419430400,clock_timestamp()+make_interval(days=>$10),clock_timestamp()+interval '5 minutes')")
            .bind(id).bind(owner).bind(&name).bind(&original).bind(&thumb).bind(input.len() as i64).bind(info.width).bind(info.height).bind(info.duration_ms).bind(retention).execute(&mut *tx).await?;
        for key in [&original, &thumb, &raw] {
            sqlx::query("INSERT INTO asset_blobs(object_key,asset_id) VALUES($1,$2)")
                .bind(key)
                .bind(id)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        if self.storage.put_bytes(&raw, input).await.is_err() {
            let _=sqlx::query("UPDATE assets SET deleted_at=clock_timestamp(),lease_until=NULL,state='FAILED',bytes=0,error_code='STORAGE_FAILED' WHERE id=$1 AND owner_id=$2").bind(id).bind(owner).execute(&self.db).await;
            return Err(AssetError::Store);
        }
        let mut tx = self.db.begin().await?;
        sqlx::query("INSERT INTO audit_logs(actor_id,action,target_type,target_id,after) VALUES($1,'asset.upload','asset',$2,$3)").bind(owner).bind(id.to_string()).bind(serde_json::json!({"kind":"video","name":name})).execute(&mut *tx).await?;
        let updated=sqlx::query("UPDATE assets SET upload_ready=true,lease_until=NULL WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL AND expires_at>clock_timestamp()").bind(id).bind(owner).execute(&mut *tx).await?;
        if updated.rows_affected() != 1 {
            return Err(AssetError::Store);
        }
        tx.commit().await?;
        self.get(owner, id).await
    }
    pub async fn process_next_video(&self) -> Result<bool, AssetError> {
        let Some(processor) = &self.video else {
            return Ok(false);
        };
        let Ok(_permit) = self.processing.clone().try_acquire_owned() else {
            return Ok(false);
        };
        let mut tx = self.db.begin().await?;
        let row=sqlx::query("SELECT a.id,a.owner_id,a.raw_bytes FROM assets a JOIN users u ON u.id=a.owner_id WHERE a.kind='video' AND a.source='upload' AND a.state='PROCESSING' AND a.upload_ready=true AND a.deleted_at IS NULL AND a.expires_at>clock_timestamp() AND a.attempts<3 AND (a.lease_until IS NULL OR a.lease_until<clock_timestamp()) AND u.status='ACTIVE' ORDER BY a.created_at,a.id LIMIT 1 FOR UPDATE OF a SKIP LOCKED").fetch_optional(&mut *tx).await?;
        let Some(row) = row else {
            return Ok(false);
        };
        let id: Uuid = row.get("id");
        let owner: Uuid = row.get("owner_id");
        let raw_bytes: i64 = row.try_get("raw_bytes").map_err(|_| AssetError::Store)?;
        let token = Uuid::new_v4();
        let original = format!("assets/{id}/{token}/original.mp4");
        let thumb = format!("assets/{id}/{token}/thumbnail.jpg");
        sqlx::query("UPDATE assets SET lease_token=$2,lease_until=clock_timestamp()+interval '15 minutes',attempts=attempts+1 WHERE id=$1").bind(id).bind(token).execute(&mut *tx).await?;
        for key in [&original, &thumb] {
            sqlx::query("INSERT INTO asset_blobs(object_key,asset_id) VALUES($1,$2)")
                .bind(key)
                .bind(id)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        let outcome=async {
            let input=self.storage.get(&format!("assets/{id}/source.bin"),0..raw_bytes as u64).await?;
            let prepared=processor.transcode(input).await?;
            let bytes=prepared.original.len() as i64;let thumb_bytes=prepared.thumbnail.len() as i64;let hash=Sha256::digest(&prepared.original).to_vec();
            self.storage.put(&original,prepared.original).await?;self.storage.put(&thumb,prepared.thumbnail).await?;
            let mut tx=self.db.begin().await?;
            let updated=sqlx::query("UPDATE assets SET state='READY',object_key=$3,thumb_key=$4,bytes=$5,thumb_bytes=$6,width=$7,height=$8,duration_ms=$9,sha256=$10,lease_until=NULL,lease_token=NULL,error_code=NULL WHERE id=$1 AND lease_token=$2 AND state='PROCESSING' AND deleted_at IS NULL AND expires_at>clock_timestamp()")
                .bind(id).bind(token).bind(&original).bind(&thumb).bind(bytes).bind(thumb_bytes).bind(prepared.info.width).bind(prepared.info.height).bind(prepared.info.duration_ms).bind(hash).execute(&mut *tx).await?;
            if updated.rows_affected()!=1{return Err(AssetError::NotFound);}
            sqlx::query("INSERT INTO audit_logs(actor_id,action,target_type,target_id,after) VALUES($1,'asset.process','asset',$2,$3)").bind(owner).bind(id.to_string()).bind(serde_json::json!({"state":"READY","kind":"video"})).execute(&mut *tx).await?;
            tx.commit().await?;Ok::<_,AssetError>(())
        }.await;
        let successful = outcome.is_ok();
        if let Err(error) = outcome {
            let permanent = matches!(
                error,
                AssetError::Validation | AssetError::TooLarge | AssetError::VideoUnavailable
            );
            // Fencing prevents a stale process from publishing or changing a newer lease.
            sqlx::query("UPDATE assets SET state=CASE WHEN $3 OR attempts>=3 THEN 'FAILED' ELSE 'PROCESSING' END,error_code=CASE WHEN $3 THEN 'INVALID_VIDEO' ELSE 'VIDEO_PROCESSING_FAILED' END,bytes=CASE WHEN $3 OR attempts>=3 THEN 0 ELSE bytes END,lease_token=NULL,lease_until=CASE WHEN $3 OR attempts>=3 THEN NULL ELSE clock_timestamp()+interval '5 seconds' END WHERE id=$1 AND lease_token=$2 AND state='PROCESSING'").bind(id).bind(token).bind(permanent).execute(&self.db).await?;
            // Each attempt owns different keys; cleanup never deletes a newer output.
            // A lost COMMIT response may already have published this attempt. Lock
            // the row before deleting so an uncertain commit cannot lose READY media.
            let mut cleanup = self.db.begin().await?;
            let published: Option<String> =
                sqlx::query_scalar("SELECT object_key FROM assets WHERE id=$1 FOR UPDATE")
                    .bind(id)
                    .fetch_optional(&mut *cleanup)
                    .await?;
            for key in [&original, &thumb] {
                if published.as_deref() == Some(original.as_str()) {
                    break;
                }
                if self.storage.delete(key).await.is_ok() {
                    sqlx::query("UPDATE asset_blobs SET purged_at=clock_timestamp() WHERE object_key=$1 AND asset_id=$2").bind(key).bind(id).execute(&mut *cleanup).await?;
                }
            }
            cleanup.commit().await?;
        }
        if successful {
            let raw = format!("assets/{id}/source.bin");
            if self.storage.delete(&raw).await.is_ok() {
                let mut tx = self.db.begin().await?;
                sqlx::query("UPDATE asset_blobs SET purged_at=clock_timestamp() WHERE asset_id=$1 AND object_key=$2").bind(id).bind(&raw).execute(&mut *tx).await?;
                sqlx::query("UPDATE assets SET reserved_bytes=0 WHERE id=$1 AND state='READY'")
                    .bind(id)
                    .execute(&mut *tx)
                    .await?;
                tx.commit().await?;
            }
        }
        Ok(true)
    }
    pub async fn processing_loop(self) {
        let mut interval = tokio::time::interval(Duration::from_secs(2));
        loop {
            interval.tick().await;
            if self.process_next_video().await.is_err() {
                tracing::error!("Video processing unavailable; durable queue will retry");
            }
        }
    }
}
