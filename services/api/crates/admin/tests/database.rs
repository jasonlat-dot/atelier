use atelier_admin::*;
use atelier_auth::session::SessionSecrets;
use atelier_wallet::WalletService;
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use uuid::Uuid;
async fn user(db: &PgPool, role: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO users(id,google_sub,email,canonical_email,display_name,role) VALUES($1,$2,$2,$2,'Admin fixture',$3)").bind(id).bind(format!("{id}@gmail.com")).bind(role).execute(db).await.unwrap();
    let mut tx = db.begin().await.unwrap();
    WalletService::signup_in_transaction(&mut tx, id)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    id
}
async fn session(db: &PgPool, user: Uuid) {
    let s = SessionSecrets::generate().unwrap();
    sqlx::query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,$3,now()+interval '1 day')").bind(s.token_hash().as_slice()).bind(user).bind(s.csrf_token()).execute(db).await.unwrap();
}
async fn model(db: &PgPool) {
    sqlx::query("INSERT INTO models(id,kind,display_name,upstream_model,capabilities) VALUES('admin-fixture','image','Public fixture','private-native-id','{}') ON CONFLICT DO NOTHING").execute(db).await.unwrap();
}
async fn job(db: &PgPool, owner: Uuid) -> Uuid {
    model(db).await;
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO generation_jobs(id,owner_id,model_id,kind,model_revision,prompt,params,size,cost_per_output,n,cost,idempotency_key,request_hash) VALUES($1,$2,'admin-fixture','image',1,'private prompt','{\"quality\":\"low\"}','1024x1024',10,1,10,$3,$4)").bind(id).bind(owner).bind(Uuid::new_v4()).bind(vec![3u8;32]).execute(db).await.unwrap();
    WalletService::new(db.clone())
        .hold(owner, id, 10)
        .await
        .unwrap();
    id
}
fn action(revision: i64) -> AdminUserAction {
    AdminUserAction {
        revision,
        reason: "已核对管理员操作".into(),
        role: None,
    }
}
#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL"]
async fn user_governance_is_versioned_revokes_sessions_cancels_holds_and_preserves_last_super(
    db: PgPool,
) {
    let super_admin = user(&db, "SUPER_ADMIN").await;
    let admin = user(&db, "ADMIN").await;
    let owner = user(&db, "USER").await;
    session(&db, owner).await;
    let job = job(&db, owner).await;
    let s = AdminService::new(db.clone());
    assert!(matches!(
        s.user_action(admin, super_admin, "disable", &action(1))
            .await,
        Err(AdminError::Forbidden)
    ));
    assert!(matches!(
        s.user_action(super_admin, super_admin, "disable", &action(1))
            .await,
        Err(AdminError::Forbidden)
    ));
    assert!(matches!(
        s.user_action(
            super_admin,
            super_admin,
            "role",
            &AdminUserAction {
                role: Some("USER".into()),
                ..action(1)
            }
        )
        .await,
        Err(AdminError::LastAdmin)
    ));
    let u = s
        .user_action(admin, owner, "disable", &action(1))
        .await
        .unwrap();
    assert_eq!(u.status, "DISABLED");
    assert_eq!(u.held, 0);
    assert_eq!(
        s.jobs("", None, Some(owner), None).await.unwrap().items[0].status,
        "CANCELLED"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM sessions WHERE user_id=$1 AND revoked_at IS NULL"
        )
        .bind(owner)
        .fetch_one(&db)
        .await
        .unwrap(),
        0
    );
    assert!(matches!(
        s.user_action(admin, owner, "enable", &action(1)).await,
        Err(AdminError::Conflict)
    ));
    let u = s
        .user_action(admin, owner, "enable", &action(u.revision))
        .await
        .unwrap();
    assert_eq!(u.status, "ACTIVE");
    let key = Uuid::new_v4();
    s.adjust_credits(admin, owner, key, 5, "已核对充值")
        .await
        .unwrap();
    s.adjust_credits(admin, owner, key, 5, "已核对充值")
        .await
        .unwrap();
    assert_eq!(
        WalletService::new(db.clone())
            .summary(owner)
            .await
            .unwrap()
            .balance,
        25
    );
    assert!(s
        .adjust_credits(admin, super_admin, Uuid::new_v4(), 5, "不允许越权")
        .await
        .is_err());
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT status FROM generation_jobs WHERE id=$1")
            .bind(job)
            .fetch_one(&db)
            .await
            .unwrap(),
        "CANCELLED"
    );
    let serialized = serde_json::to_string(&s.user_detail(owner).await.unwrap()).unwrap();
    assert!(
        !serialized.contains("token_hash")
            && !serialized.contains("private-native-id")
            && !serialized.contains("private prompt")
    );
}
#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL"]
async fn job_compensation_is_once_under_concurrency_and_audit_failure_rolls_back(db: PgPool) {
    let admin = user(&db, "ADMIN").await;
    let owner = user(&db, "USER").await;
    let j = job(&db, owner).await;
    sqlx::query("UPDATE generation_jobs SET status='ROUTING' WHERE id=$1")
        .bind(j)
        .execute(&db)
        .await
        .unwrap();
    sqlx::query("UPDATE generation_jobs SET status='STORING' WHERE id=$1")
        .bind(j)
        .execute(&db)
        .await
        .unwrap();
    WalletService::new(db.clone())
        .settle(owner, j, 0, 10)
        .await
        .unwrap();
    sqlx::query("UPDATE generation_jobs SET status='SUCCEEDED',settled=10,finished_at=clock_timestamp() WHERE id=$1").bind(j).execute(&db).await.unwrap();
    let s = AdminService::new(db.clone());
    sqlx::query("CREATE FUNCTION reject_admin_refund() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='ADMIN_JOB_REFUND' THEN RAISE EXCEPTION 'audit failed'; END IF;RETURN NEW;END $$").execute(&db).await.unwrap();
    sqlx::query("CREATE TRIGGER reject_admin_refund BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_admin_refund()").execute(&db).await.unwrap();
    let input = AdminJobAction {
        reason: "已核对生成结果问题".into(),
        expected_credits: Some(10),
    };
    assert!(s
        .job_action(admin, j, Uuid::new_v4(), "refund", &input)
        .await
        .is_err());
    assert_eq!(
        WalletService::new(db.clone())
            .summary(owner)
            .await
            .unwrap()
            .balance,
        10
    );
    sqlx::query("DROP TRIGGER reject_admin_refund ON audit_logs")
        .execute(&db)
        .await
        .unwrap();
    let mut tasks = Vec::new();
    for _ in 0..12 {
        let s = s.clone();
        tasks.push(tokio::spawn(async move {
            s.job_action(
                admin,
                j,
                Uuid::new_v4(),
                "refund",
                &AdminJobAction {
                    reason: "已核对生成结果问题".into(),
                    expected_credits: Some(10),
                },
            )
            .await
            .unwrap()
        }));
    }
    for t in tasks {
        assert_eq!(t.await.unwrap().refunded, 10);
    }
    let wallet = WalletService::new(db.clone());
    assert_eq!(wallet.summary(owner).await.unwrap().balance, 20);
    assert!(wallet.reconcile().await.unwrap().is_empty());
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM credit_ledger WHERE type='REFUND'")
            .fetch_one(&db)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        s.jobs("", None, None, None).await.unwrap().items[0].status,
        "SUCCEEDED"
    );
}
#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL"]
async fn settings_are_super_only_validated_atomic_and_control_adjustment_limits(db: PgPool) {
    let root = user(&db, "SUPER_ADMIN").await;
    let admin = user(&db, "ADMIN").await;
    let owner = user(&db, "USER").await;
    let s = AdminService::new(db.clone());
    let initial = s.settings().await.unwrap();
    let mut values = initial.values;
    values.registration_mode = "INVITE_ONLY".into();
    values.signup_bonus = 42;
    values.admin_adjust_limit = 7;
    values.registration_whitelist = vec!["Test.Name+invite@gmail.com".into()];
    let mut update = AdminSettingsUpdate {
        revision: initial.revision,
        values,
        reason: "已核对注册与限额".into(),
    };
    assert!(matches!(
        s.save_settings(admin, &update).await,
        Err(AdminError::Forbidden)
    ));
    let saved = s.save_settings(root, &update).await.unwrap();
    assert_eq!(
        saved.values.registration_whitelist,
        vec!["testname@gmail.com"]
    );
    assert!(matches!(
        s.save_settings(root, &update).await,
        Err(AdminError::Conflict)
    ));
    assert!(s
        .adjust_credits(admin, owner, Uuid::new_v4(), 8, "超过限额")
        .await
        .is_err());
    update.revision = saved.revision;
    update.values.checkin_tz = "unknown/timezone".into();
    assert!(matches!(
        s.save_settings(root, &update).await,
        Err(AdminError::Validation)
    ));
    update.values.checkin_tz = "UTC".into();
    sqlx::query("CREATE FUNCTION reject_admin_settings() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='ADMIN_SETTINGS_UPDATED' THEN RAISE EXCEPTION 'audit failed'; END IF;RETURN NEW;END $$").execute(&db).await.unwrap();
    sqlx::query("CREATE TRIGGER reject_admin_settings BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_admin_settings()").execute(&db).await.unwrap();
    assert!(s.save_settings(root, &update).await.is_err());
    assert_eq!(
        s.settings().await.unwrap().values.checkin_tz,
        "Asia/Shanghai"
    );
}
#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL"]
async fn moderation_invites_and_redacted_audit_are_operable_without_secret_readback(db: PgPool) {
    let admin = user(&db, "ADMIN").await;
    let s = AdminService::new(db.clone());
    assert!(s
        .save_rule(
            admin,
            None,
            &AdminRuleInput {
                pattern: "[broken".into(),
                is_regex: true,
                enabled: true,
                revision: None,
                reason: "验证规则".into()
            }
        )
        .await
        .is_err());
    let r = s
        .save_rule(
            admin,
            None,
            &AdminRuleInput {
                pattern: "(?i)forbidden".into(),
                is_regex: true,
                enabled: true,
                revision: None,
                reason: "新增规则".into(),
            },
        )
        .await
        .unwrap();
    s.delete_rule(
        admin,
        r.id,
        &AdminRevisionReason {
            revision: r.revision,
            reason: "移除规则".into(),
        },
    )
    .await
    .unwrap();
    assert!(s.rules("", None).await.unwrap().items.is_empty());
    let v = s
        .create_invite(
            admin,
            &AdminInviteInput {
                label: "测试邀请".into(),
                max_uses: 1,
                expires_at: None,
                reason: "创建邀请".into(),
            },
        )
        .await
        .unwrap();
    let hash: Vec<u8> = sqlx::query_scalar("SELECT code_hash FROM invite_codes WHERE id=$1")
        .bind(v.invite.id)
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(hash, Sha256::digest(v.code.as_bytes()).to_vec());
    let serialized = serde_json::to_string(&s.invites("", None).await.unwrap()).unwrap();
    assert!(!serialized.contains(&v.code) && !serialized.contains("code_hash"));
    s.revoke_invite(
        admin,
        v.invite.id,
        &AdminRevisionReason {
            revision: 1,
            reason: "撤销邀请".into(),
        },
    )
    .await
    .unwrap();
    sqlx::query("INSERT INTO audit_logs(actor_id,action,before,after) VALUES($1,'REDACTION_FIXTURE',$2,$2)").bind(admin).bind(json!({"base_url":"private-endpoint","upstream_model":"private-model","nested":{"token_hash":"private-token","secret_enc":"private-secret","safe":"kept"}})).execute(&db).await.unwrap();
    let audit =
        serde_json::to_string(&s.audit_logs("REDACTION_FIXTURE", None).await.unwrap()).unwrap();
    for secret in [
        "private-endpoint",
        "private-model",
        "private-token",
        "private-secret",
    ] {
        assert!(!audit.contains(secret));
    }
    assert!(audit.contains("kept"));
    assert!(sqlx::query("DELETE FROM audit_logs")
        .execute(&db)
        .await
        .is_err());
}
#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL"]
async fn violation_threshold_disables_and_notifies_but_preserves_last_active_super(db: PgPool) {
    let owner = user(&db, "USER").await;
    let root = user(&db, "SUPER_ADMIN").await;
    session(&db, owner).await;
    let j = job(&db, owner).await;
    for _ in 0..5 {
        sqlx::query("INSERT INTO moderation_violations(user_id,source) VALUES($1,'local')")
            .bind(owner)
            .execute(&db)
            .await
            .unwrap();
    }
    let s = AdminService::new(db.clone());
    let d = s.user_detail(owner).await.unwrap();
    assert_eq!(d.user.status, "DISABLED");
    assert!(d.sessions.is_empty());
    assert!(s.jobs("", None, Some(owner), None).await.unwrap().items[0].cancel_requested);
    for _ in 0..5 {
        sqlx::query("INSERT INTO moderation_violations(user_id,source) VALUES($1,'local')")
            .bind(root)
            .execute(&db)
            .await
            .unwrap();
    }
    assert_eq!(s.user_detail(root).await.unwrap().user.status, "ACTIVE");
    let dashboard = s.dashboard(7).await.unwrap();
    assert_eq!(dashboard.pending_reviews, 2);
    assert_eq!(dashboard.daily.len(), 7);
    assert!(dashboard
        .notifications
        .iter()
        .any(|n| n.kind == "PROTECTED_ADMIN"));
    assert_eq!(dashboard.active_jobs, 1);
    assert_eq!(
        s.user_action(root, owner, "enable", &action(d.user.revision))
            .await
            .unwrap()
            .status,
        "ACTIVE"
    );
    assert_eq!(s.dashboard(7).await.unwrap().pending_reviews, 1);
    assert!(sqlx::query_scalar::<_, bool>(
        "SELECT cancel_requested FROM generation_jobs WHERE id=$1"
    )
    .bind(j)
    .fetch_one(&db)
    .await
    .unwrap());
}

