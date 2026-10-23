use atelier_assets::{signing::MediaSigner, storage::Storage, AssetService};
use atelier_canvas::*;
use sqlx::PgPool;
use uuid::Uuid;
async fn user(db: &PgPool) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO users(id,google_sub,email,canonical_email,display_name) VALUES($1,$2,$2,$2,'Canvas test')").bind(id).bind(format!("{id}@gmail.com")).execute(db).await.unwrap();
    id
}
fn services(db: &PgPool) -> (CanvasService, AssetService) {
    let assets = AssetService::new(
        db.clone(),
        Storage::memory(),
        MediaSigner::from_base64("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=").unwrap(),
    );
    (CanvasService::new(db.clone(), assets.clone()), assets)
}
fn text_graph(text: &str) -> CanvasGraph {
    serde_json::from_value(serde_json::json!({"version":1,"nodes":[{"id":"text","type":"text","data":{"text":text},"position":{"x":10,"y":20},"size":{"width":240,"height":160}}],"edges":[],"viewport":{"x":0,"y":0,"zoom":1},"background":"dots"})).unwrap()
}
#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL"]
async fn projects_are_versioned_private_idempotent_and_soft_deleted(db: PgPool) {
    let owner = user(&db).await;
    let other = user(&db).await;
    let (service, _) = services(&db);
    let key = Uuid::new_v4();
    let input = CreateProject {
        name: " First ".into(),
        graph: text_graph("original"),
    };
    let first = service.create(owner, key, input.clone()).await.unwrap();
    let id = first.project.id;
    assert_eq!(first.project.name, "First");
    assert_eq!(first.project.revision, 0);
    assert_eq!(
        service.create(owner, key, input).await.unwrap().project.id,
        id
    );
    assert!(matches!(
        service
            .create(
                owner,
                key,
                CreateProject {
                    name: "Different".into(),
                    graph: CanvasGraph::default()
                }
            )
            .await,
        Err(CanvasError::Validation)
    ));
    assert!(matches!(
        service.get(other, id).await,
        Err(CanvasError::NotFound)
    ));
    assert!(service
        .list(other, None, 25)
        .await
        .unwrap()
        .items
        .is_empty());
    let (a, b) = tokio::join!(
        service.save(owner, id, 0, text_graph("a")),
        service.save(owner, id, 0, text_graph("b"))
    );
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    assert!(matches!(a, Err(CanvasError::Conflict)) || matches!(b, Err(CanvasError::Conflict)));
    assert!(matches!(
        service.delete(owner, id, 0).await,
        Err(CanvasError::Conflict)
    ));
    let snapshots = service.snapshots(owner, id).await.unwrap();
    assert_eq!(snapshots.len(), 2);
    let restored = service
        .restore(owner, id, 1, snapshots[1].id)
        .await
        .unwrap();
    assert_eq!(restored.project.revision, 2);
    if let NodeContent::Text(data) = &restored.graph.nodes[0].content {
        assert_eq!(data.text, "original");
    } else {
        panic!("text node");
    }
    let copy = service.duplicate(owner, id, Uuid::new_v4()).await.unwrap();
    assert_ne!(copy.project.id, id);
    assert_eq!(copy.graph.nodes.len(), 1);
    service.rename(owner, id, 2, "Renamed").await.unwrap();
    service.delete(owner, id, 3).await.unwrap();
    assert!(matches!(
        service.get(owner, id).await,
        Err(CanvasError::NotFound)
    ));
    assert_eq!(service.list(owner, None, 25).await.unwrap().items.len(), 1);
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM projects WHERE id=$1 AND deleted_at IS NOT NULL")
            .bind(id)
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(count, 1);
}
#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL"]
async fn foreign_assets_and_generation_links_are_rejected_and_missing_media_remains_editable(
    db: PgPool,
) {
    let owner = user(&db).await;
    let other = user(&db).await;
    let (service, assets) = services(&db);
    // The existing asset service supplies metadata; no media bytes are needed for graph ownership.
    let asset = Uuid::new_v4();
    sqlx::query("INSERT INTO assets(id,owner_id,name,kind,source,state,object_key,thumb_key,mime,bytes,thumb_bytes,width,height,sha256,expires_at) VALUES($1,$2,'test','image','upload','READY',$3,$3,'image/png',1,1,100,100,decode(repeat('00',32),'hex'),now()+interval '1 day')").bind(asset).bind(owner).bind(asset.to_string()).execute(&db).await.unwrap();
    let mut graph = text_graph("ref");
    graph.nodes.push(serde_json::from_value(serde_json::json!({"id":"media","type":"image","data":{"assetId":asset,"naturalW":100,"naturalH":100,"url":"https://should-be-dropped.invalid"},"position":{"x":100,"y":100},"size":{"width":240,"height":240}})).unwrap());
    assert!(matches!(
        service
            .create(
                other,
                Uuid::new_v4(),
                CreateProject {
                    name: "Foreign".into(),
                    graph: graph.clone()
                }
            )
            .await,
        Err(CanvasError::NotFound)
    ));
    let project = service
        .create(
            owner,
            Uuid::new_v4(),
            CreateProject {
                name: "Owned".into(),
                graph: graph.clone(),
            },
        )
        .await
        .unwrap();
    assert_eq!(project.assets.len(), 1);
    assert_eq!(service.references(owner, asset).await.unwrap().len(), 1);
    assert!(service.references(other, asset).await.unwrap().is_empty());
    assets.delete(owner, vec![asset]).await.unwrap();
    let saved = service
        .save(owner, project.project.id, 0, graph)
        .await
        .unwrap();
    assert!(saved.assets.is_empty());
    let mut tx = db.begin().await.unwrap();
    assert!(matches!(
        CanvasService::validate_generation_link(
            &mut tx,
            other,
            Some(saved.project.id),
            Some("text")
        )
        .await,
        Err(CanvasError::NotFound)
    ));
    assert!(matches!(
        CanvasService::validate_generation_link(
            &mut tx,
            owner,
            Some(saved.project.id),
            Some("text")
        )
        .await,
        Err(CanvasError::Validation)
    ));
    assert!(
        CanvasService::validate_generation_link(&mut tx, owner, None, None)
            .await
            .is_ok()
    );
}
#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL"]
async fn snapshot_retention_and_audit_failure_are_transactional(db: PgPool) {
    let owner = user(&db).await;
    let (service, _) = services(&db);
    let p = service
        .create(
            owner,
            Uuid::new_v4(),
            CreateProject {
                name: "History".into(),
                graph: CanvasGraph::default(),
            },
        )
        .await
        .unwrap();
    for revision in 0..52 {
        service
            .save(
                owner,
                p.project.id,
                revision,
                text_graph(&revision.to_string()),
            )
            .await
            .unwrap();
    }
    let history = service.snapshots(owner, p.project.id).await.unwrap();
    assert_eq!(history.len(), 50);
    assert_eq!(history.last().unwrap().revision, 3);
    sqlx::query("CREATE FUNCTION fail_canvas_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='project.save' THEN RAISE EXCEPTION 'test audit failure'; END IF; RETURN NEW; END $$").execute(&db).await.unwrap();
    sqlx::query("CREATE TRIGGER fail_canvas_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_canvas_audit()").execute(&db).await.unwrap();
    assert!(matches!(
        service
            .save(owner, p.project.id, 52, text_graph("rollback"))
            .await,
        Err(CanvasError::Store)
    ));
    assert_eq!(
        service
            .get(owner, p.project.id)
            .await
            .unwrap()
            .project
            .revision,
        52
    );
    assert_eq!(
        service.snapshots(owner, p.project.id).await.unwrap()[0].revision,
        52
    );
}

