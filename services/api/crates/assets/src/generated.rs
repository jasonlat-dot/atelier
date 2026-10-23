//! Generated media stays private until the job/ledger publication transaction commits.
use crate::{imaging, AssetError, AssetService};
use sha2::{Digest, Sha256};
use sqlx::{PgConnection, Row};
use uuid::Uuid;
impl AssetService {
    pub async fn stage_generated(
        &self,
        owner: Uuid,
        job: Uuid,
        token: Uuid,
        kind: &str,
        mime: &str,
        bytes: Vec<u8>,
    ) -> Result<Uuid, AssetError> {
        let permit = tokio::time::timeout(
            std::time::Duration::from_secs(30),
            self.processing.clone().acquire_owned(),
        )
        .await
        .map_err(|_| AssetError::Busy)?
        .map_err(|_| AssetError::Store)?;
        let (original, thumbnail, width, height, duration) = if kind == "image" {
            let mime = mime.to_owned();
            let prepared = tokio::task::spawn_blocking(move || {
                let _permit = permit;
                imaging::prepare(&bytes, &mime)
            })
            .await
            .map_err(|_| AssetError::Store)??;
            (
                prepared.original,
                prepared.thumbnail,
                prepared.width as i32,
                prepared.height as i32,
                None,
            )
        } else if kind == "video" {
            let _permit = permit;
            let processor = self.video.as_ref().ok_or(AssetError::VideoUnavailable)?;
            let bytes: bytes::Bytes = bytes.into();
            processor.inspect_upload(bytes.clone(), mime).await?;
            let prepared = processor.transcode(bytes).await?;
            (
                prepared.original,
                prepared.thumbnail,
                prepared.info.width,
                prepared.info.height,
                Some(prepared.info.duration_ms),
            )
        } else {
            return Err(AssetError::Validation);
        };
        let id = Uuid::new_v4();
        let ext = if kind == "image" { "png" } else { "mp4" };
        let original_key = format!("assets/{id}/original.{ext}");
        let thumb_key = format!("assets/{id}/thumbnail.jpg");
        let hash = Sha256::digest(&original).to_vec();
        let (mut tx, retention) = self.reservation(owner, original.len() as i64).await?;
        let valid:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM generation_jobs WHERE id=$1 AND owner_id=$2 AND lease_token=$3 AND lease_until>clock_timestamp() AND status IN ('RUNNING','STORING') AND NOT cancel_requested)")
   .bind(job).bind(owner).bind(token).fetch_one(&mut *tx).await?;
        if !valid {
            return Err(AssetError::NotFound);
        }
        sqlx::query("INSERT INTO assets(id,owner_id,name,kind,source,object_key,thumb_key,mime,bytes,thumb_bytes,width,height,duration_ms,sha256,expires_at,lease_until,generation_job_id,generation_token,generation_published) VALUES($1,$2,$3,$4,'generated',$5,$6,$7,$8,$9,$10,$11,$12,$13,clock_timestamp()+make_interval(days=>$14),clock_timestamp()+interval '10 minutes',$15,$16,false)")
   .bind(id).bind(owner).bind(format!("Atelier-{}.{ext}",&id.to_string()[..8])).bind(kind).bind(&original_key).bind(&thumb_key).bind(if kind=="image"{"image/png"}else{"video/mp4"}).bind(original.len() as i64).bind(thumbnail.len() as i64).bind(width).bind(height).bind(duration).bind(hash).bind(retention).bind(job).bind(token).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO asset_blobs(object_key,asset_id) VALUES($1,$3),($2,$3)")
            .bind(&original_key)
            .bind(&thumb_key)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        if self.storage.put(&original_key, original).await.is_err()
            || self.storage.put(&thumb_key, thumbnail).await.is_err()
        {
            let _=sqlx::query("UPDATE assets SET deleted_at=clock_timestamp(),lease_until=NULL WHERE id=$1 AND NOT generation_published").bind(id).execute(&self.db).await;
            return Err(AssetError::Store);
        }
        Ok(id)
    }
    pub async fn publish_generated_in_transaction(
        db: &mut PgConnection,
        owner: Uuid,
        job: Uuid,
        ids: &[Uuid],
    ) -> Result<(), AssetError> {
        if ids.is_empty() || ids.len() > 4 {
            return Err(AssetError::Validation);
        }
        let rows=sqlx::query("SELECT id FROM assets WHERE id=ANY($1) AND owner_id=$2 AND generation_job_id=$3 AND NOT generation_published AND state='PROCESSING' AND deleted_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE")
   .bind(ids).bind(owner).bind(job).fetch_all(&mut *db).await?;
        if rows.len() != ids.len() {
            return Err(AssetError::NotFound);
        }
        sqlx::query("UPDATE assets SET generation_published=true,state='READY',upload_ready=true,lease_until=NULL WHERE id=ANY($1) AND owner_id=$2 AND generation_job_id=$3")
   .bind(ids).bind(owner).bind(job).execute(&mut *db).await?;
        sqlx::query("INSERT INTO audit_logs(actor_id,action,target_type,target_id,after) VALUES($1,'asset.generated','job',$2,$3)").bind(owner).bind(job.to_string()).bind(serde_json::json!({"asset_ids":ids})).execute(db).await?;
        Ok(())
    }
    pub async fn discard_generated(&self, owner: Uuid, job: Uuid) -> Result<(), AssetError> {
        sqlx::query("UPDATE assets SET deleted_at=coalesce(deleted_at,clock_timestamp()),lease_until=NULL WHERE owner_id=$1 AND generation_job_id=$2 AND NOT generation_published AND EXISTS(SELECT 1 FROM generation_jobs WHERE id=$2 AND owner_id=$1 AND status IN ('FAILED','CANCELLED'))")
   .bind(owner).bind(job).execute(&self.db).await?;
        Ok(())
    }
    pub async fn staged_ready_in_transaction(
        db: &mut PgConnection,
        owner: Uuid,
        job: Uuid,
    ) -> Result<Vec<(i32, Uuid)>, AssetError> {
        let rows=sqlx::query("SELECT o.idx,o.asset_id FROM generation_outputs o JOIN assets a ON a.id=o.asset_id WHERE o.job_id=$1 AND o.status='STAGED' AND a.owner_id=$2 AND a.generation_job_id=$1 AND a.generation_token=o.attempt_token AND NOT a.generation_published AND a.deleted_at IS NULL AND a.expires_at>clock_timestamp() ORDER BY o.idx")
   .bind(job).bind(owner).fetch_all(db).await?;
        Ok(rows
            .into_iter()
            .map(|r| (r.get("idx"), r.get("asset_id")))
            .collect())
    }
}
