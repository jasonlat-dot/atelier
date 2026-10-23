use crate::{CanvasError, CanvasGraph, NodeContent};
use atelier_assets::{AssetService, AssetView};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{PgConnection, PgPool, Postgres, Transaction};
use utoipa::ToSchema;
use uuid::Uuid;

#[derive(Clone)]
pub struct CanvasService {
    pub(crate) db: PgPool,
    pub(crate) assets: AssetService,
    pub(crate) archives: std::sync::Arc<tokio::sync::Semaphore>,
}
#[derive(Serialize, ToSchema, sqlx::FromRow)]
pub struct ProjectInfo {
    pub id: Uuid,
    pub name: String,
    pub revision: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}
#[derive(Serialize, ToSchema)]
pub struct ProjectPage {
    pub items: Vec<ProjectInfo>,
    pub next_cursor: Option<Uuid>,
}
#[derive(Serialize, ToSchema)]
pub struct ProjectView {
    pub project: ProjectInfo,
    pub graph: CanvasGraph,
    pub assets: Vec<AssetView>,
}
#[derive(Clone, Serialize, Deserialize, ToSchema)]
pub struct CreateProject {
    pub name: String,
    #[serde(default)]
    pub graph: CanvasGraph,
}
#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct RenameProject {
    pub name: String,
}
#[derive(Serialize, ToSchema, sqlx::FromRow)]
pub struct ProjectSnapshot {
    pub id: Uuid,
    pub revision: i64,
    pub created_at: DateTime<Utc>,
}
#[derive(Serialize, ToSchema, sqlx::FromRow)]
pub struct ProjectReference {
    pub id: Uuid,
    pub name: String,
}
#[derive(sqlx::FromRow)]
struct Record {
    id: Uuid,
    name: String,
    revision: i64,
    graph: serde_json::Value,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}
