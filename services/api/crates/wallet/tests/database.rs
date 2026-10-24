use atelier_wallet::{CreateCodesRequest, Operation, WalletError, WalletService};
use base64::{engine::general_purpose::STANDARD, Engine};
use sqlx::PgPool;
use uuid::Uuid;

fn recoverable_wallet(pool: PgPool) -> WalletService {
    WalletService::new(pool).with_code_cipher(
        atelier_wallet::RedeemCodeCipher::from_base64(&STANDARD.encode([71; 32])).unwrap(),
    )
}

async fn user(pool: &PgPool) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO users(id,google_sub,email,canonical_email,display_name) VALUES($1,$2,$2,$2,'Wallet test')")
        .bind(id).bind(format!("{id}@gmail.com")).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO wallets(user_id) VALUES($1)")
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
    id
}

#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL; run explicitly"]
async fn redeem_capacity_retries_expiry_and_pagination_are_atomic(pool: PgPool) {
    let actor = user(&pool).await;
    let wallet = recoverable_wallet(pool.clone());
    let codes = wallet
        .create_codes(
            actor,
            &CreateCodesRequest {
                count: 2,
                credits: 25,
                max_uses: 1,
                expires_at: None,
            },
        )
        .await
        .unwrap();
    let owner = user(&pool).await;
    let other = user(&pool).await;
    let code = codes.codes[0].code.clone();
    let key = Uuid::new_v4();
    let mut tasks = Vec::new();
    for _ in 0..100 {
        let wallet = wallet.clone();
        let code = code.clone();
        tasks.push(tokio::spawn(async move {
            wallet.redeem(owner, key, &code).await.unwrap()
        }));
    }
    for task in tasks {
        assert_eq!(task.await.unwrap().credits, 25)
    }
    assert!(matches!(
        wallet.redeem(owner, key, &codes.codes[1].code).await,
        Err(WalletError::Conflict)
    ));
    assert!(matches!(
        wallet.redeem(other, Uuid::new_v4(), &code).await,
        Err(WalletError::InvalidCode)
    ));
    assert!(wallet.redeem(owner, Uuid::new_v4(), &code).await.is_err());
    sqlx::query("UPDATE redeem_codes SET expires_at=now()-interval '1 second' WHERE id=$1")
        .bind(codes.codes[1].id)
        .execute(&pool)
        .await
        .unwrap();
    assert!(wallet
        .redeem(owner, Uuid::new_v4(), &codes.codes[1].code)
        .await
        .is_err());
    // Global max_uses must also hold with competing users.
    let shared = wallet
        .create_codes(
            actor,
            &CreateCodesRequest {
                count: 1,
                credits: 5,
                max_uses: 1,
                expires_at: None,
            },
        )
        .await
        .unwrap()
        .codes
        .remove(0)
        .code;
    let (a, b) = tokio::join!(
        wallet.redeem(owner, Uuid::new_v4(), &shared),
        wallet.redeem(other, Uuid::new_v4(), &shared)
    );
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    wallet.grant(owner, 1, "page:1").await.unwrap();
    let first = wallet.ledger(owner, None, 1).await.unwrap();
    let next = wallet.ledger(owner, first.next_cursor, 1).await.unwrap();
    assert!(first.items[0].id > next.items[0].id);
    assert!(wallet.reconcile().await.unwrap().is_empty());
    let stored: String =
        sqlx::query_scalar("SELECT encode(code_hash,'hex') FROM redeem_codes WHERE id=$1")
            .bind(codes.codes[0].id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_ne!(stored, code);
    let recovered = wallet.reveal_code(actor, codes.codes[0].id).await.unwrap();
    assert_eq!(recovered.code, code);
    let listed = wallet.codes(None).await.unwrap();
    assert!(listed
        .iter()
        .any(|item| item.id == codes.codes[0].id && item.copyable));
    let metadata = serde_json::to_string(&listed).unwrap();
    assert!(!metadata.contains(&code));
    let log: serde_json::Value = sqlx::query_scalar(
        "SELECT after FROM audit_logs WHERE action='REDEEM_CODE_REVEALED' AND target_id=$1",
    )
    .bind(codes.codes[0].id.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(!log.to_string().contains(&code));
    sqlx::query("UPDATE redeem_codes SET code_enc=NULL WHERE id=$1")
        .bind(codes.codes[0].id)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        wallet.reveal_code(actor, codes.codes[0].id).await.err(),
        Some(WalletError::CodeNotRecoverable)
    );
    wallet
        .create_codes(
            actor,
            &CreateCodesRequest {
                count: 52,
                credits: 1,
                max_uses: 1,
                expires_at: None,
            },
        )
        .await
        .unwrap();
    let latest = wallet
        .create_codes(
            actor,
            &CreateCodesRequest {
                count: 1,
                credits: 1,
                max_uses: 1,
                expires_at: None,
            },
        )
        .await
        .unwrap();
    let first = wallet.codes(None).await.unwrap();
    assert_eq!(first.len(), 50);
    assert_eq!(
        first[0].id, latest.codes[0].id,
        "newly issued codes must appear first, independently of random UUID ordering"
    );
    let rest = wallet.codes(Some(first.last().unwrap().id)).await.unwrap();
    let total = first.len() + rest.len();
    let ids: std::collections::HashSet<_> = first
        .iter()
        .chain(rest.iter())
        .map(|item| item.id)
        .collect();
    assert_eq!(ids.len(), total, "no duplicate code across cursor pages");
    let stored_count: i64 = sqlx::query_scalar("SELECT count(*) FROM redeem_codes")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(total as i64, stored_count);
}

#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL; run explicitly"]
async fn checkin_uses_database_local_day_and_streak_settings(pool: PgPool) {
    let owner = user(&pool).await;
    let wallet = recoverable_wallet(pool.clone());
    sqlx::query("UPDATE system_settings SET value='\"Pacific/Kiritimati\"' WHERE key='checkin_tz'")
        .execute(&pool)
        .await
        .unwrap();
    let date: chrono::NaiveDate =
        sqlx::query_scalar("SELECT (now() AT TIME ZONE 'Pacific/Kiritimati')::date")
            .fetch_one(&pool)
            .await
            .unwrap();
    sqlx::query("INSERT INTO checkins(user_id,local_date,streak,credits) VALUES($1,$2,20,20)")
        .bind(owner)
        .bind(date.pred_opt().unwrap())
        .execute(&pool)
        .await
        .unwrap();
    let result = wallet.checkin(owner).await.unwrap();
    assert_eq!(
        (result.local_date, result.streak, result.credits),
        (date, 21, 20)
    );
    assert!(wallet.checkin(owner).await.unwrap().already_checked_in);
    let broken = user(&pool).await;
    sqlx::query("INSERT INTO checkins(user_id,local_date,streak,credits) VALUES($1,$2,20,20)")
        .bind(broken)
        .bind(date.pred_opt().unwrap().pred_opt().unwrap())
        .execute(&pool)
        .await
        .unwrap();
    let result = wallet.checkin(broken).await.unwrap();
    assert_eq!((result.streak, result.credits), (1, 10));
    assert!(wallet.reconcile().await.unwrap().is_empty());
}

#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL; run explicitly"]
async fn different_jobs_cannot_spend_each_others_holds_and_cancel_race_is_safe(pool: PgPool) {
    let owner = user(&pool).await;
    let wallet = recoverable_wallet(pool.clone());
    wallet.grant(owner, 100, "fund").await.unwrap();
    let a = Uuid::new_v4();
    let b = Uuid::new_v4();
    wallet.hold(owner, a, 40).await.unwrap();
    wallet.hold(owner, b, 40).await.unwrap();
    assert!(wallet.settle(owner, a, 0, 41).await.is_err());
    let (settle, release) =
        tokio::join!(wallet.settle(owner, a, 0, 40), wallet.release(owner, a, 40));
    assert_eq!(
        usize::from(settle.is_ok()) + usize::from(release.is_ok()),
        1
    );
    assert_eq!(wallet.summary(owner).await.unwrap().held, 40);
    assert!(wallet.reconcile().await.unwrap().is_empty());
}

#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL; run explicitly"]
async fn hundred_retries_hold_once_conflict_and_insufficient_rollback(pool: PgPool) {
    let owner = user(&pool).await;
    let wallet = recoverable_wallet(pool.clone());
    wallet.grant(owner, 100, "test:grant").await.unwrap();
    let job = Uuid::new_v4();
    let mut tasks = Vec::new();
    for _ in 0..100 {
        let wallet = wallet.clone();
        tasks.push(tokio::spawn(async move {
            wallet.hold(owner, job, 40).await.unwrap()
        }));
    }
    for task in tasks {
        task.await.unwrap();
    }
    let view = wallet.summary(owner).await.unwrap();
    assert_eq!((view.balance, view.held, view.available), (100, 40, 60));
    assert!(matches!(
        wallet.hold(owner, job, 41).await,
        Err(WalletError::Conflict)
    ));
    assert!(matches!(
        wallet.hold(owner, Uuid::new_v4(), 61).await,
        Err(WalletError::Insufficient)
    ));
    assert_eq!(wallet.ledger(owner, None, 50).await.unwrap().items.len(), 2);
    let mut settlements = Vec::new();
    for _ in 0..100 {
        let wallet = wallet.clone();
        settlements.push(tokio::spawn(async move {
            wallet.settle(owner, job, 0, 10).await.unwrap()
        }));
    }
    for result in settlements {
        result.await.unwrap();
    }
    wallet.release(owner, job, 30).await.unwrap();
    let ledger = wallet.ledger(owner, None, 50).await.unwrap();
    let job_id = job.to_string();
    let related: Vec<_> = ledger
        .items
        .iter()
        .filter(|entry| entry.ref_id.as_deref() == Some(job_id.as_str()))
        .collect();
    assert_eq!(related.len(), 3);
    assert!(related
        .iter()
        .all(|entry| entry.ref_type.as_deref() == Some("job")));
    assert_eq!(
        related.iter().map(|entry| entry.balance_delta).sum::<i64>(),
        -10
    );
    assert_eq!(related.iter().map(|entry| entry.held_delta).sum::<i64>(), 0);
    let other = user(&pool).await;
    assert!(wallet
        .ledger(other, None, 50)
        .await
        .unwrap()
        .items
        .is_empty());
    assert!(wallet.settle(owner, job, 1, 1).await.is_err());
    assert!(wallet.release(owner, job, 30).await.is_ok());
    assert!(wallet.reconcile().await.unwrap().is_empty());
    let view = wallet.summary(owner).await.unwrap();
    assert_eq!((view.balance, view.held), (90, 0));
    // A caller can include other business writes in the very same transaction.
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("INSERT INTO audit_logs(actor_id,action) VALUES($1,'TEST_ATOMIC_HOLD')")
        .bind(owner)
        .execute(&mut *tx)
        .await
        .unwrap();
    assert!(matches!(
        WalletService::apply_in_transaction(
            &mut tx,
            owner,
            Operation::Hold {
                job: Uuid::new_v4(),
                amount: 91
            }
        )
        .await,
        Err(WalletError::Insufficient)
    ));
    tx.rollback().await.unwrap();
    let events: i64 =
        sqlx::query_scalar("SELECT count(*) FROM audit_logs WHERE action='TEST_ATOMIC_HOLD'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(events, 0);
}

#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL; run explicitly"]
async fn ledger_foreign_keys_work_after_runtime_restriction(pool: PgPool) {
    let bypasses_permissions: bool =
        sqlx::query_scalar("SELECT rolsuper FROM pg_roles WHERE rolname=current_user")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(
        !bypasses_permissions,
        "Run permission regressions as a non-superuser database owner"
    );
    let owner = user(&pool).await;
    let wallet = recoverable_wallet(pool.clone());
    wallet.restrict_ledger().await.unwrap();
    wallet.restrict_ledger().await.unwrap();
    let broad_update: bool =
        sqlx::query_scalar("SELECT has_table_privilege(current_user,'credit_ledger','UPDATE')")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(!broad_update);

    // Run the real startup policy before granting credits: the lots FK must be
    // able to lock the referenced immutable ledger row as the owning role.
    assert!(!wallet.checkin(owner).await.unwrap().already_checked_in);
    assert!(wallet.checkin(owner).await.unwrap().already_checked_in);
    wallet.grant(owner, 5, "restricted:grant").await.unwrap();
    let codes = wallet
        .create_codes(
            owner,
            &CreateCodesRequest {
                count: 1,
                credits: 7,
                max_uses: 1,
                expires_at: None,
            },
        )
        .await
        .unwrap();
    wallet
        .redeem(owner, Uuid::new_v4(), &codes.codes[0].code)
        .await
        .unwrap();

    let update_id = sqlx::query("UPDATE credit_ledger SET id=id WHERE user_id=$1")
        .bind(owner)
        .execute(&pool)
        .await
        .unwrap_err();
    assert_eq!(
        update_id.as_database_error().unwrap().message(),
        "credit ledger is append only"
    );
    for statement in [
        "UPDATE credit_ledger SET balance_delta=999",
        "DELETE FROM credit_ledger",
        "TRUNCATE credit_ledger",
    ] {
        let failure = sqlx::query(statement).execute(&pool).await.unwrap_err();
        assert_eq!(
            failure.as_database_error().unwrap().code().as_deref(),
            Some("42501")
        );
    }
    let missing = sqlx::query(
        "INSERT INTO wallet_credit_lots(user_id,ledger_id,credits,remaining) VALUES($1,-1,1,1)",
    )
    .bind(owner)
    .execute(&pool)
    .await
    .unwrap_err();
    assert_eq!(
        missing.as_database_error().unwrap().code().as_deref(),
        Some("23503")
    );
    assert_eq!(wallet.summary(owner).await.unwrap().balance, 22);
    assert_eq!(
        wallet.ledger(owner, None, 100).await.unwrap().items.len(),
        3
    );
    assert!(wallet.reconcile().await.unwrap().is_empty());
}

#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL; run explicitly"]
async fn concurrent_checkin_is_once_and_ledger_is_immutable(pool: PgPool) {
    let owner = user(&pool).await;
    let wallet = recoverable_wallet(pool.clone());
    wallet.restrict_ledger().await.unwrap();
    let mut tasks = Vec::new();
    for _ in 0..100 {
        let wallet = wallet.clone();
        tasks.push(tokio::spawn(
            async move { wallet.checkin(owner).await.unwrap() },
        ));
    }
    let mut awarded = 0;
    for task in tasks {
        awarded += usize::from(!task.await.unwrap().already_checked_in);
    }
    assert_eq!(awarded, 1);
    assert_eq!(wallet.summary(owner).await.unwrap().balance, 10);
    for sql in [
        "UPDATE credit_ledger SET balance_delta=999",
        "DELETE FROM credit_ledger",
        "TRUNCATE credit_ledger",
    ] {
        assert!(sqlx::query(sql).execute(&pool).await.is_err());
    }
    // Detect corruption of both balance and held in one consistent snapshot.
    sqlx::query("UPDATE wallets SET balance=11 WHERE user_id=$1")
        .bind(owner)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(wallet.reconcile().await.unwrap(), vec![owner]);
}

#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL; run explicitly"]
async fn adjustment_audit_atomic_and_cross_user_key_conflicts(pool: PgPool) {
    let owner = user(&pool).await;
    let actor = user(&pool).await;
    let wallet = recoverable_wallet(pool.clone());
    let request = Uuid::new_v4();
    wallet
        .adjust(actor, owner, request, 30, "support credit")
        .await
        .unwrap();
    wallet
        .adjust(actor, owner, request, 30, "support credit")
        .await
        .unwrap();
    assert!(matches!(
        wallet
            .adjust(actor, actor, request, 30, "support credit")
            .await,
        Err(WalletError::Conflict)
    ));
    assert!(wallet
        .adjust(actor, owner, Uuid::new_v4(), -31, "too much")
        .await
        .is_err());
    assert!(wallet
        .adjust(actor, owner, Uuid::new_v4(), 1, " ")
        .await
        .is_err());
    sqlx::query("ALTER TABLE audit_logs ADD CONSTRAINT reject_adjust CHECK(action <> 'WALLET_ADJUST') NOT VALID").execute(&pool).await.unwrap();
    assert!(wallet
        .adjust(actor, owner, Uuid::new_v4(), 10, "audit fails")
        .await
        .is_err());
    assert_eq!(wallet.summary(owner).await.unwrap().balance, 30);
    assert!(wallet.reconcile().await.unwrap().is_empty());
    // Generic operation is validated even before contacting the database.
    let recent = wallet.adjustments().await.unwrap();
    assert_eq!(
        recent.len(),
        1,
        "idempotent retries must not duplicate recent records"
    );
    assert_eq!(recent[0].user_id, owner.to_string());
    assert_eq!(recent[0].amount, 30);
    assert_eq!(recent[0].reason, "support credit");
    assert!(wallet
        .apply(
            owner,
            Operation::Hold {
                job: Uuid::new_v4(),
                amount: 0
            }
        )
        .await
        .is_err());
}
