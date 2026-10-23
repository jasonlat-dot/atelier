use atelier_upstream::{
    crypto::SecretCipher,
    egress::{EgressPolicy, SafeHttp},
    AccountInput, BindingInput, Error, ModelInput, PriceRule, QuotaInput, UpstreamService,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use sqlx::PgPool;
use uuid::Uuid;
async fn admin(db: &PgPool) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO users(id,google_sub,email,canonical_email,display_name,role) VALUES($1,$2,$2,$2,'Pool test','ADMIN')").bind(id).bind(format!("{id}@gmail.com")).execute(db).await.unwrap();
    id
}
fn service(db: &PgPool) -> UpstreamService {
    UpstreamService::new(
        db.clone(),
        SecretCipher::from_base64(&STANDARD.encode([81; 32])).unwrap(),
        SafeHttp::new(EgressPolicy::default()),
    )
}
fn account(name: &str) -> AccountInput {
    serde_json::from_value(serde_json::json!({"name":name,"base_url":"http://8.8.8.8:8080/v1","secret":"synthetic-upstream-secret-key","group_tag":"test-pool","priority":10,"weight":1,"concurrency_limit":2,"quota_total":100,"quota_remaining":100,"enabled":true})).unwrap()
}
fn model(enabled: bool, revision: Option<i64>) -> ModelInput {
    serde_json::from_value(serde_json::json!({"id":"public-image","kind":"image","display_name":"Creative image","upstream_model":"server-only-provider-model","enabled":enabled,"capabilities":{"qualities":["low","high"],"ratios":["1:1","16:9"],"resolutions":["1K","4K"],"max_n":4,"max_refs":4,"supports_edit":true},"sort_order":10,"revision":revision})).unwrap()
}
#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL"]
async fn management_is_versioned_encrypted_audited_and_models_need_valid_bindings_and_prices(
    db: PgPool,
) {
    let actor = admin(&db).await;
    let service = service(&db);
    let first = service
        .save_account(actor, None, account("Primary"))
        .await
        .unwrap();
    let view = serde_json::to_string(&first).unwrap();
    assert!(!view.contains("8.8.8.8"));
    assert!(!view.contains("synthetic-upstream-secret-key"));
    assert_eq!(first.secret_last4, "-key");
    let encrypted: Vec<u8> =
        sqlx::query_scalar("SELECT secret_enc FROM upstream_accounts WHERE id=$1")
            .bind(first.id)
            .fetch_one(&db)
            .await
            .unwrap();
    assert!(!encrypted.windows(9).any(|v| v == b"synthetic"));
    let mut update = account("Renamed");
    update.secret = None;
    update.base_url = None;
    update.revision = Some(first.revision);
    let edited = service
        .save_account(actor, Some(first.id), update)
        .await
        .unwrap();
    assert_eq!(edited.revision, first.revision + 1);
    let mut stale = account("Stale");
    stale.revision = Some(first.revision);
    assert!(matches!(
        service.save_account(actor, Some(first.id), stale).await,
        Err(Error::Conflict)
    ));
    assert!(service
        .save_model(actor, false, model(true, None))
        .await
        .is_err());
    let saved = service
        .save_model(actor, false, model(false, None))
        .await
        .unwrap();
    assert!(!serde_json::to_string(&saved)
        .unwrap()
        .contains("server-only-provider-model"));
    assert!(service
        .save_model(actor, true, model(true, Some(saved.revision)))
        .await
        .is_err());
    let bound = service
        .bind_accounts(
            actor,
            &saved.id,
            BindingInput {
                revision: saved.revision,
                account_ids: vec![],
                group_tags: vec!["test-pool".into()],
            },
        )
        .await
        .unwrap();
    let mut pricing = service.pricing().await.unwrap();
    pricing.rules = vec![
        PriceRule {
            model_id: saved.id.clone(),
            quality: "low".into(),
            base_credits: 10,
            edit_surcharge: 2,
        },
        PriceRule {
            model_id: saved.id.clone(),
            quality: "high".into(),
            base_credits: 30,
            edit_surcharge: 2,
        },
    ];
    service.save_pricing(actor, pricing).await.unwrap();
    let enabled = service
        .save_model(actor, true, model(true, Some(bound.revision)))
        .await
        .unwrap();
    assert!(enabled.enabled);
    let mut missing = service.pricing().await.unwrap();
    missing.rules.clear();
    assert!(service.save_pricing(actor, missing).await.is_err());
    assert_eq!(service.pricing().await.unwrap().rules.len(), 2);
    assert!(service
        .bind_accounts(
            actor,
            &saved.id,
            BindingInput {
                revision: enabled.revision,
                account_ids: vec![],
                group_tags: vec![]
            }
        )
        .await
        .is_err());
    let refreshed = service
        .refresh_quota(
            actor,
            first.id,
            QuotaInput {
                revision: edited.revision,
                quota_total: 200,
                quota_remaining: 150,
                quota_reset_at: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(refreshed.quota_remaining, 150);
    let logs: Vec<serde_json::Value> =
        sqlx::query_scalar("SELECT to_jsonb(a) FROM audit_logs a WHERE actor_id=$1")
            .bind(actor)
            .fetch_all(&db)
            .await
            .unwrap();
    let logs = serde_json::to_string(&logs).unwrap();
    assert!(!logs.contains("synthetic-upstream-secret-key"));
    assert!(!logs.contains("8.8.8.8"));
    assert!(!logs.contains("server-only-provider-model"));
    assert!(logs.contains("upstream.pricing.save"));
    service
        .delete_account(actor, first.id, refreshed.revision)
        .await
        .unwrap();
    assert!(service.account(first.id).await.is_err());
}
#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL"]
async fn imports_and_every_management_mutation_roll_back_on_audit_failure(db: PgPool) {
    let actor = admin(&db).await;
    let service = service(&db);
    let first = service
        .save_account(actor, None, account("Existing"))
        .await
        .unwrap();
    assert!(service
        .import_accounts(actor, vec![account("New account"), account("Existing")])
        .await
        .is_err());
    assert_eq!(service.accounts("", None).await.unwrap().items.len(), 1);
    sqlx::query("CREATE FUNCTION reject_upstream_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit rejection'; END $$").execute(&db).await.unwrap();
    sqlx::query("CREATE TRIGGER reject_upstream_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_upstream_audit()").execute(&db).await.unwrap();
    assert!(service
        .save_account(actor, None, account("Rejected"))
        .await
        .is_err());
    assert_eq!(service.accounts("", None).await.unwrap().items.len(), 1);
    assert!(service
        .refresh_quota(
            actor,
            first.id,
            QuotaInput {
                revision: first.revision,
                quota_total: 900,
                quota_remaining: 900,
                quota_reset_at: None
            }
        )
        .await
        .is_err());
    assert_eq!(
        service.account(first.id).await.unwrap().quota_remaining,
        100
    );
    assert!(service
        .delete_account(actor, first.id, first.revision)
        .await
        .is_err());
    assert!(service.account(first.id).await.is_ok());
    assert!(service
        .save_model(actor, false, model(false, None))
        .await
        .is_err());
    assert!(service.models().await.unwrap().is_empty());
}