#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL"]
async fn concurrent_role_changes_preserve_one_super_and_failed_disables_leave_sessions_live(
    db: PgPool,
) {
    let a = user(&db, "SUPER_ADMIN").await;
    let b = user(&db, "SUPER_ADMIN").await;
    let target = user(&db, "USER").await;
    session(&db, target).await;
    let s = AdminService::new(db.clone());
    let ca = AdminUserAction {
        role: Some("USER".into()),
        ..action(1)
    };
    let cb = AdminUserAction {
        role: Some("USER".into()),
        ..action(1)
    };
    let (first, second) = tokio::join!(
        s.user_action(a, a, "role", &ca),
        s.user_action(b, b, "role", &cb)
    );
    assert_ne!(first.is_ok(), second.is_ok());
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM users WHERE role='SUPER_ADMIN' AND status='ACTIVE'"
        )
        .fetch_one(&db)
        .await
        .unwrap(),
        1
    );
    let root = if first.is_err() { a } else { b };
    sqlx::query("CREATE FUNCTION reject_admin_disable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='ADMIN_USER_DISABLE' THEN RAISE EXCEPTION 'audit failed'; END IF;RETURN NEW;END $$").execute(&db).await.unwrap();
    sqlx::query("CREATE TRIGGER reject_admin_disable BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_admin_disable()").execute(&db).await.unwrap();
    assert!(s
        .user_action(root, target, "disable", &action(1))
        .await
        .is_err());
    assert_eq!(s.user_detail(target).await.unwrap().user.status, "ACTIVE");
    assert_eq!(s.user_detail(target).await.unwrap().sessions.len(), 1);
}
#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL"]
async fn dashboard_costs_use_explicit_currency_rates_and_personal_usage_cannot_mix_owners(
    db: PgPool,
) {
    let root = user(&db, "SUPER_ADMIN").await;
    let a = user(&db, "USER").await;
    let b = user(&db, "USER").await;
    let s = AdminService::new(db.clone());
    for owner in [a, b] {
        let j = job(&db, owner).await;
        sqlx::query("UPDATE generation_jobs SET status='ROUTING' WHERE id=$1")
            .bind(j)
            .execute(&db)
            .await
            .unwrap();
        sqlx::query("UPDATE generation_jobs SET status='STORING' WHERE id=$1")
            .bind(j)
            .execute(&db)
            .await
            .unwrap();
        WalletService::new(db.clone())
            .settle(owner, j, 0, 10)
            .await
            .unwrap();
        sqlx::query("UPDATE generation_jobs SET status='SUCCEEDED',settled=10,finished_at=clock_timestamp() WHERE id=$1").bind(j).execute(&db).await.unwrap();
    }
    let before = s.dashboard(7).await.unwrap();
    assert_eq!(before.unpriced_units, 2);
    assert!(before.estimated_costs.is_empty());
    let cfg = s.settings().await.unwrap();
    let mut values = cfg.values;
    values.upstream_cost_rates = vec![AdminCostRate {
        model_id: "admin-fixture".into(),
        currency: "CNY".into(),
        unit_cost_micros: 1234567,
    }];
    s.save_settings(
        root,
        &AdminSettingsUpdate {
            revision: cfg.revision,
            values,
            reason: "估算成本配置".into(),
        },
    )
    .await
    .unwrap();
    let view = s.dashboard(7).await.unwrap();
    assert_eq!(view.estimated_costs[0].currency, "CNY");
    assert_eq!(view.estimated_costs[0].amount_micros, 2469134);
    assert_eq!(view.unpriced_units, 0);
    assert_eq!(view.consumed_credits, 20);
    let usage = s.usage(a, 7).await.unwrap();
    assert_eq!(usage.daily.iter().map(|d| d.jobs).sum::<i64>(), 1);
    assert_eq!(usage.daily.iter().map(|d| d.consumed).sum::<i64>(), 10);
}
