use crate::AssetError;
use bytes::Bytes;
use object_store::{path::Path, GetOptions, GetRange, GetResult, ObjectStore, ObjectStoreExt};
use std::{ops::Range, path::PathBuf, sync::Arc, time::Duration};
#[derive(Clone)]
pub struct Storage {
    inner: Arc<dyn ObjectStore>,
}
#[derive(Clone)]
pub enum StorageConfig {
    Local(PathBuf),
    S3 {
        endpoint: String,
        bucket: String,
        region: String,
        access: String,
        secret: String,
    },
}
impl StorageConfig {
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Result<Self, &'static str> {
        let required = |key| lookup(key).filter(|v| !v.trim().is_empty()).ok_or(key);
        match lookup("MEDIA_STORAGE").as_deref().unwrap_or("local") {
            "local" => Ok(Self::Local(
                lookup("MEDIA_DIR")
                    .filter(|v| !v.trim().is_empty())
                    .unwrap_or_else(|| "data/media".into())
                    .into(),
            )),
            "s3" => Ok(Self::S3 {
                endpoint: required("S3_ENDPOINT")?,
                bucket: required("S3_BUCKET")?,
                region: required("S3_REGION")?,
                access: required("S3_ACCESS_KEY_ID")?,
                secret: required("S3_SECRET_ACCESS_KEY")?,
            }),
            _ => Err("MEDIA_STORAGE"),
        }
    }
    pub async fn build(self, web_dir: &std::path::Path) -> Result<Storage, AssetError> {
        match self {
            Self::Local(root) => {
                tokio::fs::create_dir_all(&root)
                    .await
                    .map_err(|_| AssetError::Store)?;
                let root = tokio::fs::canonicalize(root)
                    .await
                    .map_err(|_| AssetError::Store)?;
                if let Ok(web) = tokio::fs::canonicalize(web_dir).await {
                    if root.starts_with(&web) || web.starts_with(&root) {
                        return Err(AssetError::Store);
                    }
                }
                Storage::local(root).await
            }
            Self::S3 {
                endpoint,
                bucket,
                region,
                access,
                secret,
            } => Storage::s3(&endpoint, &bucket, &region, &access, &secret),
        }
    }
}
impl Storage {
    pub async fn local(root: PathBuf) -> Result<Self, AssetError> {
        tokio::fs::create_dir_all(&root)
            .await
            .map_err(|_| AssetError::Store)?;
        let store = object_store::local::LocalFileSystem::new_with_prefix(root)
            .map_err(|_| AssetError::Store)?;
        Ok(Self {
            inner: Arc::new(store),
        })
    }
    pub fn s3(
        endpoint: &str,
        bucket: &str,
        region: &str,
        access: &str,
        secret: &str,
    ) -> Result<Self, AssetError> {
        let url = reqwest::Url::parse(endpoint).map_err(|_| AssetError::Store)?;
        if url.scheme() != "https"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.host_str().is_none()
        {
            return Err(AssetError::Store);
        }
        let client = object_store::ClientOptions::new()
            .with_timeout(Duration::from_secs(30))
            .with_connect_timeout(Duration::from_secs(5));
        let store = object_store::aws::AmazonS3Builder::new()
            .with_endpoint(endpoint)
            .with_bucket_name(bucket)
            .with_region(region)
            .with_access_key_id(access)
            .with_secret_access_key(secret)
            .with_virtual_hosted_style_request(false)
            .with_client_options(client)
            .build()
            .map_err(|_| AssetError::Store)?;
        Ok(Self {
            inner: Arc::new(store),
        })
    }
    pub fn memory() -> Self {
        Self {
            inner: Arc::new(object_store::memory::InMemory::new()),
        }
    }
    pub async fn put(&self, key: &str, data: Vec<u8>) -> Result<(), AssetError> {
        self.put_bytes(key, data.into()).await?;
        Ok(())
    }
    pub async fn put_bytes(&self, key: &str, data: Bytes) -> Result<(), AssetError> {
        tokio::time::timeout(
            Duration::from_secs(30),
            self.inner.put(&Path::from(key), data.into()),
        )
        .await
        .map_err(|_| AssetError::Store)?
        .map_err(|_| AssetError::Store)?;
        Ok(())
    }
    pub async fn get(&self, key: &str, range: Range<u64>) -> Result<Bytes, AssetError> {
        tokio::time::timeout(
            Duration::from_secs(30),
            self.inner.get_range(&Path::from(key), range),
        )
        .await
        .map_err(|_| AssetError::Store)?
        .map_err(|_| AssetError::Store)
    }
    pub async fn stream(&self, key: &str, range: Range<u64>) -> Result<GetResult, AssetError> {
        let options = GetOptions::default().with_range(Some(GetRange::Bounded(range)));
        tokio::time::timeout(
            Duration::from_secs(30),
            self.inner.get_opts(&Path::from(key), options),
        )
        .await
        .map_err(|_| AssetError::Store)?
        .map_err(|_| AssetError::Store)
    }
    pub async fn delete(&self, key: &str) -> Result<(), AssetError> {
        match tokio::time::timeout(Duration::from_secs(30), self.inner.delete(&Path::from(key)))
            .await
            .map_err(|_| AssetError::Store)?
        {
            Ok(()) | Err(object_store::Error::NotFound { .. }) => Ok(()),
            Err(_) => Err(AssetError::Store),
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn local_storage_reads_ranges_and_deletes_idempotently() {
        let directory = tempfile::tempdir().unwrap();
        let store = Storage::local(directory.path().into()).await.unwrap();
        store
            .put("assets/test/original.png", b"abcdef".to_vec())
            .await
            .unwrap();
        assert_eq!(
            &store.get("assets/test/original.png", 1..4).await.unwrap()[..],
            b"bcd"
        );
        store.delete("assets/test/original.png").await.unwrap();
        store.delete("assets/test/original.png").await.unwrap();
        assert!(store.get("assets/test/original.png", 0..1).await.is_err());
    }
}
