use crate::{
    imaging, signing::MediaSigner, storage::Storage, views::AssetRecord, AssetError, AssetPage,
    AssetView,
};
use chrono::Utc;
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};
use std::{sync::Arc, time::Duration};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use uuid::Uuid;

#[derive(Clone)]
pub struct AssetService {
    pub(crate) db: PgPool,
    pub(crate) storage: Storage,
    pub(crate) signer: MediaSigner,
    ingest: Arc<Semaphore>,
    processing: Arc<Semaphore>,
    media: Arc<Semaphore>,
}
pub struct MediaData {
    pub bytes: bytes::Bytes,
    pub mime: String,
    pub total: u64,
    pub start: u64,
    pub end: u64,
    pub partial: bool,
}
impl AssetService {
    pub fn new(db: PgPool, storage: Storage, signer: MediaSigner) -> Self {
        Self {
            db,
            storage,
            signer,
            ingest: Arc::new(Semaphore::new(2)),
            processing: Arc::new(Semaphore::new(2)),
            media: Arc::new(Semaphore::new(16)),
        }
    }
    pub fn ingest_slot(&self) -> Result<OwnedSemaphorePermit, AssetError> {
        self.ingest
            .clone()
            .try_acquire_owned()
            .map_err(|_| AssetError::Busy)
    }
    pub async fn upload_image(
        &self,
        owner: Uuid,
        name: &str,
        mime: &str,
        bytes: Vec<u8>,
    ) -> Result<AssetView, AssetError> {
        let permit = self
            .processing
            .clone()
            .try_acquire_owned()
            .map_err(|_| AssetError::Busy)?;
        let mime = mime.to_owned();
        let prepared = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            imaging::prepare(&bytes, &mime)
        })
        .await
        .map_err(|_| AssetError::Store)??;
        let name = clean_name(name)?;
        let id = Uuid::new_v4();
        let object_key = format!("assets/{id}/original.png");
        let thumb_key = format!("assets/{id}/thumbnail.jpg");
        let hash = Sha256::digest(&prepared.original).to_vec();
        let mut tx = self.db.begin().await?;
        let active: Option<Uuid> =
            sqlx::query_scalar("SELECT id FROM users WHERE id=$1 AND status='ACTIVE' FOR UPDATE")
                .bind(owner)
                .fetch_optional(&mut *tx)
                .await?;
        if active.is_none() {
            return Err(AssetError::NotFound);
        }
        let quota=sqlx::query("SELECT count(*) AS count,coalesce(sum(bytes),0)::bigint AS bytes FROM assets WHERE owner_id=$1 AND deleted_at IS NULL AND expires_at>clock_timestamp()") .bind(owner).fetch_one(&mut *tx).await?;
        if quota.get::<i64, _>("count") >= 500
            || quota.get::<i64, _>("bytes") + prepared.original.len() as i64
                > 2 * 1024 * 1024 * 1024
        {
            return Err(AssetError::Quota);
        }
        let retention: serde_json::Value = sqlx::query_scalar(
            "SELECT value FROM system_settings WHERE key='asset_retention_days_free'",
        )
        .fetch_one(&mut *tx)
        .await?;
        let retention = retention
            .as_i64()
            .filter(|n| (1..=3650).contains(n))
            .ok_or(AssetError::Store)?;
        sqlx::query("INSERT INTO assets(id,owner_id,name,kind,source,object_key,thumb_key,mime,bytes,thumb_bytes,width,height,sha256,expires_at,lease_until) VALUES($1,$2,$3,'image','upload',$4,$5,'image/png',$6,$7,$8,$9,$10,clock_timestamp()+make_interval(days=>$11),clock_timestamp()+interval '5 minutes')")
            .bind(id).bind(owner).bind(&name).bind(&object_key).bind(&thumb_key).bind(prepared.original.len() as i64).bind(prepared.thumbnail.len() as i64).bind(prepared.width as i32).bind(prepared.height as i32).bind(hash).bind(retention as i32).execute(&mut *tx).await?;
        tx.commit().await?;
        let stored = async {
            self.storage.put(&object_key, prepared.original).await?;
            self.storage.put(&thumb_key, prepared.thumbnail).await?;
            Ok::<_, AssetError>(())
        }
        .await;
        if stored.is_err() {
            let _=sqlx::query("UPDATE assets SET deleted_at=clock_timestamp(),lease_until=NULL,error_code='STORAGE_FAILED',state='FAILED' WHERE id=$1 AND owner_id=$2").bind(id).bind(owner).execute(&self.db).await;
            return Err(AssetError::Store);
        }
        let mut tx = self.db.begin().await?;
        let result=sqlx::query("UPDATE assets SET state='READY',upload_ready=true,lease_until=NULL WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL AND expires_at>clock_timestamp()") .bind(id).bind(owner).execute(&mut *tx).await?;
        if result.rows_affected() != 1 {
            return Err(AssetError::Store);
        }
        sqlx::query("INSERT INTO audit_logs(actor_id,action,target_type,target_id,after) VALUES($1,'asset.upload','asset',$2,$3)").bind(owner).bind(id.to_string()).bind(serde_json::json!({"kind":"image","name":name})).execute(&mut *tx).await?;
        tx.commit().await?;
        self.get(owner, id).await
    }
    fn view(&self, row: AssetRecord) -> AssetView {
        let expires = std::cmp::min(Utc::now().timestamp() + 300, row.expires_at.timestamp());
        let ready = row.state == "READY";
        AssetView {
            id: row.id,
            name: row.name,
            kind: row.kind,
            source: row.source,
            state: row.state,
            error_code: row.error_code,
            bytes: row.bytes,
            width: row.width,
            height: row.height,
            duration_ms: row.duration_ms,
            media_url: ready.then(|| self.signer.url(row.owner_id, row.id, "original", expires)),
            thumbnail_url: ready
                .then(|| self.signer.url(row.owner_id, row.id, "thumbnail", expires)),
            expires_at: row.expires_at,
            created_at: row.created_at,
        }
    }
    pub async fn get(&self, owner: Uuid, id: Uuid) -> Result<AssetView, AssetError> {
        Ok(self.view(self.record(owner, id).await?))
    }
    async fn record(&self, owner: Uuid, id: Uuid) -> Result<AssetRecord, AssetError> {
        sqlx::query_as("SELECT * FROM assets WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL AND expires_at>clock_timestamp()") .bind(id).bind(owner).fetch_optional(&self.db).await?.ok_or(AssetError::NotFound)
    }
    pub async fn list(
        &self,
        owner: Uuid,
        kind: Option<String>,
        source: Option<String>,
        search: String,
        before: Option<Uuid>,
        limit: i64,
    ) -> Result<AssetPage, AssetError> {
        if !(1..=100).contains(&limit)
            || search.chars().count() > 100
            || kind
                .as_deref()
                .is_some_and(|v| !matches!(v, "image" | "video"))
            || source
                .as_deref()
                .is_some_and(|v| !matches!(v, "upload" | "generated"))
        {
            return Err(AssetError::Validation);
        }
        let mut rows:Vec<AssetRecord>=sqlx::query_as("SELECT * FROM assets WHERE owner_id=$1 AND deleted_at IS NULL AND expires_at>clock_timestamp() AND ($2::text IS NULL OR kind=$2) AND ($3::text IS NULL OR source=$3) AND strpos(lower(name),lower($4))>0 AND ($5::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM assets WHERE id=$5 AND owner_id=$1)) ORDER BY created_at DESC,id DESC LIMIT $6")
            .bind(owner).bind(&kind).bind(&source).bind(&search).bind(before).bind(limit+1).fetch_all(&self.db).await?;
        let total:i64=sqlx::query_scalar("SELECT count(*) FROM assets WHERE owner_id=$1 AND deleted_at IS NULL AND expires_at>clock_timestamp() AND ($2::text IS NULL OR kind=$2) AND ($3::text IS NULL OR source=$3) AND strpos(lower(name),lower($4))>0") .bind(owner).bind(kind).bind(source).bind(search).fetch_one(&self.db).await?;
        let more = rows.len() > limit as usize;
        rows.truncate(limit as usize);
        let next_cursor = if more {
            rows.last().map(|r| r.id)
        } else {
            None
        };
        Ok(AssetPage {
            items: rows.into_iter().map(|r| self.view(r)).collect(),
            next_cursor,
            total,
        })
    }
    pub async fn delete(&self, owner: Uuid, ids: Vec<Uuid>) -> Result<(), AssetError> {
        if ids.is_empty() || ids.len() > 100 {
            return Err(AssetError::Validation);
        }
        let ids: std::collections::HashSet<_> = ids.into_iter().collect();
        let ids: Vec<_> = ids.into_iter().collect();
        let mut tx = self.db.begin().await?;
        let found:Vec<Uuid>=sqlx::query_scalar("SELECT id FROM assets WHERE owner_id=$1 AND id=ANY($2) AND deleted_at IS NULL AND expires_at>clock_timestamp() ORDER BY id FOR UPDATE") .bind(owner).bind(&ids).fetch_all(&mut *tx).await?;
        if found.len() != ids.len() {
            return Err(AssetError::NotFound);
        }
        sqlx::query(
            "UPDATE assets SET deleted_at=clock_timestamp() WHERE owner_id=$1 AND id=ANY($2)",
        )
        .bind(owner)
        .bind(&ids)
        .execute(&mut *tx)
        .await?;
        sqlx::query("INSERT INTO audit_logs(actor_id,action,target_type,after) VALUES($1,'asset.delete','asset',$2)").bind(owner).bind(serde_json::json!({"ids":ids})).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(())
    }
    pub async fn media(
        &self,
        owner: Uuid,
        id: Uuid,
        variant: &str,
        expires: i64,
        signature: &str,
        range: Option<&str>,
    ) -> Result<MediaData, AssetError> {
        let _slot = self
            .media
            .clone()
            .try_acquire_owned()
            .map_err(|_| AssetError::Busy)?;
        self.signer.verify(
            owner,
            id,
            variant,
            expires,
            signature,
            Utc::now().timestamp(),
        )?;
        let row = self.record(owner, id).await?;
        if row.state != "READY" {
            return Err(AssetError::NotFound);
        }
        let (key, total, mime) = if variant == "thumbnail" {
            (row.thumb_key, row.thumb_bytes, "image/jpeg".to_owned())
        } else {
            (row.object_key, row.bytes, row.mime)
        };
        let total = total as u64;
        let (start, end) = parse_range(range, total)?;
        let bytes = self.storage.get(&key, start..end).await?;
        if bytes.len() as u64 != end - start {
            return Err(AssetError::Store);
        }
        Ok(MediaData {
            bytes,
            mime,
            total,
            start,
            end,
            partial: range.is_some(),
        })
    }
    pub async fn cleanup(&self) -> Result<u64, AssetError> {
        sqlx::query("UPDATE assets SET deleted_at=coalesce(deleted_at,clock_timestamp()) WHERE purged_at IS NULL AND deleted_at IS NULL AND (expires_at<=clock_timestamp() OR (state='PROCESSING' AND upload_ready=false AND created_at<clock_timestamp()-interval '10 minutes'))") .execute(&self.db).await?;
        let mut tx = self.db.begin().await?;
        let rows:Vec<AssetRecord>=sqlx::query_as("SELECT * FROM assets WHERE deleted_at IS NOT NULL AND purged_at IS NULL AND (lease_until IS NULL OR lease_until<clock_timestamp()) ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED").fetch_all(&mut *tx).await?;
        let count = rows.len() as u64;
        for row in rows {
            self.storage.delete(&row.object_key).await?;
            self.storage.delete(&row.thumb_key).await?;
            self.storage
                .delete(&format!("assets/{}/source.bin", row.id))
                .await?;
            sqlx::query("UPDATE assets SET purged_at=clock_timestamp() WHERE id=$1")
                .bind(row.id)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        Ok(count)
    }
    pub async fn maintenance_loop(self) {
        let mut interval = tokio::time::interval(Duration::from_secs(60));
        loop {
            interval.tick().await;
            if self.cleanup().await.is_err() {
                tracing::error!("Media retention cleanup failed; will retry");
            }
        }
    }
}
fn clean_name(name: &str) -> Result<String, AssetError> {
    let name: String = name.chars().filter(|c| !c.is_control()).take(160).collect();
    let name = name.trim();
    if name.is_empty() {
        return Err(AssetError::Validation);
    }
    Ok(name.into())
}
fn parse_range(range: Option<&str>, total: u64) -> Result<(u64, u64), AssetError> {
    let Some(range) = range else {
        return Ok((0, total));
    };
    let (a, b) = range
        .strip_prefix("bytes=")
        .and_then(|r| r.split_once('-'))
        .ok_or(AssetError::Validation)?;
    let (start, end) = if a.is_empty() {
        let size: u64 = b.parse().map_err(|_| AssetError::Validation)?;
        (total.saturating_sub(size), total)
    } else {
        let start: u64 = a.parse().map_err(|_| AssetError::Validation)?;
        let end = if b.is_empty() {
            total
        } else {
            b.parse::<u64>()
                .map_err(|_| AssetError::Validation)?
                .saturating_add(1)
                .min(total)
        };
        (start, end)
    };
    if start >= end || end > total {
        return Err(AssetError::Validation);
    }
    Ok((start, end))
}
