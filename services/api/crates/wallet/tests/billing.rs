use atelier_wallet::*;
use sqlx::PgPool;
use uuid::Uuid;

async fn user(db: &PgPool) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO users(id,google_sub,email,canonical_email,display_name) VALUES($1,$2,$2,$2,'Billing')")
        .bind(id).bind(format!("{id}@gmail.com")).execute(db).await.unwrap();
    sqlx::query("INSERT INTO wallets(user_id) VALUES($1)")
        .bind(id)
        .execute(db)
        .await
        .unwrap();
    id
}
fn plan(kind: &str) -> PlanInput {
    PlanInput {
        name: "Studio".into(),
        kind: kind.into(),
        description: "联系管理员并提供订单号，线下付款后确认。".into(),
        price_cents: 1000,
        currency: "CNY".into(),
        credits: 100,
        period_days: if kind == "MONTHLY" { Some(30) } else { None },
        rollover: false,
        concurrency_limit: 3,
        max_resolution: "4K".into(),
        retention_days: 180,
        active: true,
    }
}
fn paid(trade: &str) -> PaidInput {
    PaidInput {
        amount_cents: 1000,
        currency: "CNY".into(),
        trade_no: trade.into(),
        reason: "已核对线下收款".into(),
    }
}
#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL"]
async fn manual_replays_price_snapshot_trade_uniqueness_and_audit_rollback(db: PgPool) {
    let admin = user(&db).await;
    let owner = user(&db).await;
    let service = BillingService::new(db.clone());
    let p = service.create_plan(admin, &plan("PACK")).await.unwrap();
    let input = OrderInput {
        plan_id: p.id,
        plan_revision: p.revision,
    };
    let key = Uuid::new_v4();
    let o = service.create_order(owner, key, &input).await.unwrap();
    assert_eq!(
        service.create_order(owner, key, &input).await.unwrap().id,
        o.id
    );
    let mut changed = plan("PACK");
    changed.credits = 999;
    service
        .update_plan(admin, p.id, p.revision, &changed)
        .await
        .unwrap();
    let mut bad = paid("trade-one");
    bad.amount_cents = 1;
    assert!(matches!(
        service.mark_paid(admin, o.id, Uuid::new_v4(), &bad).await,
        Err(BillingError::PaymentMismatch)
    ));
    let mut tasks = vec![];
    for _ in 0..20 {
        let s = service.clone();
        tasks.push(tokio::spawn(async move {
            s.mark_paid(admin, o.id, Uuid::new_v4(), &paid("trade-one"))
                .await
                .unwrap()
        }));
    }
    for task in tasks {
        assert_eq!(task.await.unwrap().status, "FULFILLED");
    }
    assert_eq!(
        WalletService::new(db.clone())
            .summary(owner)
            .await
            .unwrap()
            .balance,
        100
    );
    let p = service.create_plan(admin, &plan("PACK")).await.unwrap();
    let second = service
        .create_order(
            owner,
            Uuid::new_v4(),
            &OrderInput {
                plan_id: p.id,
                plan_revision: p.revision,
            },
        )
        .await
        .unwrap();
    assert!(matches!(
        service
            .mark_paid(admin, second.id, Uuid::new_v4(), &paid("trade-one"))
            .await,
        Err(BillingError::DuplicateTrade)
    ));
    sqlx::query("CREATE FUNCTION fail_billing_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='ORDER_PAID' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$").execute(&db).await.unwrap();
    sqlx::query("CREATE TRIGGER billing_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_billing_audit()").execute(&db).await.unwrap();
    assert!(service
        .mark_paid(admin, second.id, Uuid::new_v4(), &paid("trade-two"))
        .await
        .is_err());
    assert_eq!(
        service.order(owner, second.id, false).await.unwrap().status,
        "PENDING"
    );
    assert_eq!(
        WalletService::new(db.clone())
            .summary(owner)
            .await
            .unwrap()
            .balance,
        100
    );
}
#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL"]
async fn funded_subscription_periods_expire_downgrade_and_never_grant_twice(db: PgPool) {
    let admin = user(&db).await;
    let owner = user(&db).await;
    let s = BillingService::new(db.clone());
    let p = s.create_plan(admin, &plan("MONTHLY")).await.unwrap();
    let a = s
        .create_order(
            owner,
            Uuid::new_v4(),
            &OrderInput {
                plan_id: p.id,
                plan_revision: 1,
            },
        )
        .await
        .unwrap();
    s.mark_paid(admin, a.id, Uuid::new_v4(), &paid("sub-one"))
        .await
        .unwrap();
    assert_eq!(s.entitlements(owner).await.unwrap().tier, "SUBSCRIBER");
    let b = s
        .create_order(
            owner,
            Uuid::new_v4(),
            &OrderInput {
                plan_id: p.id,
                plan_revision: 1,
            },
        )
        .await
        .unwrap();
    s.mark_paid(admin, b.id, Uuid::new_v4(), &paid("sub-two"))
        .await
        .unwrap();
    assert_eq!(
        WalletService::new(db.clone())
            .summary(owner)
            .await
            .unwrap()
            .balance,
        100
    );
    assert_eq!(s.entitlements(owner).await.unwrap().scheduled_periods, 1);
    sqlx::query("UPDATE subscriptions SET starts_at=now()-interval '31 days',current_period_end=now()-interval '1 day' WHERE order_id=$1").bind(a.id).execute(&db).await.unwrap();
    sqlx::query("UPDATE subscriptions SET starts_at=now()-interval '1 minute',current_period_end=now()+interval '29 days' WHERE order_id=$1").bind(b.id).execute(&db).await.unwrap();
    s.maintain().await.unwrap();
    s.maintain().await.unwrap();
    assert_eq!(
        WalletService::new(db.clone())
            .summary(owner)
            .await
            .unwrap()
            .balance,
        100
    );
    sqlx::query("UPDATE subscriptions SET starts_at=now()-interval '31 days',current_period_end=now()-interval '1 day' WHERE order_id=$1").bind(b.id).execute(&db).await.unwrap();
    assert_eq!(s.entitlements(owner).await.unwrap().tier, "FREE");
    assert_eq!(
        WalletService::new(db.clone())
            .summary(owner)
            .await
            .unwrap()
            .balance,
        0
    );
    assert!(WalletService::new(db).reconcile().await.unwrap().is_empty());
}
#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL"]
async fn proportional_refund_uses_fifo_remaining_lot_and_rejects_held_credits(db: PgPool) {
    let admin = user(&db).await;
    let owner = user(&db).await;
    let s = BillingService::new(db.clone());
    let p = s.create_plan(admin, &plan("PACK")).await.unwrap();
    let order = s
        .create_order(
            owner,
            Uuid::new_v4(),
            &OrderInput {
                plan_id: p.id,
                plan_revision: 1,
            },
        )
        .await
        .unwrap();
    s.mark_paid(admin, order.id, Uuid::new_v4(), &paid("refund-one"))
        .await
        .unwrap();
    let wallet = WalletService::new(db.clone());
    let job = Uuid::new_v4();
    wallet.hold(owner, job, 40).await.unwrap();
    assert!(matches!(
        s.refund(
            admin,
            order.id,
            Uuid::new_v4(),
            &RefundInput {
                expected_credits: 100,
                confirm_external_refund: true,
                reason: "已线下退款".into()
            }
        )
        .await,
        Err(BillingError::CreditsHeld)
    ));
    wallet.settle(owner, job, 0, 40).await.unwrap();
    let quote = s.refund_quote(order.id).await.unwrap();
    assert_eq!(quote.refundable_credits, 60);
    assert_eq!(quote.refund_cents, 600);
    let key = Uuid::new_v4();
    let input = RefundInput {
        expected_credits: 60,
        confirm_external_refund: true,
        reason: "已线下退还未使用部分".into(),
    };
    let r = s.refund(admin, order.id, key, &input).await.unwrap();
    assert_eq!(r.recovered_credits, 60);
    s.refund(admin, order.id, key, &input).await.unwrap();
    assert_eq!(wallet.summary(owner).await.unwrap().balance, 0);
    assert!(wallet.reconcile().await.unwrap().is_empty());
}
