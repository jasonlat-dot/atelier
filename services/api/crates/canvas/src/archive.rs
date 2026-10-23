use crate::{
    CanvasError, CanvasGraph, CanvasService, CreateProject, NodeContent, ProjectView,
    MAX_GRAPH_BYTES,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    io::{Cursor, Read, Write},
};
use tokio::sync::OwnedSemaphorePermit;
use uuid::Uuid;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};
pub const MAX_ARCHIVE_BYTES: usize = 256 * 1024 * 1024;
#[derive(Serialize, Deserialize)]
struct Manifest {
    format: String,
    version: u8,
    name: String,
    graph: CanvasGraph,
    assets: Vec<Media>,
}
#[derive(Serialize, Deserialize)]
struct Media {
    id: Uuid,
    path: String,
    name: String,
    kind: String,
}
struct Parsed {
    manifest: Manifest,
    files: HashMap<String, Vec<u8>>,
}
fn parse(bytes: Vec<u8>) -> Result<Parsed, CanvasError> {
    if bytes.len() > MAX_ARCHIVE_BYTES {
        return Err(CanvasError::TooLarge);
    }
    // Reject ZIP64/multi-disk and excessive central-directory counts before allocating entries.
    let end = bytes.len().checked_sub(22).ok_or(CanvasError::Validation)?;
    let offset = (bytes.len().saturating_sub(65557)..=end)
        .rev()
        .find(|&i| {
            bytes[i..i + 4] == *b"PK\x05\x06"
                && i + 22 + u16::from_le_bytes([bytes[i + 20], bytes[i + 21]]) as usize
                    == bytes.len()
        })
        .ok_or(CanvasError::Validation)?;
    let word = |i| u16::from_le_bytes([bytes[offset + i], bytes[offset + i + 1]]);
    let count = word(10);
    if word(4) != 0 || word(6) != 0 || word(8) != count || count > 501 {
        return Err(CanvasError::Validation);
    }
    let mut zip = ZipArchive::new(Cursor::new(bytes)).map_err(|_| CanvasError::Validation)?;
    if zip.len() > 501 {
        return Err(CanvasError::TooLarge);
    }
    let mut files = HashMap::new();
    let mut total = 0u64;
    for i in 0..zip.len() {
        let mut file = zip.by_index(i).map_err(|_| CanvasError::Validation)?;
        let name = file
            .name()
            .map_err(|_| CanvasError::Validation)?
            .into_owned();
        if file.is_dir()
            || file.is_symlink()
            || file.encrypted()
            || name.contains(['\\', ':', '\0'])
            || name
                .split('/')
                .any(|p| p.is_empty() || p == "." || p == "..")
            || files.contains_key(&name)
            || !(name == "project.json" || name.starts_with("assets/"))
        {
            return Err(CanvasError::Validation);
        }
        let max = if name == "project.json" {
            MAX_GRAPH_BYTES + 150000
        } else {
            atelier_assets::MAX_VIDEO_BYTES
        };
        if file.size() > max as u64 {
            return Err(CanvasError::TooLarge);
        }
        total = total
            .checked_add(file.size())
            .ok_or(CanvasError::TooLarge)?;
        if total > MAX_ARCHIVE_BYTES as u64 {
            return Err(CanvasError::TooLarge);
        }
        let mut data = Vec::new();
        (&mut file)
            .take(max as u64 + 1)
            .read_to_end(&mut data)
            .map_err(|_| CanvasError::Validation)?;
        if data.len() > max || data.len() as u64 != file.size() {
            return Err(CanvasError::Validation);
        }
        files.insert(name, data);
    }
    let manifest: Manifest = serde_json::from_slice(
        &files
            .remove("project.json")
            .ok_or(CanvasError::Validation)?,
    )
    .map_err(|_| CanvasError::Validation)?;
    if manifest.format != "atelier-project" || manifest.version != 1 || manifest.assets.len() > 500
    {
        return Err(CanvasError::Validation);
    }
    manifest.graph.validate()?;
    let mut ids = HashSet::new();
    let mut paths = HashSet::new();
    for media in &manifest.assets {
        let extension = match media.kind.as_str() {
            "image" => "png",
            "video" => "mp4",
            _ => return Err(CanvasError::Validation),
        };
        if media.id.is_nil()
            || media.path != format!("assets/{}.{extension}", media.id)
            || !ids.insert(media.id)
            || !paths.insert(media.path.clone())
            || !files.contains_key(&media.path)
            || media.name.is_empty()
            || media.name.chars().count() > 160
        {
            return Err(CanvasError::Validation);
        }
    }
    if paths.len() != files.len() || ids != manifest.graph.asset_ids().into_iter().collect() {
        return Err(CanvasError::Validation);
    }
    for node in &manifest.graph.nodes {
        match &node.content {
            NodeContent::Image(d)
                if !manifest
                    .assets
                    .iter()
                    .any(|a| a.id == d.asset_id && a.kind == "image") =>
            {
                return Err(CanvasError::Validation)
            }
            NodeContent::Video(d)
                if !manifest
                    .assets
                    .iter()
                    .any(|a| a.id == d.asset_id && a.kind == "video") =>
            {
                return Err(CanvasError::Validation)
            }
            _ => {}
        }
    }
    Ok(Parsed { manifest, files })
}
fn pack(manifest: Manifest, media: Vec<(String, Vec<u8>)>) -> Result<Vec<u8>, CanvasError> {
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    let opts = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Stored)
        .unix_permissions(0o600);
    zip.start_file("project.json", opts)
        .map_err(|_| CanvasError::Store)?;
    zip.write_all(&serde_json::to_vec(&manifest).map_err(|_| CanvasError::Store)?)
        .map_err(|_| CanvasError::Store)?;
    for (name, bytes) in media {
        zip.start_file(name, opts).map_err(|_| CanvasError::Store)?;
        zip.write_all(&bytes).map_err(|_| CanvasError::Store)?;
    }
    let bytes = zip.finish().map_err(|_| CanvasError::Store)?.into_inner();
    if bytes.len() > MAX_ARCHIVE_BYTES {
        return Err(CanvasError::TooLarge);
    }
    Ok(bytes)
}
impl CanvasService {
    pub fn archive_slot(&self) -> Result<OwnedSemaphorePermit, CanvasError> {
        self.archives
            .clone()
            .try_acquire_owned()
            .map_err(|_| CanvasError::Busy)
    }
    pub async fn export(&self, owner: Uuid, id: Uuid) -> Result<Vec<u8>, CanvasError> {
        let _slot = self.archive_slot()?;
        let p = self.get(owner, id).await?;
        let ids = p.graph.asset_ids();
        if p.assets.len() != ids.len() || p.assets.iter().any(|a| a.state != "READY") {
            return Err(CanvasError::NotFound);
        }
        let total: i64 = p.assets.iter().map(|a| a.bytes).sum();
        if total > MAX_ARCHIVE_BYTES as i64 - MAX_GRAPH_BYTES as i64 - 200000 {
            return Err(CanvasError::TooLarge);
        }
        let mut files = Vec::new();
        let mut media = Vec::new();
        for asset in p.assets {
            let path = format!(
                "assets/{}.{}",
                asset.id,
                if asset.kind == "image" { "png" } else { "mp4" }
            );
            files.push((
                path.clone(),
                self.assets.export_bytes(owner, asset.id).await?,
            ));
            media.push(Media {
                id: asset.id,
                path,
                name: asset.name,
                kind: asset.kind,
            });
        }
        let manifest = Manifest {
            format: "atelier-project".into(),
            version: 1,
            name: p.project.name,
            graph: p.graph,
            assets: media,
        };
        tokio::task::spawn_blocking(move || pack(manifest, files))
            .await
            .map_err(|_| CanvasError::Store)?
    }
    pub async fn import(
        &self,
        owner: Uuid,
        key: Uuid,
        bytes: Vec<u8>,
        _slot: OwnedSemaphorePermit,
    ) -> Result<ProjectView, CanvasError> {
        if key.is_nil() {
            return Err(CanvasError::Validation);
        }
        let mut digest = Sha256::new();
        digest.update(b"atelier-import\0");
        digest.update(&bytes);
        let hash = digest.finalize().to_vec();
        let old: Option<(Uuid, Vec<u8>)> = sqlx::query_as(
            "SELECT project_id,request_hash FROM project_requests WHERE owner_id=$1 AND key=$2",
        )
        .bind(owner)
        .bind(key)
        .fetch_optional(&self.db)
        .await?;
        if let Some((id, old_hash)) = old {
            if old_hash != hash {
                return Err(CanvasError::Validation);
            }
            return self.get(owner, id).await;
        }
        let Parsed {
            mut manifest,
            mut files,
        } = tokio::task::spawn_blocking(move || parse(bytes))
            .await
            .map_err(|_| CanvasError::Store)??;
        let mut remap = HashMap::new();
        for media in &manifest.assets {
            let bytes = files.remove(&media.path).ok_or(CanvasError::Validation)?;
            let asset = if media.kind == "image" {
                self.assets
                    .upload_image(owner, &media.name, "image/png", bytes)
                    .await?
            } else {
                self.assets
                    .upload_video(owner, &media.name, "video/mp4", bytes)
                    .await?
            };
            remap.insert(media.id, asset.id);
        }
        for node in &mut manifest.graph.nodes {
            match &mut node.content {
                NodeContent::Image(d) => {
                    d.asset_id = *remap.get(&d.asset_id).ok_or(CanvasError::Validation)?;
                    if let Some(gen) = &mut d.gen {
                        gen.job_id = Uuid::new_v4();
                        for id in &mut gen.references {
                            *id = *remap.get(id).ok_or(CanvasError::Validation)?;
                        }
                    }
                }
                NodeContent::Video(d) => {
                    d.asset_id = *remap.get(&d.asset_id).ok_or(CanvasError::Validation)?;
                    if let Some(gen) = &mut d.gen {
                        gen.job_id = Uuid::new_v4();
                        for id in &mut gen.references {
                            *id = *remap.get(id).ok_or(CanvasError::Validation)?;
                        }
                    }
                }
                NodeContent::Generate(d) => {
                    d.job_id = None;
                    d.status = Some("IDLE".into());
                    d.error = None;
                }
                _ => {}
            }
        }
        let project = self
            .create_hashed(
                owner,
                key,
                CreateProject {
                    name: manifest.name,
                    graph: manifest.graph,
                },
                Some(hash),
            )
            .await?;
        Ok(project)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn archive_rejects_traversal_extra_entries_and_missing_media() {
        let manifest = Manifest {
            format: "atelier-project".into(),
            version: 1,
            name: "Empty".into(),
            graph: CanvasGraph::default(),
            assets: vec![],
        };
        let bytes = pack(manifest, vec![]).unwrap();
        assert!(parse(bytes).is_ok());
        for name in [
            "../escape",
            "assets/../../escape",
            "assets\\file.png",
            "assets/extra.png",
        ] {
            let m = Manifest {
                format: "atelier-project".into(),
                version: 1,
                name: "Invalid".into(),
                graph: CanvasGraph::default(),
                assets: vec![],
            };
            assert!(parse(pack(m, vec![(name.into(), vec![1])]).unwrap()).is_err());
        }
    }
}