impl Record {
    fn info(self) -> ProjectInfo {
        ProjectInfo {
            id: self.id,
            name: self.name,
            revision: self.revision,
            created_at: self.created_at,
            updated_at: self.updated_at,
        }
    }
    fn graph(&self) -> Result<CanvasGraph, CanvasError> {
        serde_json::from_value(self.graph.clone()).map_err(|_| CanvasError::Store)
    }
}
fn name(value: &str) -> Result<String, CanvasError> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 100 || value.chars().any(char::is_control) {
        return Err(CanvasError::Validation);
    }
    Ok(value.into())
}
async fn audit(
    tx: &mut PgConnection,
    owner: Uuid,
    id: Uuid,
    action: &str,
    revision: i64,
) -> Result<(), CanvasError> {
    sqlx::query("INSERT INTO audit_logs(actor_id,action,target_type,target_id,after) VALUES($1,$2,'project',$3,$4)")
        .bind(owner).bind(action).bind(id.to_string()).bind(serde_json::json!({"revision":revision})).execute(tx).await?;
    Ok(())
}
async fn refs(tx: &mut PgConnection, id: Uuid, graph: &CanvasGraph) -> Result<(), CanvasError> {
    sqlx::query("DELETE FROM project_assets WHERE project_id=$1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO project_assets(project_id,asset_id) SELECT $1,unnest($2::uuid[])")
        .bind(id)
        .bind(graph.asset_ids())
        .execute(tx)
        .await?;
    Ok(())
}
async fn snapshot(
    tx: &mut PgConnection,
    id: Uuid,
    revision: i64,
    graph: &serde_json::Value,
) -> Result<(), CanvasError> {
    sqlx::query("INSERT INTO project_snapshots(project_id,revision,graph) VALUES($1,$2,$3)")
        .bind(id)
        .bind(revision)
        .bind(graph)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM project_snapshots WHERE project_id=$1 AND revision<$2")
        .bind(id)
        .bind(revision.saturating_sub(49))
        .execute(tx)
        .await?;
    Ok(())
}
impl CanvasService {
    pub fn new(db: PgPool, assets: AssetService) -> Self {
        Self {
            db,
            assets,
            archives: std::sync::Arc::new(tokio::sync::Semaphore::new(1)),
        }
    }
    async fn transaction(
        &self,
        owner: Uuid,
    ) -> Result<Transaction<'static, Postgres>, CanvasError> {
        let mut tx = self.db.begin().await?;
        let active: Option<Uuid> =
            sqlx::query_scalar("SELECT id FROM users WHERE id=$1 AND status='ACTIVE' FOR UPDATE")
                .bind(owner)
                .fetch_optional(&mut *tx)
                .await?;
        if active.is_none() {
            return Err(CanvasError::NotFound);
        }
        Ok(tx)
    }
    async fn locked(
        tx: &mut PgConnection,
        owner: Uuid,
        id: Uuid,
        revision: i64,
    ) -> Result<Record, CanvasError> {
        let row: Record = sqlx::query_as(
            "SELECT * FROM projects WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE",
        )
        .bind(owner)
        .bind(id)
        .fetch_optional(tx)
        .await?
        .ok_or(CanvasError::NotFound)?;
        if row.revision != revision {
            return Err(CanvasError::Conflict);
        }
        Ok(row)
    }
    pub async fn list(
        &self,
        owner: Uuid,
        before: Option<Uuid>,
        limit: i64,
    ) -> Result<ProjectPage, CanvasError> {
        if !(1..=100).contains(&limit) {
            return Err(CanvasError::Validation);
        }
        let mut rows:Vec<ProjectInfo>=sqlx::query_as("SELECT id,name,revision,created_at,updated_at FROM projects WHERE owner_id=$1 AND deleted_at IS NULL AND ($2::uuid IS NULL OR (updated_at,id)<(SELECT updated_at,id FROM projects WHERE id=$2 AND owner_id=$1 AND deleted_at IS NULL)) ORDER BY updated_at DESC,id DESC LIMIT $3")
            .bind(owner).bind(before).bind(limit+1).fetch_all(&self.db).await?;
        let next = if rows.len() > limit as usize {
            rows.truncate(limit as usize);
            rows.last().map(|p| p.id)
        } else {
            None
        };
        Ok(ProjectPage {
            items: rows,
            next_cursor: next,
        })
    }
    pub async fn get(&self, owner: Uuid, id: Uuid) -> Result<ProjectView, CanvasError> {
        let row: Record = sqlx::query_as(
            "SELECT * FROM projects WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL",
        )
        .bind(owner)
        .bind(id)
        .fetch_optional(&self.db)
        .await?
        .ok_or(CanvasError::NotFound)?;
        self.view(owner, row).await
    }
    async fn view(&self, owner: Uuid, row: Record) -> Result<ProjectView, CanvasError> {
        let graph = row.graph()?;
        let assets = self.assets.canvas_views(owner, &graph.asset_ids()).await?;
        Ok(ProjectView {
            project: row.info(),
            graph,
            assets,
        })
    }
    pub async fn create(
        &self,
        owner: Uuid,
        key: Uuid,
        input: CreateProject,
    ) -> Result<ProjectView, CanvasError> {
        self.create_hashed(owner, key, input, None).await
    }
    pub(crate) async fn create_hashed(
        &self,
        owner: Uuid,
        key: Uuid,
        mut input: CreateProject,
        request_hash: Option<Vec<u8>>,
    ) -> Result<ProjectView, CanvasError> {
        if key.is_nil() {
            return Err(CanvasError::Validation);
        }
        input.name = name(&input.name)?;
        input.graph.validate()?;
        let hash = request_hash.unwrap_or(
            Sha256::digest(serde_json::to_vec(&input).map_err(|_| CanvasError::Validation)?)
                .to_vec(),
        );
        let mut tx = self.transaction(owner).await?;
        let previous: Option<(Uuid, Vec<u8>)> = sqlx::query_as(
            "SELECT project_id,request_hash FROM project_requests WHERE owner_id=$1 AND key=$2",
        )
        .bind(owner)
        .bind(key)
        .fetch_optional(&mut *tx)
        .await?;
        if let Some((id, old_hash)) = previous {
            if old_hash != hash {
                return Err(CanvasError::Validation);
            }
            tx.commit().await?;
            return self.get(owner, id).await;
        }
        let count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM projects WHERE owner_id=$1 AND deleted_at IS NULL",
        )
        .bind(owner)
        .fetch_one(&mut *tx)
        .await?;
        if count >= 100 {
            return Err(CanvasError::Quota);
        }
        AssetService::validate_canvas_assets(&mut tx, owner, &input.graph.asset_ids()).await?;
        let id = Uuid::new_v4();
        let graph = serde_json::to_value(&input.graph).map_err(|_| CanvasError::Validation)?;
        sqlx::query("INSERT INTO projects(id,owner_id,name,graph) VALUES($1,$2,$3,$4)")
            .bind(id)
            .bind(owner)
            .bind(input.name)
            .bind(&graph)
            .execute(&mut *tx)
            .await?;
        refs(&mut tx, id, &input.graph).await?;
        snapshot(&mut tx, id, 0, &graph).await?;
        sqlx::query("INSERT INTO project_requests(owner_id,key,request_hash,project_id) VALUES($1,$2,$3,$4)").bind(owner).bind(key).bind(hash).bind(id).execute(&mut *tx).await?;
        audit(&mut tx, owner, id, "project.create", 0).await?;
        let row: Record = sqlx::query_as("SELECT * FROM projects WHERE id=$1 AND owner_id=$2")
            .bind(id)
            .bind(owner)
            .fetch_one(&mut *tx)
            .await?;
        tx.commit().await?;
        self.view(owner, row).await
    }
    pub async fn save(
        &self,
        owner: Uuid,
        id: Uuid,
        revision: i64,
        graph: CanvasGraph,
    ) -> Result<ProjectView, CanvasError> {
        graph.validate()?;
        let mut tx = self.transaction(owner).await?;
        Self::locked(&mut tx, owner, id, revision).await?;
        Self::save_locked(&mut tx, owner, id, revision, &graph).await?;
        let row: Record = sqlx::query_as("SELECT * FROM projects WHERE id=$1 AND owner_id=$2")
            .bind(id)
            .bind(owner)
            .fetch_one(&mut *tx)
            .await?;
        tx.commit().await?;
        self.view(owner, row).await
    }
    async fn save_locked(
        tx: &mut PgConnection,
        owner: Uuid,
        id: Uuid,
        revision: i64,
        graph: &CanvasGraph,
    ) -> Result<(), CanvasError> {
        AssetService::validate_canvas_assets(tx, owner, &graph.asset_ids()).await?;
        let value = serde_json::to_value(graph).map_err(|_| CanvasError::Validation)?;
        sqlx::query("UPDATE projects SET graph=$2,revision=revision+1,updated_at=clock_timestamp() WHERE id=$1").bind(id).bind(&value).execute(&mut *tx).await?;
        refs(tx, id, graph).await?;
        snapshot(tx, id, revision + 1, &value).await?;
        audit(tx, owner, id, "project.save", revision + 1).await
    }
    pub async fn rename(
        &self,
        owner: Uuid,
        id: Uuid,
        revision: i64,
        new_name: &str,
    ) -> Result<ProjectView, CanvasError> {
        let new_name = name(new_name)?;
        let mut tx = self.transaction(owner).await?;
        let row = Self::locked(&mut tx, owner, id, revision).await?;
        sqlx::query("UPDATE projects SET name=$2,revision=revision+1,updated_at=clock_timestamp() WHERE id=$1").bind(id).bind(new_name).execute(&mut *tx).await?;
        snapshot(&mut tx, id, revision + 1, &row.graph).await?;
        audit(&mut tx, owner, id, "project.rename", revision + 1).await?;
        let row: Record = sqlx::query_as("SELECT * FROM projects WHERE id=$1 AND owner_id=$2")
            .bind(id)
            .bind(owner)
            .fetch_one(&mut *tx)
            .await?;
        tx.commit().await?;
        self.view(owner, row).await
    }
    pub async fn delete(&self, owner: Uuid, id: Uuid, revision: i64) -> Result<(), CanvasError> {
        let mut tx = self.transaction(owner).await?;
        Self::locked(&mut tx, owner, id, revision).await?;
        sqlx::query(
            "UPDATE projects SET deleted_at=clock_timestamp(),revision=revision+1 WHERE id=$1",
        )
        .bind(id)
        .execute(&mut *tx)
        .await?;
        sqlx::query("DELETE FROM project_assets WHERE project_id=$1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        audit(&mut tx, owner, id, "project.delete", revision + 1).await?;
        tx.commit().await?;
        Ok(())
    }
    pub async fn duplicate(
        &self,
        owner: Uuid,
        id: Uuid,
        key: Uuid,
    ) -> Result<ProjectView, CanvasError> {
        let mut old = self.get(owner, id).await?;
        for node in &mut old.graph.nodes {
            if let NodeContent::Generate(data) = &mut node.content {
                data.job_id = None;
                data.status = Some("IDLE".into());
                data.error = None;
            }
        }
        let name: String = format!(
            "{} 副本",
            old.project.name.chars().take(97).collect::<String>()
        );
        self.create(
            owner,
            key,
            CreateProject {
                name,
                graph: old.graph,
            },
        )
        .await
    }
    pub async fn snapshots(
        &self,
        owner: Uuid,
        id: Uuid,
    ) -> Result<Vec<ProjectSnapshot>, CanvasError> {
        self.get(owner, id).await?;
        Ok(sqlx::query_as("SELECT id,revision,created_at FROM project_snapshots WHERE project_id=$1 ORDER BY revision DESC LIMIT 50").bind(id).fetch_all(&self.db).await?)
    }
    pub async fn restore(
        &self,
        owner: Uuid,
        id: Uuid,
        revision: i64,
        snapshot_id: Uuid,
    ) -> Result<ProjectView, CanvasError> {
        let mut tx = self.transaction(owner).await?;
        Self::locked(&mut tx, owner, id, revision).await?;
        let value: serde_json::Value =
            sqlx::query_scalar("SELECT graph FROM project_snapshots WHERE project_id=$1 AND id=$2")
                .bind(id)
                .bind(snapshot_id)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or(CanvasError::NotFound)?;
        let graph: CanvasGraph = serde_json::from_value(value).map_err(|_| CanvasError::Store)?;
        graph.validate()?;
        Self::save_locked(&mut tx, owner, id, revision, &graph).await?;
        let row: Record = sqlx::query_as("SELECT * FROM projects WHERE id=$1 AND owner_id=$2")
            .bind(id)
            .bind(owner)
            .fetch_one(&mut *tx)
            .await?;
        tx.commit().await?;
        self.view(owner, row).await
    }
    pub async fn references(
        &self,
        owner: Uuid,
        asset: Uuid,
    ) -> Result<Vec<ProjectReference>, CanvasError> {
        Ok(sqlx::query_as("SELECT p.id,p.name FROM projects p JOIN project_assets a ON a.project_id=p.id WHERE p.owner_id=$1 AND a.asset_id=$2 AND p.deleted_at IS NULL ORDER BY p.updated_at DESC LIMIT 100").bind(owner).bind(asset).fetch_all(&self.db).await?)
    }
    /// Called inside the generation owner transaction before any wallet hold.
    pub async fn validate_generation_link(
        db: &mut PgConnection,
        owner: Uuid,
        project: Option<Uuid>,
        node: Option<&str>,
    ) -> Result<(), CanvasError> {
        match (project, node) {
            (None, None) => Ok(()),
            (Some(project), Some(node)) => {
                let value:serde_json::Value=sqlx::query_scalar("SELECT graph FROM projects WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL FOR SHARE").bind(project).bind(owner).fetch_optional(db).await?.ok_or(CanvasError::NotFound)?;
                let graph: CanvasGraph =
                    serde_json::from_value(value).map_err(|_| CanvasError::Store)?;
                if !graph
                    .nodes
                    .iter()
                    .any(|n| n.id == node && matches!(n.content, NodeContent::Generate(_)))
                {
                    return Err(CanvasError::Validation);
                }
                Ok(())
            }
            _ => Err(CanvasError::Validation),
        }
    }
}