#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL"]
async fn project_zip_roundtrip_reowns_media_and_import_retry_returns_one_project(db: PgPool) {
    let owner = user(&db).await;
    let other = user(&db).await;
    let (service, assets) = services(&db);
    let png = include_bytes!("../../app/tests/fixtures/reference.png");
    let asset = assets
        .upload_image(owner, "Reference.png", "image/png", png.to_vec())
        .await
        .unwrap();
    let mut graph = text_graph("Portable");
    graph.nodes.push(serde_json::from_value(serde_json::json!({"id":"media","type":"image","data":{"assetId":asset.id,"naturalW":16,"naturalH":12},"position":{"x":100,"y":100},"size":{"width":240,"height":240}})).unwrap());
    let source = service
        .create(
            owner,
            Uuid::new_v4(),
            CreateProject {
                name: "Portable".into(),
                graph,
            },
        )
        .await
        .unwrap();
    assert!(matches!(
        service.export(other, source.project.id).await,
        Err(CanvasError::NotFound)
    ));
    let zip = service.export(owner, source.project.id).await.unwrap();
    let key = Uuid::new_v4();
    let imported = service
        .import(other, key, zip.clone(), service.archive_slot().unwrap())
        .await
        .unwrap();
    assert_ne!(source.project.id, imported.project.id);
    assert_ne!(asset.id, imported.graph.asset_ids()[0]);
    assert_eq!(imported.assets.len(), 1);
    assert!(assets.get(owner, imported.assets[0].id).await.is_err());
    let retry = service
        .import(other, key, zip.clone(), service.archive_slot().unwrap())
        .await
        .unwrap();
    assert_eq!(retry.project.id, imported.project.id);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM assets WHERE owner_id=$1")
        .bind(other)
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(count, 1);
    let mut changed = zip;
    changed.push(1);
    assert!(matches!(
        service
            .import(other, key, changed, service.archive_slot().unwrap())
            .await,
        Err(CanvasError::Validation)
    ));
}
